/**
 * The shared "restorable or still sleeping" predicate against a real SQL engine
 * (rule 28). Its in-flight arm mirrors the session-sleep sweep (rule 58): a failed
 * sleep is in flight exactly while `runSessionSleepSweep` will retry it, which is
 * bounded by the SLEEP budget, not the wake budget.
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

  function seedFailedSleep(overrides: { attempts: number; status?: string; degradation?: string }) {
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
        new Date(NOW.getTime() + 5 * 60 * 1000).toISOString(),
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

  it('keeps a failed sleep in flight while the sweep still has sleep attempts left', async () => {
    // Five failed attempts: past the wake budget (3), inside the sleep budget (9).
    // The sweep retries this row, so every reaper that reads this predicate must
    // leave its runtime alone.
    seedFailedSleep({ attempts: 5 });

    await expect(find()).resolves.toMatchObject({ sleep_status: 'failed' });
  });

  it('stops holding a failed sleep once the sleep budget is spent', async () => {
    seedFailedSleep({ attempts: 9 });

    await expect(find()).resolves.toBeNull();
  });

  it('reads the configured sleep budget, not the wake budget', async () => {
    seedFailedSleep({ attempts: 5 });

    await expect(
      find({ SESSION_SLEEP_MAX_ATTEMPTS: '4', SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS: '10' })
    ).resolves.toBeNull();
    await expect(
      find({ SESSION_SLEEP_MAX_ATTEMPTS: '6', SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS: '1' })
    ).resolves.toMatchObject({ sleep_status: 'failed' });
  });

  it('keeps a repairable capture in flight past the budget, as the sweep retries it', async () => {
    seedFailedSleep({ attempts: 9, status: 'degraded', degradation: 'transcript-only' });

    await expect(find()).resolves.toMatchObject({ sleep_status: 'failed' });
  });
});
