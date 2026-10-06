/**
 * DO roundtrip-budget tests for the ProjectData stub resolver.
 *
 * `getStub()` used to `await stub.ensureProjectId(projectId)` before *every*
 * logical DO operation, so each operation cost two Durable Object roundtrips.
 * These tests count the RPCs a fake `PROJECT_DATA` namespace receives and assert
 * the ensure happens once per (isolate, DO) instead.
 *
 * Discriminating: every "ensure count" assertion below fails against the pre-fix
 * `getStub` (which issues one ensure per call).
 *
 * See: .claude/rules/60-request-io-and-bundle-budgets.md
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import * as svc from '../../../src/services/project-data';
import {
  DEFAULT_PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES,
  getProjectDataEnsureMemoMaxEntries,
  projectDataEnsureMemoSize,
  resetProjectDataEnsureMemo,
} from '../../../src/services/project-data-ensure-memo';

interface StubCounters {
  ensure: number;
  method: number;
  ensuredWith: string[];
}

/**
 * Build a fake PROJECT_DATA namespace whose DO ids are deterministic per project
 * name — matching `idFromName` semantics, which is what the memo keys on.
 */
function makeEnv(options: { failMethod?: () => boolean } = {}): {
  env: Env;
  counters: Map<string, StubCounters>;
  totals: StubCounters;
} {
  const counters = new Map<string, StubCounters>();
  const totals: StubCounters = { ensure: 0, method: 0, ensuredWith: [] };

  const countersFor = (key: string): StubCounters => {
    let entry = counters.get(key);
    if (!entry) {
      entry = { ensure: 0, method: 0, ensuredWith: [] };
      counters.set(key, entry);
    }
    return entry;
  };

  const namespace = {
    idFromName: (name: string) => ({
      // Deterministic per name, distinct from the name itself — a DO id is a
      // hex digest, never the original name.
      toString: () => `doid-${name}`,
    }),
    get: (id: { toString(): string }) => {
      const key = id.toString();
      const entry = countersFor(key);
      return {
        ensureProjectId: (projectId: string) => {
          entry.ensure += 1;
          entry.ensuredWith.push(projectId);
          totals.ensure += 1;
          totals.ensuredWith.push(projectId);
          return Promise.resolve();
        },
        getSummary: () => {
          entry.method += 1;
          totals.method += 1;
          if (options.failMethod?.()) {
            return Promise.reject(new Error('Durable Object reset because its code was updated'));
          }
          return Promise.resolve({ lastActivityAt: '', activeSessionCount: 0 });
        },
        // Retry-wrapped path — this is where memo eviction on failure happens.
        linkSessionToWorkspace: () => {
          entry.method += 1;
          totals.method += 1;
          if (options.failMethod?.()) {
            return Promise.reject(new Error('Durable Object reset because its code was updated'));
          }
          return Promise.resolve();
        },
      };
    },
  };

  return {
    env: { PROJECT_DATA: namespace } as unknown as Env,
    counters,
    totals,
  };
}

beforeEach(() => {
  resetProjectDataEnsureMemo();
});

describe('ProjectData ensure memo — DO roundtrip budget', () => {
  it('ensures once and then costs one roundtrip per logical operation', async () => {
    const { env, totals } = makeEnv();

    for (let i = 0; i < 5; i++) {
      await svc.getSummary(env, 'proj-1');
    }

    // Pre-fix this was 5 ensures (one per operation) — the discriminating assertion.
    expect(totals.ensure).toBe(1);
    expect(totals.method).toBe(5);
    // 5 logical operations previously cost 10 roundtrips; now 6 (1 ensure + 5 work).
    expect(totals.ensure + totals.method).toBe(6);
  });

  it('still persists the projectId before the very first operation runs', async () => {
    const order: string[] = [];
    const namespace = {
      idFromName: (name: string) => ({ toString: () => `doid-${name}` }),
      get: () => ({
        ensureProjectId: async (projectId: string) => {
          order.push(`ensure:${projectId}`);
        },
        getSummary: async () => {
          order.push('getSummary');
          return { sessionCount: 0 };
        },
      }),
    };
    const env = { PROJECT_DATA: namespace } as unknown as Env;

    await svc.getSummary(env, 'proj-first');

    expect(order).toEqual(['ensure:proj-first', 'getSummary']);
  });

  it('ensures each project separately — the memo is keyed per Durable Object', async () => {
    const { env, totals, counters } = makeEnv();

    await svc.getSummary(env, 'proj-a');
    await svc.getSummary(env, 'proj-b');
    await svc.getSummary(env, 'proj-a');
    await svc.getSummary(env, 'proj-b');

    expect(totals.ensure).toBe(2);
    expect(counters.get('doid-proj-a')?.ensure).toBe(1);
    expect(counters.get('doid-proj-b')?.ensure).toBe(1);
    expect(counters.get('doid-proj-a')?.ensuredWith).toEqual(['proj-a']);
    expect(counters.get('doid-proj-b')?.ensuredWith).toEqual(['proj-b']);
  });

  it('issues a single ensure when concurrent first-callers race', async () => {
    const { env, totals } = makeEnv();

    await Promise.all(Array.from({ length: 8 }, () => svc.getSummary(env, 'proj-race')));

    expect(totals.ensure).toBe(1);
    expect(totals.method).toBe(8);
  });

  it('re-ensures after a failed DO call so a reset DO re-persists its projectId', async () => {
    let shouldFail = true;
    const { env, totals } = makeEnv({ failMethod: () => shouldFail });
    // Keep the retry budget at one attempt so the failure surfaces immediately.
    (env as unknown as { DO_RETRY_MAX_ATTEMPTS?: string }).DO_RETRY_MAX_ATTEMPTS = '1';

    await expect(svc.linkSessionToWorkspace(env, 'proj-reset', 'sess-1', 'ws-1')).rejects.toThrow();
    expect(totals.ensure).toBe(1);

    shouldFail = false;
    await svc.linkSessionToWorkspace(env, 'proj-reset', 'sess-1', 'ws-1');

    // The memo entry was dropped on failure, so the recovery call re-ensured.
    expect(totals.ensure).toBe(2);
  });

  it('does not memoize a rejected ensure', async () => {
    let ensureCalls = 0;
    const namespace = {
      idFromName: (name: string) => ({ toString: () => `doid-${name}` }),
      get: () => ({
        ensureProjectId: async () => {
          ensureCalls += 1;
          if (ensureCalls === 1) throw new Error('boom');
        },
        getSummary: async () => ({ sessionCount: 0 }),
      }),
    };
    const env = { PROJECT_DATA: namespace } as unknown as Env;

    await expect(svc.getSummary(env, 'proj-ensure-fail')).rejects.toThrow('boom');
    await expect(svc.getSummary(env, 'proj-ensure-fail')).resolves.toBeDefined();

    expect(ensureCalls).toBe(2);
  });

  it('bounds memo growth with an env-configurable cap', async () => {
    const { env, totals } = makeEnv();
    (
      env as unknown as { PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES?: string }
    ).PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES = '3';

    for (let i = 0; i < 10; i++) {
      await svc.getSummary(env, `proj-${i}`);
    }

    expect(projectDataEnsureMemoSize()).toBe(3);

    // Behavioral check that does not read the global size counter: a still-cached
    // project must not re-ensure, an evicted one must.
    const ensuresAfterFill = totals.ensure;
    await svc.getSummary(env, 'proj-9'); // most recent — still cached
    expect(totals.ensure).toBe(ensuresAfterFill);
    await svc.getSummary(env, 'proj-0'); // long evicted — must re-ensure
    expect(totals.ensure).toBe(ensuresAfterFill + 1);
  });

  it('keeps a hot project cached under cold-project churn (LRU, not FIFO)', async () => {
    const { env, totals } = makeEnv();
    (
      env as unknown as { PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES?: string }
    ).PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES = '3';

    await svc.getSummary(env, 'hot');
    // Churn cold projects, touching `hot` in between so it stays most-recent.
    for (let i = 0; i < 6; i++) {
      await svc.getSummary(env, `cold-${i}`);
      await svc.getSummary(env, 'hot');
    }

    // Under plain FIFO the hot project would have been evicted and re-ensured.
    expect(totals.ensuredWith.filter((p) => p === 'hot')).toHaveLength(1);
  });
});

describe('getProjectDataEnsureMemoMaxEntries', () => {
  it('falls back to the default when unset or invalid', () => {
    expect(getProjectDataEnsureMemoMaxEntries({})).toBe(
      DEFAULT_PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES
    );
    expect(
      getProjectDataEnsureMemoMaxEntries({ PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES: 'nope' })
    ).toBe(DEFAULT_PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES);
  });

  it('honours a valid override', () => {
    expect(getProjectDataEnsureMemoMaxEntries({ PROJECT_DATA_ENSURE_MEMO_MAX_ENTRIES: '25' })).toBe(
      25
    );
  });
});
