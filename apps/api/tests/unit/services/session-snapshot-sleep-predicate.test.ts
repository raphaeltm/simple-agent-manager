/**
 * The shared "restorable or still sleeping" predicate against a real SQL engine
 * (rule 28). Its in-flight arm mirrors the session-sleep sweep (rule 58): a failed
 * sleep is in flight exactly while `runSessionSleepSweep` will act on it. Inside a
 * bounded sleep-failure episode every failure keeps a due retry until the sweep
 * retries it, falls back, or ends the episode blocked, so a scheduled retry is in
 * flight whatever its attempt count. Only the legacy shape with no retry left is
 * bounded by the SLEEP attempt budget, not the wake budget.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { findRestorableOrInFlightSleepSnapshot } from '../../../src/services/session-snapshot-sleep-predicate';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = new Date('2026-09-25T11:00:00.000Z');

describe('findRestorableOrInFlightSleepSnapshot', () => {
  let sqlite: Database.Database;
  let database: D1Database;

  function seedFailedSleep(overrides: {
    attempts: number;
    status?: string;
    degradation?: string;
    /** `null` is the legacy exhausted shape: failed with no retry scheduled. */
    sleepAfter?: string | null;
  }) {
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, user_id, chat_session_id, runtime, status, degradation,
            manifest_r2_key, expires_at, sleeping_at, sleep_status, sleep_after, sleep_attempts,
            recovery_attempts, created_at, updated_at)
         VALUES ('snapshot-1', 'project-1', 'ws-1', 'user-1', 'chat-1', 'vm', ?, ?,
                 'manifest.json', ?, NULL, 'failed', ?, ?, 0, ?, ?)`
      )
      .run(
        overrides.status ?? 'pending',
        overrides.degradation ?? 'none',
        new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        overrides.sleepAfter === undefined
          ? new Date(NOW.getTime() + 5 * 60 * 1000).toISOString()
          : overrides.sleepAfter,
        overrides.attempts,
        NOW.toISOString(),
        NOW.toISOString()
      );
  }

  function find(env: Partial<Env> = {}) {
    return findRestorableOrInFlightSleepSnapshot(database, env as Env, {
      projectId: 'project-1',
      chatSessionId: 'chat-1',
      now: NOW,
    });
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.sessionSnapshots]);
    database = createSqliteD1(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  it('preserves a clean failed wake through cooldown but never beyond snapshot expiry', async () => {
    seedFailedSleep({ attempts: 0, status: 'available' });
    sqlite
      .prepare(
        `UPDATE session_snapshots SET sleep_status = 'sleeping', sleeping_at = ?,
      recovery_status = 'failed', recovery_failed_at = ?, recovery_attempts = 99,
      recovery_workspace_id = 'replacement'`
      )
      .run(NOW.toISOString(), NOW.toISOString());
    expect(await find()).not.toBeNull();
    expect(
      await findRestorableOrInFlightSleepSnapshot(database, {} as Env, {
        projectId: 'project-1',
        chatSessionId: 'chat-1',
        workspaceId: 'replacement',
        now: NOW,
      })
    ).not.toBeNull();
    sqlite.prepare('UPDATE session_snapshots SET expires_at = ?').run(NOW.toISOString());
    expect(await find()).toBeNull();
  });

  it('keeps a failed sleep in flight while the sweep still has sleep attempts left', async () => {
    // Five failed attempts: past the wake budget (3), inside the sleep budget (9).
    // The sweep retries this row, so every reaper that reads this predicate must
    // leave its runtime alone.
    seedFailedSleep({ attempts: 5 });

    await expect(find()).resolves.toMatchObject({ sleep_status: 'failed' });
  });

  it('keeps a failed sleep with a scheduled retry in flight whatever its attempt count', async () => {
    // The bounded episode guarantees the sweep acts on this row soon: another attempt,
    // the transcript-and-Git fallback, or a blocked end. A destroyer must wait for it.
    seedFailedSleep({ attempts: 9 });

    await expect(find()).resolves.toMatchObject({ sleep_status: 'failed' });
  });

  it('stops holding a legacy failed sleep that has no retry left once the budget is spent', async () => {
    seedFailedSleep({ attempts: 9, sleepAfter: null });

    await expect(find()).resolves.toBeNull();
  });

  it('reads the configured sleep budget, not the wake budget, for a legacy row', async () => {
    seedFailedSleep({ attempts: 5, sleepAfter: null });

    await expect(
      find({ SESSION_SLEEP_MAX_ATTEMPTS: '4', SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS: '10' })
    ).resolves.toBeNull();
    await expect(
      find({ SESSION_SLEEP_MAX_ATTEMPTS: '6', SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS: '1' })
    ).resolves.toMatchObject({ sleep_status: 'failed' });
  });

  it('no longer holds a degraded capture past the budget on its own', async () => {
    // The former "repairable capture" exemption kept a permanently degraded session
    // in flight forever. Without a scheduled retry it is not in flight any more.
    seedFailedSleep({
      attempts: 9,
      status: 'degraded',
      degradation: 'transcript-only',
      sleepAfter: null,
    });

    await expect(find()).resolves.toBeNull();
  });

  it('does not hold a sleep episode that ended blocked', async () => {
    sqlite
      .prepare(
        `INSERT INTO session_snapshots
           (id, project_id, workspace_id, user_id, chat_session_id, runtime, status, degradation,
            manifest_r2_key, expires_at, sleeping_at, sleep_status, sleep_after, sleep_attempts,
            recovery_attempts, sleep_fallback_json, created_at, updated_at)
         VALUES ('snapshot-1', 'project-1', 'ws-1', 'user-1', 'chat-1', 'vm', 'degraded',
                 'transcript-only', 'manifest.json', ?, NULL, 'terminal_failed', NULL, 3, 0,
                 '{"version":1,"outcome":"blocked"}', ?, ?)`
      )
      .run(
        new Date(NOW.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        NOW.toISOString(),
        NOW.toISOString()
      );

    await expect(find()).resolves.toBeNull();
  });
});
