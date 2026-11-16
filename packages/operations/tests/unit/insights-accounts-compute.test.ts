import { newProviderLimitWait } from '@simple-agent-manager/scheduler-core';
import { describe, expect, it } from 'vitest';

import {
  accountKind,
  type AccountMeta,
  bucketStartOf,
  displayAccount,
  mergeStallEpisodes,
  type StallInterval,
  waitInterval,
  windowInterval,
} from '../../src/insights-accounts-compute';

const MIN = 60_000;
const T0 = 1_794_000_000_000;

function meta(fields: Partial<AccountMeta>): AccountMeta {
  return {
    limitKey: 'cc_credentials:cc-1',
    reference: 'cc_credentials:cc-1',
    source: 'user',
    agentType: 'claude-code',
    kind: 'oauth-token',
    credOwn: 1,
    sessionOwn: 1,
    ownName: 'Personal Max',
    ...fields,
  };
}

function interval(fields: Partial<StallInterval>): StallInterval {
  return {
    limitKey: 'k',
    startMs: T0,
    endMs: T0 + 10 * MIN,
    taskId: null,
    window: null,
    outcome: 'resumed',
    ...fields,
  };
}

describe('displayAccount', () => {
  it('names only the viewer’s own credential', () => {
    expect(displayAccount(meta({}))).toMatchObject({
      key: 'cred:cc-1',
      owner: 'you',
      name: 'Personal Max',
      ownReference: 'cc_credentials:cc-1',
    });
    // Even if a name reached it, another member's credential is grouped and unnamed.
    expect(displayAccount(meta({ credOwn: 0, sessionOwn: 0 }))).toEqual({
      key: 'teammate:claude-code:subscription',
      owner: 'teammate',
      kind: 'subscription',
      agentType: 'claude-code',
      name: null,
      ownReference: null,
    });
  });

  it('keeps project and platform accounts apart from people', () => {
    expect(displayAccount(meta({ source: 'project', credOwn: 0 }))).toMatchObject({
      key: 'project:claude-code:subscription',
      owner: 'project',
      name: null,
    });
    // A project credential the viewer added is still a project account, with its name.
    expect(displayAccount(meta({ source: 'project' }))).toMatchObject({
      key: 'cred:cc-1',
      owner: 'project',
      name: 'Personal Max',
    });
    expect(
      displayAccount(meta({ source: 'platform', limitKey: null, reference: null, credOwn: null }))
    ).toMatchObject({
      key: 'platform:claude-code:platform',
      owner: 'platform',
      kind: 'platform',
    });
  });

  it('files a run with no recorded credential as not recorded', () => {
    expect(displayAccount(meta({ limitKey: null, reference: null, credOwn: null }))).toMatchObject({
      key: 'not_recorded',
      owner: 'not_recorded',
    });
  });

  it('reads the credential id from the raw reference when the key is a digest', () => {
    const long = `cc_credentials:cc-${'x'.repeat(100)}`;
    expect(displayAccount(meta({ limitKey: 'sha256:abc', reference: long })).key).toBe(
      `cred:cc-${'x'.repeat(100)}`
    );
  });

  it('a deleted credential the viewer ran is theirs, kind unknown', () => {
    expect(displayAccount(meta({ credOwn: null, kind: null, ownName: null }))).toMatchObject({
      key: 'you:claude-code:unknown',
      owner: 'you',
      name: null,
    });
  });
});

describe('accountKind', () => {
  it.each([
    ['oauth-token', 'subscription'],
    ['auth-json', 'subscription'],
    ['api-key', 'api_key'],
    ['openai-compatible', 'api_key'],
    ['cloud-provider', 'unknown'],
    [null, 'unknown'],
  ])('%s is %s', (kind, expected) => {
    expect(accountKind({ source: 'user', kind })).toBe(expected);
  });
});

describe('waitInterval', () => {
  const wait = (overrides: Record<string, unknown> = {}) => ({
    ...newProviderLimitWait({
      taskId: 't',
      origin: 'callback',
      incidentId: 'i',
      credentialKey: 'k',
      previous: null,
      now: T0,
      resetsAt: T0 + 30 * MIN,
      jitter: 0,
    }),
    ...overrides,
  });
  const live = { id: 't', terminal: false, endedAtMs: null };

  it('runs from the rejection to the scheduled resume, capped at now', () => {
    const w = wait();
    expect(waitInterval(w, live, T0 + 5 * MIN)).toMatchObject({
      startMs: T0,
      endMs: T0 + 5 * MIN,
      outcome: 'ongoing',
    });
    expect(waitInterval({ ...w, phase: 'released' }, live, T0 + 60 * MIN)).toMatchObject({
      endMs: w.nextRetryAt,
      outcome: 'resumed',
    });
  });

  it('ends when the owner started anyway, or when the run ended first', () => {
    const override = wait({
      phase: 'released',
      ownerOverride: { credentialKey: 'k', grantedAt: T0 + 3 * MIN },
    });
    expect(waitInterval(override, live, T0 + 60 * MIN)?.endMs).toBe(T0 + 3 * MIN);
    const ended = { id: 't', terminal: true, endedAtMs: T0 + 7 * MIN };
    // The run ended before the wait did: it was never resumed.
    expect(waitInterval(wait(), ended, T0 + 60 * MIN)).toMatchObject({
      endMs: T0 + 7 * MIN,
      outcome: 'ended',
    });
    // Control: a run that ended after its wait was resumed first.
    const late = { id: 't', terminal: true, endedAtMs: T0 + 90 * MIN };
    expect(waitInterval({ ...wait(), phase: 'released' }, late, T0 + 120 * MIN)?.outcome).toBe(
      'resumed'
    );
  });

  it('a blocked wait lasts until the run ends, or now', () => {
    const blocked = wait({ phase: 'blocked' });
    expect(waitInterval(blocked, live, T0 + 90 * MIN)).toMatchObject({
      endMs: T0 + 90 * MIN,
      outcome: 'blocked',
    });
    expect(
      waitInterval(blocked, { id: 't', terminal: true, endedAtMs: T0 + 20 * MIN }, T0 + 90 * MIN)
    ).toMatchObject({ endMs: T0 + 20 * MIN, outcome: 'blocked' });
  });

  it('skips a wait with no credential key', () => {
    expect(waitInterval(wait({ credentialKey: null }), live, T0)).toBeNull();
  });
});

describe('windowInterval', () => {
  const row = {
    limitKey: 'k',
    observedAt: T0,
    resetsAt: T0 + 30 * MIN,
    windowMinutes: 300,
    window: '5h',
  };

  it('ends at the reset, or now while it has not reset', () => {
    expect(windowInterval(row, T0 + 60 * MIN)).toMatchObject({
      endMs: T0 + 30 * MIN,
      outcome: 'resumed',
    });
    expect(windowInterval(row, T0 + 10 * MIN)).toMatchObject({
      endMs: T0 + 10 * MIN,
      outcome: 'ongoing',
    });
  });

  it('an unknown reset lasts at most the window, never the whole range', () => {
    const unknown = { ...row, resetsAt: null };
    expect(windowInterval(unknown, T0 + 30 * 24 * 60 * MIN)).toMatchObject({
      endMs: T0 + 300 * MIN,
      outcome: 'resumed',
    });
    expect(windowInterval(unknown, T0 + 10 * MIN).outcome).toBe('ongoing');
    // No reset and no window length: a point, not a stall that runs until now.
    expect(windowInterval({ ...unknown, windowMinutes: null }, T0 + 60 * MIN)).toMatchObject({
      endMs: T0,
      outcome: 'resumed',
    });
  });
});

describe('mergeStallEpisodes', () => {
  it('merges overlapping or touching intervals of one account and counts distinct runs', () => {
    const episodes = mergeStallEpisodes([
      interval({ taskId: 'a' }),
      interval({ taskId: 'b', startMs: T0 + 2 * MIN, endMs: T0 + 12 * MIN }),
      // Within the reset tolerance of the previous end (60 s): same stall.
      interval({
        taskId: 'a',
        startMs: T0 + 12 * MIN + 30_000,
        endMs: T0 + 15 * MIN,
        window: '5h',
      }),
      interval({ startMs: T0 + 60 * MIN, endMs: T0 + 70 * MIN }),
    ]);
    expect(episodes).toEqual([
      expect.objectContaining({ startMs: T0 + 60 * MIN, runs: 0 }),
      expect.objectContaining({ startMs: T0, endMs: T0 + 15 * MIN, runs: 2, windows: ['5h'] }),
    ]);
  });

  it('never merges two accounts', () => {
    expect(mergeStallEpisodes([interval({}), interval({ limitKey: 'other' })])).toHaveLength(2);
  });

  it('a blocked part makes the episode blocked; an ongoing part makes it ongoing', () => {
    const [blocked] = mergeStallEpisodes([
      interval({ outcome: 'ongoing' }),
      interval({ outcome: 'blocked', startMs: T0 + MIN }),
    ]);
    expect(blocked?.outcome).toBe('blocked');
    const [ongoing] = mergeStallEpisodes([
      interval({}),
      interval({ outcome: 'ongoing', startMs: T0 + MIN }),
    ]);
    expect(ongoing?.outcome).toBe('ongoing');
  });
});

describe('bucketStartOf', () => {
  it('days are themselves; weeks start on Monday', () => {
    expect(bucketStartOf('2026-11-12', 'day')).toBe('2026-11-12');
    expect(bucketStartOf('2026-11-12', 'week')).toBe('2026-11-09'); // Thursday → Monday
    expect(bucketStartOf('2026-11-09', 'week')).toBe('2026-11-09');
    expect(bucketStartOf('2026-11-15', 'week')).toBe('2026-11-09'); // Sunday
  });
});
