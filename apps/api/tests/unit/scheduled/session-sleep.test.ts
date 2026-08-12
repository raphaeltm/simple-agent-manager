import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { runSessionSleepSweep } from '../../../src/scheduled/session-sleep';
import { cancelScheduledSessionSleep } from '../../../src/services/session-snapshots';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({ sleepWorkspaceSession: vi.fn() }));

vi.mock('../../../src/services/session-sleep', () => ({
  sleepWorkspaceSession: mocks.sleepWorkspaceSession,
}));

describe('session sleep sweep', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.sessionSnapshots]);
    env = {
      DATABASE: createSqliteD1(sqlite),
      SESSION_SLEEP_SWEEP_BATCH_SIZE: '5',
      SESSION_SLEEP_RETRY_DELAY_MS: '60000',
      SESSION_SLEEP_MAX_ATTEMPTS: '3',
    } as unknown as Env;
  });

  afterEach(() => sqlite.close());

  function addDueSnapshot(id: string, sleepAttempts = 0): void {
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, workspace_id, user_id, chat_session_id, runtime, status, degradation,
            manifest_r2_key, expires_at, sleep_status, sleep_after, sleep_attempts)
         VALUES (?, ?, ?, ?, 'vm', 'available', 'none', ?, ?, 'scheduled', ?, ?)`
      )
      .run(
        id,
        `${id}-workspace`,
        `${id}-user`,
        `${id}-chat`,
        `${id}-manifest`,
        '2026-08-20T00:00:00.000Z',
        '2026-08-12T00:00:00.000Z',
        sleepAttempts
      );
  }

  it('uses a compare-and-swap claim so overlapping sweeps sleep a workspace once', async () => {
    addDueSnapshot('snapshot-once');
    let finishSleep!: () => void;
    mocks.sleepWorkspaceSession.mockImplementation(
      () => new Promise<void>((resolve) => (finishSleep = resolve))
    );
    const now = new Date('2026-08-12T01:00:00.000Z');

    const first = runSessionSleepSweep(env, now);
    await vi.waitFor(() => expect(mocks.sleepWorkspaceSession).toHaveBeenCalledTimes(1));
    const concurrent = await runSessionSleepSweep(env, now);
    finishSleep();
    const winner = await first;

    expect(winner).toMatchObject({ selected: 1, claimed: 1, slept: 1 });
    expect(concurrent).toMatchObject({ selected: 0, claimed: 0, slept: 0 });
    expect(mocks.sleepWorkspaceSession).toHaveBeenCalledTimes(1);
  });

  it('retries fail-closed sleep failures and exhausts the bounded budget', async () => {
    addDueSnapshot('snapshot-retry', 2);
    mocks.sleepWorkspaceSession.mockRejectedValue(new Error('snapshot incomplete'));

    const result = await runSessionSleepSweep(env, new Date('2026-08-12T01:00:00.000Z'));
    const row = sqlite
      .prepare(
        `SELECT sleep_status, sleep_after, sleep_attempts, sleep_error
         FROM session_snapshots WHERE id = 'snapshot-retry'`
      )
      .get() as {
      sleep_status: string;
      sleep_after: string | null;
      sleep_attempts: number;
      sleep_error: string;
    };

    expect(result).toMatchObject({ claimed: 1, slept: 0, failed: 1, exhausted: 1 });
    expect(row).toEqual({
      sleep_status: 'failed',
      sleep_after: null,
      sleep_attempts: 3,
      sleep_error: 'snapshot incomplete',
    });
  });

  it('reclaims a preparing claim after its lease expires', async () => {
    addDueSnapshot('snapshot-stale');
    sqlite
      .prepare(
        `UPDATE session_snapshots
         SET sleep_status = 'preparing', sleep_after = NULL,
             sleep_claim_id = 'dead-owner', sleep_claimed_at = '2026-08-12T00:00:00.000Z'
         WHERE id = 'snapshot-stale'`
      )
      .run();
    mocks.sleepWorkspaceSession.mockResolvedValue(undefined);

    const result = await runSessionSleepSweep(env, new Date('2026-08-12T01:00:00.000Z'));

    expect(result).toMatchObject({ selected: 1, claimed: 1, slept: 1 });
    expect(mocks.sleepWorkspaceSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ workspaceId: 'snapshot-stale-workspace' })
    );
  });

  it('cancels a preparing claim when new prompt activity arrives', async () => {
    addDueSnapshot('snapshot-prompted');
    sqlite
      .prepare(
        `UPDATE session_snapshots
         SET sleep_status = 'preparing', sleep_after = NULL,
             sleep_claim_id = 'sleep-owner', sleep_claimed_at = '2026-08-12T00:59:00.000Z'
         WHERE id = 'snapshot-prompted'`
      )
      .run();
    const db = await import('drizzle-orm/d1').then(({ drizzle }) =>
      drizzle(env.DATABASE, { schema })
    );

    await cancelScheduledSessionSleep(db, 'snapshot-prompted-chat');

    expect(
      sqlite
        .prepare(
          `SELECT sleep_status, sleep_claim_id, sleep_claimed_at
           FROM session_snapshots WHERE id = 'snapshot-prompted'`
        )
        .get()
    ).toEqual({ sleep_status: null, sleep_claim_id: null, sleep_claimed_at: null });
  });

  it('rolls a stale stopping claim forward without consuming another attempt', async () => {
    addDueSnapshot('snapshot-stopping', 2);
    sqlite
      .prepare(
        `UPDATE session_snapshots
         SET sleep_status = 'stopping', sleep_after = '2026-08-12T00:30:00.000Z',
             sleep_claim_id = 'dead-owner', sleep_claimed_at = '2026-08-12T00:00:00.000Z'
         WHERE id = 'snapshot-stopping'`
      )
      .run();
    mocks.sleepWorkspaceSession.mockResolvedValue(undefined);

    const result = await runSessionSleepSweep(env, new Date('2026-08-12T01:00:00.000Z'));

    expect(result).toMatchObject({ selected: 1, claimed: 1, slept: 1 });
    expect(mocks.sleepWorkspaceSession).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        workspaceId: 'snapshot-stopping-workspace',
        sleepClaimId: expect.any(String),
      })
    );
    expect(
      sqlite
        .prepare(`SELECT sleep_attempts FROM session_snapshots WHERE id = 'snapshot-stopping'`)
        .get()
    ).toEqual({ sleep_attempts: 2 });
  });
});
