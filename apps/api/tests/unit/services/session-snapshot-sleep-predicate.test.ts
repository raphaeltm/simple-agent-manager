/**
 * Shared sleep predicate against real SQLite. Failed rows remain sweep-owned
 * at any attempt count, while a finite age bound prevents indefinite retention.
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
    /** `null` is the legacy failed shape with no retry scheduled. */
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
    // The sweep retries this row, so reapers must leave its runtime alone.
    seedFailedSleep({ attempts: 5 });

    await expect(find()).resolves.toMatchObject({ sleep_status: 'failed' });
  });

  it('keeps a failed sleep with a scheduled retry in flight whatever its attempt count', async () => {
    // The sweep owns the scheduled retry and any eventual runtime teardown.
    seedFailedSleep({ attempts: 9 });

    await expect(find()).resolves.toMatchObject({ sleep_status: 'failed' });
  });

  it('keeps a legacy failed sleep with no deadline sweep-owned after budget exhaustion', async () => {
    seedFailedSleep({ attempts: 9, sleepAfter: null });

    await expect(find()).resolves.toMatchObject({ sleep_status: 'failed' });
  });

  it('keeps legacy failures sweep-owned independently of sleep and wake attempt budgets', async () => {
    seedFailedSleep({ attempts: 5, sleepAfter: null });

    await expect(
      find({ SESSION_SLEEP_MAX_ATTEMPTS: '4', SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS: '10' })
    ).resolves.toMatchObject({ sleep_status: 'failed' });
    await expect(
      find({ SESSION_SLEEP_MAX_ATTEMPTS: '6', SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS: '1' })
    ).resolves.toMatchObject({ sleep_status: 'failed' });
  });

  it('keeps a recent degraded failed capture sweep-owned beyond the budget', async () => {
    seedFailedSleep({
      attempts: 9,
      status: 'degraded',
      degradation: 'transcript-only',
      sleepAfter: null,
    });

    await expect(find()).resolves.toMatchObject({ sleep_status: 'failed' });
  });

  it('releases an old failed sleep even when the sweep owns its eventual teardown', async () => {
    seedFailedSleep({ attempts: 99, sleepAfter: null });
    sqlite
      .prepare('UPDATE session_snapshots SET updated_at = ?, created_at = ?')
      .run('2026-09-25T10:00:00.000Z', '2026-09-25T10:00:00.000Z');
    await expect(find()).resolves.toBeNull();
  });

  it('uses the configured finite age bound for failed rows without a deadline', async () => {
    seedFailedSleep({ attempts: 99, sleepAfter: null });
    sqlite
      .prepare('UPDATE session_snapshots SET updated_at = ?, created_at = ?')
      .run('2026-09-25T10:50:00.000Z', '2026-09-25T10:50:00.000Z');
    await expect(
      find({ SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS: String(5 * 60 * 1000) })
    ).resolves.toBeNull();
    await expect(
      find({ SESSION_SLEEP_IN_FLIGHT_MAX_AGE_MS: String(15 * 60 * 1000) })
    ).resolves.toMatchObject({ sleep_status: 'failed' });
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
