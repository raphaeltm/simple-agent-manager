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
  completeAttentionAnswer,
  computeAttentionAlarmTime,
  computeHumanInputExpiry,
  createAttentionMarker,
  getAttentionSummary,
  getExpiredMarkers,
  listActiveAttentionMarkers,
  prepareAttentionAnswer,
  releaseAttentionAnswer,
  resolveAttentionMarkerById,
  resolveAttentionMarkers,
} from '../../../src/durable-objects/project-data/attention';
import { createSqlStorage } from './sql-storage-test-utils';

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

  describe('structured answers', () => {
    it('records and resolves an allowed option idempotently', () => {
      const marker = createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'needs_input',
        source: 'request_human_input',
        metadata: JSON.stringify({ options: ['Approve', 'Reject'] }),
      });

      expect(prepareAttentionAnswer(sql, 'session-1', marker.id, 'Approve')).toEqual({
        status: 'ready',
      });
      expect(prepareAttentionAnswer(sql, 'session-1', marker.id, 'Approve')).toEqual({
        status: 'in_flight',
        answer: 'Approve',
      });
      expect(prepareAttentionAnswer(sql, 'session-1', marker.id, 'Reject')).toEqual({
        status: 'conflicting_answer',
        answer: 'Approve',
      });
      expect(completeAttentionAnswer(sql, 'session-1', marker.id, 'Approve')).toBe(1);
      expect(completeAttentionAnswer(sql, 'session-1', marker.id, 'Approve')).toBe(0);

      const stored = db
        .prepare(
          'SELECT resolved_reason, resolved_answer FROM session_attention_markers WHERE id = ?'
        )
        .get(marker.id) as { resolved_reason: string; resolved_answer: string };
      expect(stored).toEqual({ resolved_reason: 'structured_answer', resolved_answer: 'Approve' });
      expect(prepareAttentionAnswer(sql, 'session-1', marker.id, 'Approve')).toEqual({
        status: 'already_resolved',
        answer: 'Approve',
      });
    });

    it('releases only the matching staged answer after delivery failure', () => {
      const marker = createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'needs_input',
        source: 'request_human_input',
        metadata: JSON.stringify({ options: ['Approve', 'Reject'] }),
      });

      expect(prepareAttentionAnswer(sql, 'session-1', marker.id, 'Approve')).toEqual({
        status: 'ready',
      });
      expect(releaseAttentionAnswer(sql, 'session-1', marker.id, 'Reject')).toBe(0);
      expect(releaseAttentionAnswer(sql, 'session-1', marker.id, 'Approve')).toBe(1);
      expect(prepareAttentionAnswer(sql, 'session-1', marker.id, 'Reject')).toEqual({
        status: 'ready',
      });
    });

    it('rejects answers not present in marker options without resolving', () => {
      const marker = createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'needs_input',
        source: 'request_human_input',
        metadata: JSON.stringify({ options: ['Approve', 'Reject'] }),
      });

      expect(prepareAttentionAnswer(sql, 'session-1', marker.id, 'Maybe')).toEqual({
        status: 'invalid_option',
        options: ['Approve', 'Reject'],
      });
      expect(listActiveAttentionMarkers(sql, 'session-1')).toHaveLength(1);
    });

    it('accepts a free-form answer when the marker has no stored options', () => {
      const marker = createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'needs_input',
        source: 'request_human_input',
        metadata: JSON.stringify({ category: 'clarification', options: null }),
      });

      expect(
        prepareAttentionAnswer(sql, 'session-1', marker.id, 'Use the smaller release')
      ).toEqual({
        status: 'ready',
      });
      expect(completeAttentionAnswer(sql, 'session-1', marker.id, 'Use the smaller release')).toBe(
        1
      );
      const stored = db
        .prepare('SELECT resolved_answer FROM session_attention_markers WHERE id = ?')
        .get(marker.id) as { resolved_answer: string };
      expect(stored.resolved_answer).toBe('Use the smaller release');
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
        metadata: JSON.stringify({ options: ['Approve', 'Reject'] }),
        expiresAt,
      });

      const summary = getAttentionSummary(sql, 'session-1');
      expect(summary).not.toBeNull();
      expect(summary!.kind).toBe('needs_input');
      expect(summary!.reason).toBe('Please review');
      expect(summary!.expiresAt).toBe(expiresAt);
      expect(summary!.options).toEqual(['Approve', 'Reject']);
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
