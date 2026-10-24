import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import { computeProjectDataAlarmTime } from '../../../src/durable-objects/project-data/alarm-schedule';
import { createSqlStorage } from './sql-storage-test-utils';

describe('ProjectData shared alarm deadlines', () => {
  const now = 1_800_000_000_000;
  let db: Database.Database;
  let sql: SqlStorage;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    sql.exec("INSERT INTO do_meta (key, value) VALUES ('projectId', 'project-1')");
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
  });

  function addSchedule(id: string, nextAttemptAt: number) {
    sql.exec(`INSERT INTO project_schedules (
      id, project_id, creator_user_id, action_json, fingerprint, state,
      due_at, display_timezone, expires_at, version, idempotency_key,
      created_at, updated_at, next_attempt_at
    ) VALUES (?, 'project-1', 'user-1', '{}', ?, 'pending', ?, 'UTC', ?, 1, ?, ?, ?, ?)`,
    id, id, nextAttemptAt, now + 60_000, id, now, now, nextAttemptAt);
  }

  it.each([0, -1, now - 1])('schedules overdue persisted deadline %s immediately at a valid alarm time', (deadline) => {
    addSchedule('overdue', deadline);
    addSchedule('future', now + 30_000);
    expect(computeProjectDataAlarmTime(sql, { PROJECT_DATA_STORAGE_TELEMETRY_ENABLED: 'false' })).toBe(now);
  });

  it('preserves the earliest future deadline without accelerating it', () => {
    addSchedule('later', now + 30_000);
    addSchedule('earlier', now + 10_000);
    expect(computeProjectDataAlarmTime(sql, { PROJECT_DATA_STORAGE_TELEMETRY_ENABLED: 'false' })).toBe(now + 10_000);
  });

  it('keeps an empty project unscheduled', () => {
    expect(computeProjectDataAlarmTime(sql, { PROJECT_DATA_STORAGE_TELEMETRY_ENABLED: 'false' })).toBeNull();
  });
});
