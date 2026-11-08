/**
 * `selectSyncTarget`: which seeded credential a synced auth file is written into.
 * A missing Codex account id is only acceptable when there is a single candidate;
 * with several it is ambiguous, never a wildcard.
 */
import { describe, expect, it } from 'vitest';

import {
  isStaleCodexSync,
  selectSyncTarget,
} from '../../../src/routes/workspaces/agent-credential-sync';
import type { RunAgentCredential } from '../../../src/services/run-agent-credential';

const auth = (accountId?: string) =>
  JSON.stringify({
    tokens: { refresh_token: 'rt', ...(accountId ? { account_id: accountId } : {}) },
  });

const candidate = (id: string, accountId?: string) => ({
  credential: { reference: `cc_credentials:${id}`, id } as RunAgentCredential,
  plaintext: auth(accountId),
});

const pick = (
  synced: string,
  candidates: ReturnType<typeof candidate>[],
  agent = 'openai-codex'
) => {
  const result = selectSyncTarget(agent, synced, candidates);
  return result.ok ? result.candidate.credential.id : result.reason;
};

describe('selectSyncTarget', () => {
  it.each([
    { name: 'same account', synced: 'acct-a', stored: 'acct-a', expected: 'one' },
    { name: 'stored has no account id', synced: 'acct-a', stored: undefined, expected: 'one' },
    {
      name: 'synced has no account id while the stored one does',
      synced: undefined,
      stored: 'acct-a',
      expected: 'credential_account_unverified',
    },
    {
      name: 'different account',
      synced: 'acct-b',
      stored: 'acct-a',
      expected: 'credential_account_mismatch',
    },
  ])('single candidate: $name', ({ synced, stored, expected }) => {
    expect(pick(auth(synced), [candidate('one', stored)])).toBe(expected);
  });

  it('several candidates: picks the one whose account matches', () => {
    expect(pick(auth('acct-b'), [candidate('a', 'acct-a'), candidate('b', 'acct-b')])).toBe('b');
  });

  it('several candidates: two stored copies of the same account are ambiguous', () => {
    expect(pick(auth('acct-a'), [candidate('new', 'acct-a'), candidate('old', 'acct-a')])).toBe(
      'credential_ambiguous'
    );
  });

  it.each([
    { name: 'not JSON', synced: 'not-json{' },
    { name: 'JSON without tokens', synced: JSON.stringify({ hello: 'world' }) },
    {
      name: 'tokens without a refresh token',
      synced: JSON.stringify({ tokens: { access_token: 'x' } }),
    },
  ])('Codex: a synced file that is $name is refused', ({ synced }) => {
    expect(pick(synced, [candidate('one', 'acct-a')])).toBe('credential_invalid');
  });

  it('several candidates: a matching account beats a candidate with no account id', () => {
    expect(pick(auth('acct-b'), [candidate('unknown'), candidate('b', 'acct-b')])).toBe('b');
  });

  it('several candidates: a candidate with no account id is not a wildcard', () => {
    expect(pick(auth('acct-c'), [candidate('unknown'), candidate('b', 'acct-b')])).toBe(
      'credential_ambiguous'
    );
  });

  it('several candidates: a synced file with no account id is ambiguous', () => {
    expect(pick(auth(), [candidate('a', 'acct-a'), candidate('b', 'acct-b')])).toBe(
      'credential_ambiguous'
    );
  });

  it('several candidates, all of other accounts: mismatch', () => {
    expect(pick(auth('acct-c'), [candidate('a', 'acct-a'), candidate('b', 'acct-b')])).toBe(
      'credential_account_mismatch'
    );
  });

  it('non-Codex agents need exactly one candidate', () => {
    expect(pick('key', [candidate('one')], 'claude-code')).toBe('one');
    expect(pick('key', [candidate('a'), candidate('b')], 'claude-code')).toBe(
      'credential_ambiguous'
    );
  });

  it('the chosen target is refused when the synced file is an older generation', () => {
    const stored = JSON.stringify({
      tokens: { refresh_token: 'rt-2', access_token: jwt({ iat: 2 }), account_id: 'acct-a' },
    });
    const older = JSON.stringify({
      tokens: { refresh_token: 'rt-1', access_token: jwt({ iat: 1 }), account_id: 'acct-a' },
    });
    const result = selectSyncTarget('openai-codex', older, [
      {
        credential: { reference: 'cc_credentials:a', id: 'a' } as RunAgentCredential,
        plaintext: stored,
      },
    ]);
    expect(result).toEqual({ ok: false, reason: 'credential_stale' });
  });
});

const jwt = (claims: Record<string, unknown>) =>
  `${['{"alg":"none"}', JSON.stringify(claims)]
    .map((part) => Buffer.from(part).toString('base64url'))
    .join('.')}.sig`;

describe('isStaleCodexSync', () => {
  const identity = (refreshToken: string, access?: string, id?: string) => ({
    refreshToken,
    accessToken: access,
    idToken: id,
  });

  it.each([
    {
      name: 'same refresh token, older access token',
      synced: identity('rt', jwt({ iat: 1 })),
      stored: identity('rt', jwt({ iat: 2 })),
      stale: false,
    },
    {
      name: 'different refresh token, newer access token (a direct refresh)',
      synced: identity('rt-3', jwt({ iat: 3 })),
      stored: identity('rt-2', jwt({ iat: 2 })),
      stale: false,
    },
    {
      name: 'different refresh token, older access token',
      synced: identity('rt-1', jwt({ iat: 1 })),
      stored: identity('rt-2', jwt({ iat: 2 })),
      stale: true,
    },
    {
      name: 'different refresh token, the stored access token (the proxy stale path)',
      synced: identity('rt-1', jwt({ iat: 2 })),
      stored: identity('rt-2', jwt({ iat: 2 })),
      stale: true,
    },
    {
      name: 'different refresh token, no issue time on either side (fails closed)',
      synced: identity('rt-1', 'opaque'),
      stored: identity('rt-2', 'opaque'),
      stale: true,
    },
    {
      name: 'different refresh token, newer id token when the access token is opaque',
      synced: identity('rt-3', 'opaque', jwt({ iat: 3 })),
      stored: identity('rt-2', 'opaque', jwt({ iat: 2 })),
      stale: false,
    },
    {
      name: 'stored file has no refresh token',
      synced: identity('rt-1', jwt({ iat: 1 })),
      stored: { accessToken: jwt({ iat: 2 }) },
      stale: false,
    },
  ])('$name → stale: $stale', ({ synced, stored, stale }) => {
    expect(isStaleCodexSync(synced, stored)).toBe(stale);
  });
});
