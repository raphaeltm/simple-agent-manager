import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyWebhookSignature } from '../../../src/services/webhook-signature';
import { SLACK_DOCS_EXAMPLE_SIGNING_VALUE } from '../../helpers/slack-docs-example';

const encoder = new TextEncoder();
const hmac = (secret: string, message: string, encoding: 'hex' | 'base64' = 'hex') =>
  createHmac('sha256', secret).update(message).digest(encoding);

// Slack's documented example: docs.slack.dev/authentication/verifying-requests-from-slack
const SLACK_SECRET = SLACK_DOCS_EXAMPLE_SIGNING_VALUE;
const SLACK_TIMESTAMP = '1531420618';
const SLACK_BODY =
  'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c';
const SLACK_SIGNATURE = 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503';

// GitHub's published test vector:
// docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries#testing-the-webhook-payload-validation
const GITHUB_SECRET = "It's a Secret to Everybody";
const GITHUB_BODY = 'Hello, World!';
const GITHUB_SIGNATURE = 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';

function slack(
  overrides: {
    signature?: string | null;
    timestamp?: string | null;
    body?: string;
    secret?: string;
    nowSeconds?: number;
    toleranceSeconds?: number;
  } = {}
) {
  const headers = new Headers();
  const timestamp = overrides.timestamp === undefined ? SLACK_TIMESTAMP : overrides.timestamp;
  const signature = overrides.signature === undefined ? SLACK_SIGNATURE : overrides.signature;
  if (timestamp !== null) headers.set('X-Slack-Request-Timestamp', timestamp);
  if (signature !== null) headers.set('X-Slack-Signature', signature);
  return verifyWebhookSignature('slack_v0', {
    secret: overrides.secret ?? SLACK_SECRET,
    rawBody: encoder.encode(overrides.body ?? SLACK_BODY),
    headers,
    nowMs: (overrides.nowSeconds ?? Number(SLACK_TIMESTAMP) + 10) * 1000,
    toleranceSeconds: overrides.toleranceSeconds ?? 300,
  });
}

function hmacBody(signature: string | null, body = GITHUB_BODY, header = 'x-hub-signature-256') {
  const headers = new Headers();
  if (signature !== null) headers.set('X-Hub-Signature-256', signature);
  return verifyWebhookSignature('hmac_sha256_body', {
    secret: GITHUB_SECRET,
    rawBody: encoder.encode(body),
    headers,
    nowMs: Date.now(),
    toleranceSeconds: 300,
    signatureHeader: header,
  });
}

describe('slack_v0', () => {
  it("accepts Slack's documented example", async () => {
    expect(await slack()).toEqual({ ok: true });
  });

  it('refuses a missing or malformed signature or timestamp', async () => {
    const invalid = { ok: false, reason: 'invalid_signature' };
    expect(await slack({ signature: null })).toEqual(invalid);
    expect(await slack({ timestamp: null })).toEqual(invalid);
    expect(await slack({ signature: SLACK_SIGNATURE.slice(3) })).toEqual(invalid);
    expect(await slack({ signature: 'v0=nothex' })).toEqual(invalid);
    expect(await slack({ signature: 'v0=' })).toEqual(invalid);
    expect(await slack({ timestamp: 'yesterday' })).toEqual(invalid);
  });

  it('refuses a changed body, a different secret, or a signature for another timestamp', async () => {
    const invalid = { ok: false, reason: 'invalid_signature' };
    expect(await slack({ body: `${SLACK_BODY}&extra=1` })).toEqual(invalid);
    expect(await slack({ secret: 'another-secret-value' })).toEqual(invalid);
    expect(await slack({ timestamp: String(Number(SLACK_TIMESTAMP) + 1) })).toEqual(invalid);
  });

  it('reports a correctly signed request outside the window as stale, in both directions', async () => {
    const stale = { ok: false, reason: 'stale_timestamp' };
    const signedAt = Number(SLACK_TIMESTAMP);
    expect(await slack({ nowSeconds: signedAt + 300 })).toEqual({ ok: true });
    expect(await slack({ nowSeconds: signedAt + 301 })).toEqual(stale);
    expect(await slack({ nowSeconds: signedAt - 301 })).toEqual(stale);
    expect(await slack({ nowSeconds: signedAt + 61, toleranceSeconds: 60 })).toEqual(stale);
  });

  it('tells only a holder of the secret that a request was stale', async () => {
    // A forged request with an old timestamp must look the same as any other forgery.
    expect(
      await slack({ signature: `v0=${'0'.repeat(64)}`, nowSeconds: Number(SLACK_TIMESTAMP) + 9999 })
    ).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('signs the raw bytes, so a re-serialized body does not verify', async () => {
    const body = '{"event":{"text":"h\\u00e9llo"},"event_id":"Ev1"}';
    const signature = `v0=${hmac(SLACK_SECRET, `v0:${SLACK_TIMESTAMP}:${body}`)}`;
    expect(await slack({ body, signature })).toEqual({ ok: true });
    expect(await slack({ body: JSON.stringify(JSON.parse(body)), signature })).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });
});

describe('hmac_sha256_body', () => {
  it("accepts GitHub's published test vector", async () => {
    expect(await hmacBody(GITHUB_SIGNATURE)).toEqual({ ok: true });
  });

  it('accepts hex or base64, with or without the sha256= prefix', async () => {
    const hex = hmac(GITHUB_SECRET, GITHUB_BODY);
    const base64 = hmac(GITHUB_SECRET, GITHUB_BODY, 'base64');
    expect(await hmacBody(hex)).toEqual({ ok: true });
    expect(await hmacBody(hex.toUpperCase())).toEqual({ ok: true });
    expect(await hmacBody(base64)).toEqual({ ok: true });
    expect(await hmacBody(`sha256=${base64}`)).toEqual({ ok: true });
    expect(await hmacBody(base64.replaceAll('+', '-').replaceAll('/', '_'))).toEqual({ ok: true });
  });

  it('refuses a missing, empty, truncated or wrong signature', async () => {
    const invalid = { ok: false, reason: 'invalid_signature' };
    const hex = hmac(GITHUB_SECRET, GITHUB_BODY);
    expect(await hmacBody(null)).toEqual(invalid);
    expect(await hmacBody('')).toEqual(invalid);
    expect(await hmacBody('sha256=')).toEqual(invalid);
    expect(await hmacBody(hex.slice(0, 62))).toEqual(invalid);
    expect(await hmacBody(hmac('wrong secret', GITHUB_BODY))).toEqual(invalid);
    expect(await hmacBody(GITHUB_SIGNATURE, 'Hello, World?')).toEqual(invalid);
    expect(await hmacBody('not a signature at all!')).toEqual(invalid);
  });

  it('reads only the configured header', async () => {
    expect(await hmacBody(GITHUB_SIGNATURE, GITHUB_BODY, 'x-other-signature')).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
    expect(await hmacBody(GITHUB_SIGNATURE, GITHUB_BODY, '')).toEqual({
      ok: false,
      reason: 'invalid_signature',
    });
  });
});
