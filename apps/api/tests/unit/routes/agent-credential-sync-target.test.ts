/**
 * `selectSyncTarget`: which seeded credential a synced auth file is written into.
 * A missing Codex account id is only acceptable when there is a single candidate;
 * with several it is ambiguous, never a wildcard.
 */
import { describe, expect, it } from 'vitest';

import { selectSyncTarget } from '../../../src/routes/workspaces/agent-credential-sync';
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
    { name: 'synced has no account id', synced: undefined, stored: 'acct-a', expected: 'one' },
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

  it('several candidates: the most recently used copy of the same account wins', () => {
    expect(pick(auth('acct-a'), [candidate('new', 'acct-a'), candidate('old', 'acct-a')])).toBe(
      'new'
    );
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
});
