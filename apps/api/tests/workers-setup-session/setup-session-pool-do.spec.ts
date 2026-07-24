/**
 * Miniflare integration tests for the SetupSessionPool Durable Object
 * (apps/api/src/durable-objects/setup-session-pool.ts) — the atomic
 * concurrency gate for guided Codex credential-setup sandbox sessions.
 *
 * Uses the REAL DO (via `cloudflare:test`'s `env`), not a fake/mock, so the
 * `ctx.storage.transactionSync` read-check-write critical section is
 * exercised against actual Durable Object storage semantics (rule 45: a
 * synchronous-looking JS call stack does not by itself guarantee the
 * underlying SQLite read+write pair is atomic across two concurrent RPC
 * invocations of the same DO instance — only a real DO environment can prove
 * this; a fake in-memory stub cannot, because it has no genuine concurrency
 * to interleave with in the first place).
 *
 * HARNESS NOTE: this file requires the SETUP_SESSION_POOL binding, which is
 * NOT registered in the shared ../vitest.workers.config.ts (see
 * ../vitest.workers-setup-session.config.ts for why). Run with:
 *   cd apps/api && npx vitest run --config tests/vitest.workers-setup-session.config.ts
 *
 * Rule 45 compliance note: the discriminating verification step ("confirm
 * this test goes red when the mutex is bypassed") could NOT be performed for
 * this PR — it would require a temporary edit to src/durable-objects/
 * setup-session-pool.ts, which this test-writing task is scoped to avoid
 * touching, AND this sandbox's `workerd` runtime could not be made to
 * complete a test run at all (see this task's final report). The reasoning
 * for why this test discriminates is documented inline below; a human/CI
 * with a working workerd should perform the bypass-and-confirm-red check
 * once before fully trusting this test.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { SetupSessionPool } from '../../src/durable-objects/setup-session-pool';

function getStub(poolKey: string): DurableObjectStub<SetupSessionPool> {
  const id = env.SETUP_SESSION_POOL.idFromName(poolKey);
  return env.SETUP_SESSION_POOL.get(id) as DurableObjectStub<SetupSessionPool>;
}

// Mirrors the production default: TTL (15m) + buffer (5m) — see
// getPoolLeaseMaxAgeMs in services/credential-setup-config.ts.
const MAX_LEASE_AGE_MS = 20 * 60_000;

describe('SetupSessionPool DO — atomic concurrency lease (rule 45)', () => {
  it('grants exactly one lease when two concurrent requests race for the last slot (cap=1)', async () => {
    // Each test uses its own pool "name" (DO id) to avoid cross-test state
    // leakage — SetupSessionPool is a singleton keyed by a literal string in
    // production ('global'), but nothing stops a test from using a distinct
    // per-test key so tests don't share one DO instance's storage.
    const stub = getStub(`pool-cap1-${Date.now()}`);

    // THE RACE: both requests read "how many active leases exist" and decide
    // to insert in the SAME window. If lease() did not wrap this read+write in
    // one transactionSync (rule 45), both could observe active=0 (< cap) and
    // both would insert — granting 2 leases against a cap of 1. This is
    // exactly the class of bug rule 45 exists to prevent.
    const [resultA, resultB] = await Promise.all([
      stub.lease('session-a', 1, MAX_LEASE_AGE_MS),
      stub.lease('session-b', 1, MAX_LEASE_AGE_MS),
    ]);

    const grantedCount = [resultA, resultB].filter((r) => r.granted).length;
    expect(grantedCount).toBe(1);

    const denied = resultA.granted ? resultB : resultA;
    expect(denied.leaseId).toBeNull();
    expect(denied.cap).toBe(1);

    // Exactly one slot is occupied — not zero (lost the grant), not two
    // (the race was not serialized).
    expect(await stub.getActive()).toBe(1);
  });

  it('grants exactly N leases under a cap of N when 2N concurrent requests race', async () => {
    // A slightly larger fan-out increases confidence beyond a single pair —
    // if the critical section were only "mostly" atomic (e.g. a bug that
    // manifests under 3+-way contention but not 2-way), this would catch it.
    const stub = getStub(`pool-cap2-${Date.now()}`);
    const cap = 2;

    const results = await Promise.all([
      stub.lease('s1', cap, MAX_LEASE_AGE_MS),
      stub.lease('s2', cap, MAX_LEASE_AGE_MS),
      stub.lease('s3', cap, MAX_LEASE_AGE_MS),
      stub.lease('s4', cap, MAX_LEASE_AGE_MS),
    ]);

    const grantedCount = results.filter((r) => r.granted).length;
    expect(grantedCount).toBe(cap);
    expect(await stub.getActive()).toBe(cap);
  });

  it('a third lease at cap is denied (sequential, after the slot is already taken)', async () => {
    const stub = getStub(`pool-seq-${Date.now()}`);
    const first = await stub.lease('session-1', 1, MAX_LEASE_AGE_MS);
    expect(first.granted).toBe(true);

    const second = await stub.lease('session-2', 1, MAX_LEASE_AGE_MS);
    expect(second.granted).toBe(false);
    expect(second.leaseId).toBeNull();
    expect(second.active).toBe(1);
  });

  it('release frees the slot for a subsequent lease', async () => {
    const stub = getStub(`pool-release-${Date.now()}`);
    const first = await stub.lease('session-1', 1, MAX_LEASE_AGE_MS);
    expect(first.granted).toBe(true);
    expect(first.leaseId).not.toBeNull();

    const blocked = await stub.lease('session-2', 1, MAX_LEASE_AGE_MS);
    expect(blocked.granted).toBe(false);

    const releaseResult = await stub.release(first.leaseId!);
    expect(releaseResult.active).toBe(0);

    const afterRelease = await stub.lease('session-2', 1, MAX_LEASE_AGE_MS);
    expect(afterRelease.granted).toBe(true);
    expect(await stub.getActive()).toBe(1);
  });

  it('release is idempotent — releasing an already-released or unknown lease is a safe no-op', async () => {
    const stub = getStub(`pool-idempotent-${Date.now()}`);
    const first = await stub.lease('session-1', 1, MAX_LEASE_AGE_MS);
    await stub.release(first.leaseId!);

    const secondRelease = await stub.release(first.leaseId!);
    expect(secondRelease.active).toBe(0); // does not go negative or throw

    const unknownRelease = await stub.release('lease-id-that-never-existed');
    expect(unknownRelease.active).toBe(0);
  });

  it('prunes a leaked lease older than maxLeaseAgeMs, freeing its slot even at cap (rule 47 escape path)', async () => {
    const stub = getStub(`pool-prune-${Date.now()}`);
    const leaked = await stub.lease('leaked-session', 1, MAX_LEASE_AGE_MS);
    expect(leaked.granted).toBe(true);

    // Let real wall-clock time advance past the leaked lease's created_at so a
    // near-zero maxLeaseAgeMs unambiguously classifies it as stale.
    await new Promise((resolve) => setTimeout(resolve, 5));

    // A fresh lease request at the SAME cap (1), but with maxLeaseAgeMs so
    // small the leaked lease is pruned before the cap check runs — proving
    // the pool cannot be permanently wedged by a session whose DO died
    // without releasing.
    const afterPrune = await stub.lease('fresh-session', 1, 1);
    expect(afterPrune.granted).toBe(true);
    expect(afterPrune.active).toBe(1); // the leaked lease is gone; this is the only slot in use
  });

  it('does not prune a fresh lease that is younger than maxLeaseAgeMs', async () => {
    const stub = getStub(`pool-no-prune-${Date.now()}`);
    const fresh = await stub.lease('fresh-session', 1, MAX_LEASE_AGE_MS);
    expect(fresh.granted).toBe(true);

    // Same generous maxLeaseAgeMs — the fresh lease must NOT be pruned, so a
    // second request at cap is still denied.
    const blocked = await stub.lease('other-session', 1, MAX_LEASE_AGE_MS);
    expect(blocked.granted).toBe(false);
    expect(await stub.getActive()).toBe(1);
  });

  it('cap <= 0 disables the limit entirely', async () => {
    const stub = getStub(`pool-unlimited-${Date.now()}`);
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      const result = await stub.lease(`session-${i}`, 0, MAX_LEASE_AGE_MS);
      expect(result.granted).toBe(true);
    }
    expect(await stub.getActive()).toBe(5);
  });

  it('getActive() reflects state without mutating it', async () => {
    const stub = getStub(`pool-getactive-${Date.now()}`);
    expect(await stub.getActive()).toBe(0);
    await stub.lease('session-1', 5, MAX_LEASE_AGE_MS);
    expect(await stub.getActive()).toBe(1);
    expect(await stub.getActive()).toBe(1); // reading twice does not change count
  });
});
