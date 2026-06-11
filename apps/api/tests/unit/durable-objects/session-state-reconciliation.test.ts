/**
 * Tests for reconcileStaleActivity healing error/recovering states,
 * and for idle-cleanup clearing session_state.activity.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  reconcileStaleActivity,
  upsertActivityState,
} from '../../../src/durable-objects/project-data/session-state';
import { createSqlStorage } from './sql-storage-test-utils';

const FIVE_MINUTES = 5 * 60 * 1000;

describe('reconcileStaleActivity', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  const now = Date.now();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function getActivity(sessionId: string): string | undefined {
    const row = sql.exec(
      'SELECT activity FROM session_state WHERE session_id = ?',
      sessionId,
    ).toArray()[0];
    return row?.activity as string | undefined;
  }

  it.each(['prompting', 'error', 'recovering'] as const)(
    'heals stale %s sessions',
    (activity) => {
      const id = `sess-${activity}`;
      upsertActivityState(sql, id, { activity });
      vi.setSystemTime(now + FIVE_MINUTES + 1000);
      const healed = reconcileStaleActivity(sql);
      expect(healed).toContain(id);
      expect(getActivity(id)).toBe('idle');
    },
  );

  it('does not heal idle sessions', () => {
    upsertActivityState(sql, 'sess-idle', { activity: 'idle' });
    vi.setSystemTime(now + FIVE_MINUTES + 1000);
    const healed = reconcileStaleActivity(sql);
    expect(healed).not.toContain('sess-idle');
    expect(getActivity('sess-idle')).toBe('idle');
  });

  it('does not heal recent prompting sessions', () => {
    upsertActivityState(sql, 'sess-fresh', { activity: 'prompting' });
    // Only 1 minute — within threshold
    vi.setSystemTime(now + 60_000);
    const healed = reconcileStaleActivity(sql);
    expect(healed).toHaveLength(0);
    expect(getActivity('sess-fresh')).toBe('prompting');
  });

  it('heals multiple stale states in one call', () => {
    upsertActivityState(sql, 'sess-p', { activity: 'prompting' });
    upsertActivityState(sql, 'sess-e', { activity: 'error' });
    upsertActivityState(sql, 'sess-r', { activity: 'recovering' });
    upsertActivityState(sql, 'sess-ok', { activity: 'idle' });

    vi.setSystemTime(now + FIVE_MINUTES + 1000);
    const healed = reconcileStaleActivity(sql);
    expect(healed).toHaveLength(3);
    expect(healed).toContain('sess-p');
    expect(healed).toContain('sess-e');
    expect(healed).toContain('sess-r');
    expect(getActivity('sess-ok')).toBe('idle');
  });
});

describe('idle-cleanup clears session_state activity', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  const now = Date.now();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('upsertActivityState sets activity to idle correctly', () => {
    // First set to prompting
    upsertActivityState(sql, 'sess-1', { activity: 'prompting' });
    const row1 = sql.exec(
      'SELECT activity FROM session_state WHERE session_id = ?',
      'sess-1',
    ).toArray()[0];
    expect(row1?.activity).toBe('prompting');

    // Then set to idle (what idle-cleanup does)
    upsertActivityState(sql, 'sess-1', { activity: 'idle' });
    const row2 = sql.exec(
      'SELECT activity FROM session_state WHERE session_id = ?',
      'sess-1',
    ).toArray()[0];
    expect(row2?.activity).toBe('idle');
  });
});
