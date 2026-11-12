import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type DurabilityFoundationHooks,
  reportActivity,
} from '../../src/do/durability-foundation';
import { runMigrations } from '../../src/do/migrations';
import { getSessionState } from '../../src/do/session-state-read';
import { createSqlStorage } from '../fixtures/sql-storage';

// The composer hides Steer when the session's adapter cannot steer. The ProjectData DO
// stores what the VM agent reported, returns it with session state, and pushes it with
// every session.activity broadcast. Real SQLite, real migrations.
describe('session_state steering support', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  let hooks: DurabilityFoundationHooks;
  let broadcastEvent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    broadcastEvent = vi.fn();
    hooks = {
      getProjectId: () => 'project',
      transactionSync: (fn) => db.transaction(fn)(),
      waitUntil: () => {},
      recalculateAlarm: async () => {},
      scheduleSummarySync: vi.fn(),
      broadcastEvent,
      armIdleCleanup: vi.fn(),
      nudgeDeliveries: () => 0,
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  function lastBroadcast() {
    const call = broadcastEvent.mock.calls.at(-1);
    expect(call?.[0]).toBe('session.activity');
    return call?.[1] as { activity: string; steeringSupported: boolean | null };
  }

  it('is null until reported, then stored, broadcast, and kept by reports that omit it', async () => {
    await reportActivity(sql, hooks, 'acp-1', 'prompting', { observedAt: Date.now() });
    expect(getSessionState(sql, 'acp-1')).toMatchObject({
      activity: 'prompting',
      steeringSupported: null,
    });
    expect(lastBroadcast()).toMatchObject({ activity: 'prompting', steeringSupported: null });

    vi.setSystemTime(1_000_100);
    await reportActivity(sql, hooks, 'acp-1', 'prompting', {
      observedAt: Date.now(),
      steeringSupported: false,
    });
    expect(getSessionState(sql, 'acp-1')?.steeringSupported).toBe(false);
    expect(lastBroadcast()).toMatchObject({ activity: 'prompting', steeringSupported: false });

    // An older VM agent never sends the field; its reports must not erase the value.
    vi.setSystemTime(1_000_200);
    await reportActivity(sql, hooks, 'acp-1', 'idle', { observedAt: Date.now() });
    expect(getSessionState(sql, 'acp-1')).toMatchObject({
      activity: 'idle',
      steeringSupported: false,
    });
    expect(lastBroadcast()).toMatchObject({ activity: 'idle', steeringSupported: false });

    // A restarted adapter that can steer replaces it.
    vi.setSystemTime(1_000_300);
    await reportActivity(sql, hooks, 'acp-1', 'prompting', {
      observedAt: Date.now(),
      steeringSupported: true,
    });
    expect(getSessionState(sql, 'acp-1')?.steeringSupported).toBe(true);
    expect(lastBroadcast()).toMatchObject({ steeringSupported: true });
  });

  it('keeps sessions independent', async () => {
    await reportActivity(sql, hooks, 'acp-1', 'prompting', {
      observedAt: Date.now(),
      steeringSupported: false,
    });
    await reportActivity(sql, hooks, 'acp-2', 'prompting', {
      observedAt: Date.now(),
      steeringSupported: true,
    });
    expect(getSessionState(sql, 'acp-1')?.steeringSupported).toBe(false);
    expect(getSessionState(sql, 'acp-2')?.steeringSupported).toBe(true);
  });

  it('migration 074 is idempotent when the column already exists', () => {
    sql.exec("DELETE FROM migrations WHERE name = '074-session-state-steering-supported'");
    expect(() => runMigrations(sql)).not.toThrow();
    const columns = sql
      .exec('PRAGMA table_info(session_state)')
      .toArray()
      .map((column) => column.name);
    expect(columns.filter((name) => name === 'steering_supported')).toHaveLength(1);
  });
});
