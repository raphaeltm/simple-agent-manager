/**
 * Unit tests for the attention markers module.
 *
 * Uses better-sqlite3 as a stand-in for DO SQLite to test the pure
 * functions in attention.ts without requiring the workerd runtime.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  computeAttentionAlarmTime,
  computeHumanInputExpiry,
  createAttentionMarker,
  getAttentionSummary,
  getExpiredMarkers,
  listActiveAttentionMarkers,
  resolveAttentionMarkerById,
  resolveAttentionMarkers,
} from '../../../src/durable-objects/project-data/attention';

// Adapter: better-sqlite3 → SqlStorage-compatible interface
function createSqlStorage(db: Database.Database) {
  return {
    exec(query: string, ...params: unknown[]) {
      const trimmed = query.trim().toUpperCase();
      const isSelect = trimmed.startsWith('SELECT') || trimmed.startsWith('WITH');

      if (isSelect) {
        const stmt = db.prepare(query);
        const rows = params.length > 0 ? stmt.all(...params) : stmt.all();
        return {
          toArray() { return rows; },
          rowsWritten: 0,
        };
      }

      if (params.length === 0) {
        // Multi-statement DDL (migrations) — use db.exec()
        db.exec(query);
        return {
          toArray() { return []; },
          rowsWritten: 0,
        };
      }

      const stmt = db.prepare(query);
      const result = stmt.run(...params);
      return {
        toArray() { return []; },
        rowsWritten: result.changes,
      };
    },
  } as unknown as SqlStorage;
}

describe('Attention Markers Module', () => {
  let db: Database.Database;
  let sql: SqlStorage;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);

    // Create a test session
    db.exec(`
      INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
      VALUES ('session-1', 'ws-1', 'task-1', 'Test', 'active', 0, ${Date.now()}, ${Date.now()}, ${Date.now()})
    `);
    db.exec(`
      INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
      VALUES ('session-2', null, null, 'Test 2', 'active', 0, ${Date.now()}, ${Date.now()}, ${Date.now()})
    `);
  });

  afterEach(() => {
    db.close();
  });

  describe('createAttentionMarker', () => {
    it('creates a marker with all fields', () => {
      const expiresAt = Date.now() + 7200000;
      const result = createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'needs_input',
        source: 'request_human_input',
        reason: 'Need approval',
        metadata: '{"category":"approval"}',
        expiresAt,
      });

      expect(result.id).toBeTruthy();
      expect(result.createdAt).toBeGreaterThan(0);
      expect(result.expiresAt).toBe(expiresAt);
    });

    it('creates a marker without optional fields', () => {
      const result = createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
      });

      expect(result.id).toBeTruthy();
      expect(result.expiresAt).toBeNull();
    });
  });

  describe('listActiveAttentionMarkers', () => {
    it('returns all active markers for a session', () => {
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
      });
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_review',
        source: 'test',
      });

      const markers = listActiveAttentionMarkers(sql, 'session-1');
      expect(markers).toHaveLength(2);
      const kinds = markers.map((m) => m.kind).sort();
      expect(kinds).toEqual(['needs_input', 'needs_review']);
    });

    it('does not return resolved markers', () => {
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
      });
      resolveAttentionMarkers(sql, 'session-1', null, 'human', 'test');

      const markers = listActiveAttentionMarkers(sql, 'session-1');
      expect(markers).toHaveLength(0);
    });

    it('returns empty for a session with no markers', () => {
      const markers = listActiveAttentionMarkers(sql, 'session-2');
      expect(markers).toHaveLength(0);
    });
  });

  describe('resolveAttentionMarkers', () => {
    it('resolves all active markers for a session', () => {
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
      });
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_review',
        source: 'test',
      });

      const count = resolveAttentionMarkers(sql, 'session-1', 'msg-1', 'human', 'human_message');
      expect(count).toBe(2);

      const markers = listActiveAttentionMarkers(sql, 'session-1');
      expect(markers).toHaveLength(0);
    });

    it('returns 0 when no active markers exist', () => {
      const count = resolveAttentionMarkers(sql, 'session-1', null, 'system', 'test');
      expect(count).toBe(0);
    });

    it('does not resolve markers for other sessions', () => {
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
      });
      createAttentionMarker(sql, {
        sessionId: 'session-2',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
      });

      resolveAttentionMarkers(sql, 'session-1', null, 'human', 'test');

      const s1Markers = listActiveAttentionMarkers(sql, 'session-1');
      const s2Markers = listActiveAttentionMarkers(sql, 'session-2');
      expect(s1Markers).toHaveLength(0);
      expect(s2Markers).toHaveLength(1);
    });
  });

  describe('resolveAttentionMarkerById', () => {
    it('resolves only the specified marker', () => {
      const m1 = createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
        expiresAt: Date.now() - 1000,
      });
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_review',
        source: 'test',
        expiresAt: Date.now() + 7200000,
      });

      const count = resolveAttentionMarkerById(sql, m1.id, 'system', 'expired');
      expect(count).toBe(1);

      // The non-expired marker should still be active
      const active = listActiveAttentionMarkers(sql, 'session-1');
      expect(active).toHaveLength(1);
      expect(active[0].kind).toBe('needs_review');
    });

    it('returns 0 for already-resolved marker', () => {
      const m1 = createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
      });
      resolveAttentionMarkerById(sql, m1.id, 'system', 'expired');
      const count = resolveAttentionMarkerById(sql, m1.id, 'system', 'expired');
      expect(count).toBe(0);
    });
  });

  describe('getAttentionSummary', () => {
    it('returns null when no active markers exist', () => {
      const summary = getAttentionSummary(sql, 'session-1');
      expect(summary).toBeNull();
    });

    it('returns an active marker summary', () => {
      const expiresAt = Date.now() + 3600000;
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
        reason: 'Please review',
        expiresAt,
      });

      const summary = getAttentionSummary(sql, 'session-1');
      expect(summary).not.toBeNull();
      expect(summary!.kind).toBe('needs_input');
      expect(summary!.reason).toBe('Please review');
      expect(summary!.expiresAt).toBe(expiresAt);
    });

    it('returns null after all markers are resolved', () => {
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
      });
      resolveAttentionMarkers(sql, 'session-1', null, 'human', 'test');

      const summary = getAttentionSummary(sql, 'session-1');
      expect(summary).toBeNull();
    });
  });

  describe('getExpiredMarkers', () => {
    it('returns markers past their expiry time', () => {
      const pastExpiry = Date.now() - 1000;
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'needs_input',
        source: 'test',
        expiresAt: pastExpiry,
      });

      const expired = getExpiredMarkers(sql);
      expect(expired).toHaveLength(1);
      expect(expired[0].sessionId).toBe('session-1');
      expect(expired[0].taskId).toBe('task-1');
      expect(expired[0].kind).toBe('needs_input');
    });

    it('does not return markers that have not expired', () => {
      const futureExpiry = Date.now() + 7200000;
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
        expiresAt: futureExpiry,
      });

      const expired = getExpiredMarkers(sql);
      expect(expired).toHaveLength(0);
    });

    it('does not return resolved expired markers', () => {
      const pastExpiry = Date.now() - 1000;
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
        expiresAt: pastExpiry,
      });
      resolveAttentionMarkers(sql, 'session-1', null, 'system', 'expired');

      const expired = getExpiredMarkers(sql);
      expect(expired).toHaveLength(0);
    });

    it('does not return markers without an expiry', () => {
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
      });

      const expired = getExpiredMarkers(sql);
      expect(expired).toHaveLength(0);
    });
  });

  describe('computeAttentionAlarmTime', () => {
    it('returns null when no active markers with expiry exist', () => {
      const alarmTime = computeAttentionAlarmTime(sql);
      expect(alarmTime).toBeNull();
    });

    it('returns the earliest expiry time', () => {
      const early = Date.now() + 1000;
      const late = Date.now() + 7200000;

      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
        expiresAt: late,
      });
      createAttentionMarker(sql, {
        sessionId: 'session-2',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
        expiresAt: early,
      });

      const alarmTime = computeAttentionAlarmTime(sql);
      expect(alarmTime).toBe(early);
    });

    it('ignores resolved markers', () => {
      const expiresAt = Date.now() + 1000;
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: null,
        workspaceId: null,
        kind: 'needs_input',
        source: 'test',
        expiresAt,
      });
      resolveAttentionMarkers(sql, 'session-1', null, 'human', 'test');

      const alarmTime = computeAttentionAlarmTime(sql);
      expect(alarmTime).toBeNull();
    });
  });

  describe('computeHumanInputExpiry', () => {
    it('uses default 2-hour timeout when env is undefined', () => {
      const before = Date.now();
      const expiry = computeHumanInputExpiry(undefined);
      const after = Date.now();
      const twoHours = 2 * 60 * 60 * 1000;

      expect(expiry).toBeGreaterThanOrEqual(before + twoHours);
      expect(expiry).toBeLessThanOrEqual(after + twoHours);
    });

    it('uses custom timeout from env var', () => {
      const before = Date.now();
      const expiry = computeHumanInputExpiry('60000'); // 1 minute
      const after = Date.now();

      expect(expiry).toBeGreaterThanOrEqual(before + 60000);
      expect(expiry).toBeLessThanOrEqual(after + 60000);
    });

    it('falls back to default on non-numeric env var', () => {
      const before = Date.now();
      const expiry = computeHumanInputExpiry('not-a-number');
      const after = Date.now();
      const twoHours = 2 * 60 * 60 * 1000;

      expect(expiry).toBeGreaterThanOrEqual(before + twoHours);
      expect(expiry).toBeLessThanOrEqual(after + twoHours);
    });
  });
});
