/**
 * Two-run zombie prevention tests for the guided-setup cron sweep
 * (apps/api/src/scheduled/setup-session-sweep.ts), per rule 47
 * (.claude/rules/47-control-loop-io-budget.md).
 *
 * Exercises the REAL escape-path guarantee end-to-end: an expired active
 * session row with a real pool lease is force-terminalized AND its pool slot
 * is released, so a second sweep run does not re-select it. A non-expired
 * active row (with its own real lease) is the discriminating control that
 * MUST remain untouched by both sweep runs.
 *
 * HARNESS NOTE: requires CREDENTIAL_SETUP_SESSION + SETUP_SESSION_POOL
 * bindings — see ../vitest.workers-setup-session.config.ts. Run with:
 *   cd apps/api && npx vitest run --config tests/vitest.workers-setup-session.config.ts
 */
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import type { SetupSessionPool } from '../../src/durable-objects/setup-session-pool';
import { seedUser } from '../workers/helpers/seed-d1';

const TEST_PREFIX = `sweep-${Date.now()}`;
const USER_ID = `${TEST_PREFIX}-user`;
const POOL_KEY = 'global'; // matches services/setup-session-pool.ts's POOL_KEY

function getPoolStub(): DurableObjectStub<SetupSessionPool> {
  const id = env.SETUP_SESSION_POOL.idFromName(POOL_KEY);
  return env.SETUP_SESSION_POOL.get(id) as DurableObjectStub<SetupSessionPool>;
}

async function seedSetupSession(opts: {
  id: string;
  poolLeaseId: string;
  expiresAt: string;
  status?: string;
}): Promise<void> {
  const nowIso = new Date().toISOString();
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO agent_credential_setup_sessions
     (id, user_id, project_id, scope, agent_type, credential_kind, status, sandbox_id, pool_lease_id, expires_at, created_at, updated_at)
     VALUES (?, ?, NULL, 'user', 'openai-codex', 'oauth-token', ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      opts.id,
      USER_ID,
      opts.status ?? 'waiting_for_user',
      opts.id,
      opts.poolLeaseId,
      opts.expiresAt,
      nowIso,
      nowIso
    )
    .run();
}

async function getSessionStatus(id: string): Promise<{ status: string; error_code: string | null } | null> {
  return env.DATABASE.prepare(
    `SELECT status, error_code FROM agent_credential_setup_sessions WHERE id = ?`
  )
    .bind(id)
    .first<{ status: string; error_code: string | null }>();
}

beforeAll(async () => {
  await seedUser(USER_ID);
});

describe('runSetupSessionSweep — two-run zombie prevention (rule 47)', () => {
  it('force-terminalizes an expired session and releases its pool lease; a non-expired sibling is untouched across two sweep runs', async () => {
    const { runSetupSessionSweep } = await import('../../src/scheduled/setup-session-sweep');
    const pool = getPoolStub();

    const expiredId = `${TEST_PREFIX}-expired`;
    const activeId = `${TEST_PREFIX}-active`;

    const expiredLease = await pool.lease(expiredId, 0, 20 * 60_000); // cap=0 (unlimited) for setup convenience
    const activeLease = await pool.lease(activeId, 0, 20 * 60_000);
    expect(expiredLease.granted).toBe(true);
    expect(activeLease.granted).toBe(true);
    expect(await pool.getActive()).toBe(2);

    // Expired candidate: expires_at in the past, still in an ACTIVE status.
    await seedSetupSession({
      id: expiredId,
      poolLeaseId: expiredLease.leaseId!,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      status: 'waiting_for_user',
    });
    // Discriminating control: expires_at in the FUTURE, same active status —
    // must never be selected by the sweep.
    await seedSetupSession({
      id: activeId,
      poolLeaseId: activeLease.leaseId!,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      status: 'waiting_for_user',
    });

    // --- Sweep run 1 ---
    const firstRun = await runSetupSessionSweep(env as never);
    expect(firstRun.candidates).toBe(1); // only the expired row is selected
    expect(firstRun.errors).toBe(0);

    const expiredAfterFirst = await getSessionStatus(expiredId);
    expect(expiredAfterFirst?.status).toBe('expired');
    expect(expiredAfterFirst?.error_code).toBe('swept');

    const activeAfterFirst = await getSessionStatus(activeId);
    expect(activeAfterFirst?.status).toBe('waiting_for_user'); // untouched

    // The expired row's lease was released; the active row's lease was not.
    expect(await pool.getActive()).toBe(1);

    // --- Sweep run 2 — the zombie-prevention assertion ---
    const secondRun = await runSetupSessionSweep(env as never);
    expect(secondRun.candidates).toBe(0); // the now-terminal row is NOT re-selected

    const expiredAfterSecond = await getSessionStatus(expiredId);
    expect(expiredAfterSecond?.status).toBe('expired'); // unchanged, not re-processed

    const activeAfterSecond = await getSessionStatus(activeId);
    expect(activeAfterSecond?.status).toBe('waiting_for_user'); // still untouched
    expect(await pool.getActive()).toBe(1); // active row's lease still held
  });

  it('is a no-op when there are no expired candidates', async () => {
    const { runSetupSessionSweep } = await import('../../src/scheduled/setup-session-sweep');
    const pool = getPoolStub();
    const onlyActiveId = `${TEST_PREFIX}-only-active`;
    const lease = await pool.lease(onlyActiveId, 0, 20 * 60_000);
    expect(lease.granted).toBe(true);

    await seedSetupSession({
      id: onlyActiveId,
      poolLeaseId: lease.leaseId!,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    });

    const result = await runSetupSessionSweep(env as never);
    expect(result.candidates).toBe(0);
    expect(result.toreDown).toBe(0);
    expect(result.orphansForced).toBe(0);

    const status = await getSessionStatus(onlyActiveId);
    expect(status?.status).toBe('waiting_for_user');
  });

  it('does not select an already-terminal (e.g. completed) row even if its expires_at is in the past', async () => {
    const { runSetupSessionSweep } = await import('../../src/scheduled/setup-session-sweep');
    const pool = getPoolStub();
    const completedId = `${TEST_PREFIX}-already-completed`;
    const lease = await pool.lease(completedId, 0, 20 * 60_000);

    await seedSetupSession({
      id: completedId,
      poolLeaseId: lease.leaseId!,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      status: 'completed', // terminal — NOT in ACTIVE_SETUP_STATUSES
    });

    const result = await runSetupSessionSweep(env as never);
    expect(result.candidates).toBe(0);

    const status = await getSessionStatus(completedId);
    expect(status?.status).toBe('completed'); // unchanged
  });
});
