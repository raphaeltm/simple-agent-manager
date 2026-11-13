/**
 * Signature checks for signed webhook automations. This is the trust boundary: a closed set of
 * tested functions over the raw request bytes, never configuration, templates or scripts.
 *
 * Adding a scheme is one function here, its tests, one value in
 * `WEBHOOK_SIGNED_VERIFICATION_SCHEMES` and a docs row. The route, storage and UI do not change.
 */
import type { WebhookSignedVerificationScheme } from '@simple-agent-manager/shared';

export type WebhookSignatureResult =
  { ok: true } | { ok: false; reason: 'invalid_signature' | 'stale_timestamp' };

export interface WebhookSignatureInput {
  /** The provider's signing secret, used as a UTF-8 string. */
  secret: string;
  /** Request body exactly as received, before any decoding or parsing. */
  rawBody: Uint8Array;
  headers: Headers;
  nowMs: number;
  /** Allowed clock difference for schemes that sign a timestamp. */
  toleranceSeconds: number;
  /** Header carrying the MAC, for schemes where the sender chooses it. */
  signatureHeader?: string | null;
}

const INVALID: WebhookSignatureResult = { ok: false, reason: 'invalid_signature' };
const SHA256_BYTES = 32;

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function base64ToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  try {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * `crypto.subtle.verify` compares in constant time, so the provided MAC is decoded to bytes and
 * handed to it rather than compared as a string.
 */
async function macMatches(secret: string, message: Uint8Array, mac: Uint8Array): Promise<boolean> {
  if (mac.byteLength !== SHA256_BYTES) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  return crypto.subtle.verify('HMAC', key, mac, message);
}

function concat(prefix: Uint8Array, body: Uint8Array): Uint8Array {
  const joined = new Uint8Array(prefix.byteLength + body.byteLength);
  joined.set(prefix, 0);
  joined.set(body, prefix.byteLength);
  return joined;
}

/**
 * Slack: `X-Slack-Signature: v0=<hex>` over `v0:{X-Slack-Request-Timestamp}:{raw body}`.
 * https://docs.slack.dev/authentication/verifying-requests-from-slack
 *
 * The MAC is checked before the timestamp's age, so only a holder of the secret can learn that
 * a request was stale; everyone else sees `invalid_signature`.
 */
async function verifySlackV0(input: WebhookSignatureInput): Promise<WebhookSignatureResult> {
  const timestamp = input.headers.get('x-slack-request-timestamp')?.trim() ?? '';
  const signature = input.headers.get('x-slack-signature')?.trim() ?? '';
  if (!/^\d{1,12}$/.test(timestamp) || !signature.startsWith('v0=')) return INVALID;
  const mac = hexToBytes(signature.slice(3));
  if (!mac) return INVALID;
  const message = concat(new TextEncoder().encode(`v0:${timestamp}:`), input.rawBody);
  if (!(await macMatches(input.secret, message, mac))) return INVALID;
  const ageSeconds = Math.abs(input.nowMs / 1000 - Number(timestamp));
  return ageSeconds <= input.toleranceSeconds
    ? { ok: true }
    : { ok: false, reason: 'stale_timestamp' };
}

/**
 * HMAC-SHA256 of the raw body in a header the sender names (GitHub: `X-Hub-Signature-256`).
 * Hex and base64 are both accepted, with or without a `sha256=` prefix. A 64-character hex MAC
 * is also valid base64, so hex is tried first and base64 only when the value is not hex.
 */
async function verifyHmacSha256Body(input: WebhookSignatureInput): Promise<WebhookSignatureResult> {
  if (!input.signatureHeader) return INVALID;
  const provided = input.headers.get(input.signatureHeader)?.trim() ?? '';
  const value = provided.replace(/^sha256=/i, '');
  if (!value) return INVALID;
  const mac = hexToBytes(value) ?? base64ToBytes(value);
  if (!mac) return INVALID;
  return (await macMatches(input.secret, input.rawBody, mac)) ? { ok: true } : INVALID;
}

const VERIFIERS: Record<
  WebhookSignedVerificationScheme,
  (input: WebhookSignatureInput) => Promise<WebhookSignatureResult>
> = {
  slack_v0: verifySlackV0,
  hmac_sha256_body: verifyHmacSha256Body,
};

export function verifyWebhookSignature(
  scheme: WebhookSignedVerificationScheme,
  input: WebhookSignatureInput
): Promise<WebhookSignatureResult> {
  return VERIFIERS[scheme](input);
}
