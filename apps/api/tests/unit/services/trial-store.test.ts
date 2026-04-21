/**
 * Unit tests for the trial KV store.
 *
 * Covers:
 *   - writeTrial persists record + two index keys with derived TTL
 *   - readTrial / readTrialByProject / readTrialByFingerprint round-trips
 *   - markTrialClaimed flips claimed=true idempotently
 *   - TTL floor of 60s when expiresAt is in the past
 *   - Malformed JSON in KV → readTrial returns null
 */
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  markTrialClaimed,
  readTrial,
  readTrialByFingerprint,
  readTrialByProject,
  trialByFingerprintKey,
  trialByProjectKey,
  trialKey,
  type TrialRecord,
  writeTrial,
} from '../../../src/services/trial/trial-store';

function makeEnv() {
  const store = new Map<string, { value: string; ttl?: number }>();
  const kv = {
    get: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    put: vi.fn(async (key: string, value: string, opts?: { expirationTtl?: number }) => {
      store.set(key, { value, ttl: opts?.expirationTtl });
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  };
  return {
    env: { KV: kv as unknown as KVNamespace } as unknown as Env,
    kv,
    store,
  };
}

function baseRecord(overrides: Partial<TrialRecord> = {}): TrialRecord {
  return {
    trialId: 'trial_abc',
    projectId: 'proj_xyz',
    fingerprint: 'fp-uuid-1',
    workspaceId: null,
    repoUrl: 'https://github.com/foo/bar',
    createdAt: 1_000_000,
    expiresAt: Date.now() + 60 * 60 * 1000, // 1h from now
    claimed: false,
    ...overrides,
  };
}

describe('trial-store — writeTrial', () => {
  it('writes the record and two index keys', async () => {
    const { env, kv, store } = makeEnv();
    const record = baseRecord();

    await writeTrial(env, record);

    expect(kv.put).toHaveBeenCalledTimes(3);
    expect(store.get(trialKey(record.trialId))!.value).toBe(JSON.stringify(record));
    expect(store.get(trialByProjectKey(record.projectId))!.value).toBe(record.trialId);
    expect(store.get(trialByFingerprintKey(record.fingerprint))!.value).toBe(record.trialId);
  });

  it('sets TTL derived from expiresAt', async () => {
    const { env, store } = makeEnv();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 min
    await writeTrial(env, baseRecord({ expiresAt }));

    const ttl = store.get(trialKey('trial_abc'))!.ttl;
    expect(ttl).toBeGreaterThanOrEqual(60);
    // Within ±5s of 10 min
    expect(Math.abs((ttl ?? 0) - 600)).toBeLessThan(5);
  });

  it('floors TTL at 60 seconds when expiresAt is in the past', async () => {
    const { env, store } = makeEnv();
    await writeTrial(env, baseRecord({ expiresAt: 0 }));
    expect(store.get(trialKey('trial_abc'))!.ttl).toBe(60);
  });
});

describe('trial-store — reads', () => {
  it('readTrial round-trips record via JSON parse', async () => {
    const { env } = makeEnv();
    const record = baseRecord();
    await writeTrial(env, record);

    const recovered = await readTrial(env, record.trialId);
    expect(recovered).toEqual(record);
  });

  it('readTrial returns null when key is absent', async () => {
    const { env } = makeEnv();
    expect(await readTrial(env, 'missing')).toBeNull();
  });

  it('readTrial returns null on malformed JSON', async () => {
    const { env, kv } = makeEnv();
    (kv.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce('{not json');
    expect(await readTrial(env, 'whatever')).toBeNull();
  });

  it('readTrialByProject follows the index key', async () => {
    const { env } = makeEnv();
    const record = baseRecord();
    await writeTrial(env, record);

    const recovered = await readTrialByProject(env, record.projectId);
    expect(recovered?.trialId).toBe(record.trialId);
  });

  it('readTrialByProject returns null when index key missing', async () => {
    const { env } = makeEnv();
    expect(await readTrialByProject(env, 'nope')).toBeNull();
  });

  it('readTrialByFingerprint follows the index key', async () => {
    const { env } = makeEnv();
    const record = baseRecord({ fingerprint: 'fp-other' });
    await writeTrial(env, record);

    const recovered = await readTrialByFingerprint(env, 'fp-other');
    expect(recovered?.trialId).toBe(record.trialId);
  });
});

describe('trial-store — markTrialClaimed', () => {
  it('returns null when the trial does not exist', async () => {
    const { env } = makeEnv();
    expect(await markTrialClaimed(env, 'nope')).toBeNull();
  });

  it('flips claimed=true and rewrites the record', async () => {
    const { env } = makeEnv();
    await writeTrial(env, baseRecord());

    const updated = await markTrialClaimed(env, 'trial_abc');
    expect(updated?.claimed).toBe(true);

    const fromStore = await readTrial(env, 'trial_abc');
    expect(fromStore?.claimed).toBe(true);
  });

  it('is idempotent — calling twice leaves claimed=true', async () => {
    const { env, kv } = makeEnv();
    await writeTrial(env, baseRecord());
    await markTrialClaimed(env, 'trial_abc');

    const callsAfterFirst = (kv.put as ReturnType<typeof vi.fn>).mock.calls.length;
    const updated = await markTrialClaimed(env, 'trial_abc');
    expect(updated?.claimed).toBe(true);
    // Second call short-circuits — no additional writes.
    expect((kv.put as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst);
  });
});
