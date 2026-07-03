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

  function createTaskLinkedAcpSession(acpSessionId: string): void {
    sql.exec(
      `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES ('chat-task', 'ws-task', 'task-1', 'Task', 'active', 0, ?, ?, ?)`,
      now,
      now,
      now,
    );
    sql.exec(
      `INSERT INTO acp_sessions (id, chat_session_id, workspace_id, status, agent_type, created_at, updated_at)
       VALUES (?, 'chat-task', 'ws-task', 'running', 'claude_code', ?, ?)`,
      acpSessionId,
      now,
      now,
    );
  }

  function createAcpSession(
    acpSessionId: string,
    chatSessionId: string,
    status: 'running' | 'started' | 'completed' | 'failed' = 'running',
    heartbeatAt: number | null = now,
  ): void {
    sql.exec(
      `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES (?, 'ws-1', NULL, 'Chat', 'active', 0, ?, ?, ?)`,
      chatSessionId,
      now,
      now,
      now,
    );
    sql.exec(
      `INSERT INTO acp_sessions (id, chat_session_id, workspace_id, status, agent_type, last_heartbeat_at, created_at, updated_at, started_at, completed_at)
       VALUES (?, ?, 'ws-1', ?, 'claude_code', ?, ?, ?, ?, ?)`,
      acpSessionId,
      chatSessionId,
      status,
      heartbeatAt,
      now,
      heartbeatAt ?? now,
      now,
      status === 'completed' ? now : null,
    );
  }

  function insertMessage(sessionId: string, createdAt: number): void {
    sql.exec(
      `INSERT INTO chat_messages (id, session_id, role, content, created_at, sequence)
       VALUES (?, ?, 'assistant', 'still working', ?, 1)`,
      `msg-${sessionId}-${createdAt}`,
      sessionId,
      createdAt,
    );
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

  it('does not heal stale task-linked prompting sessions with recent running ACP evidence', () => {
    createTaskLinkedAcpSession('acp-task');
    upsertActivityState(sql, 'acp-task', { activity: 'prompting' });

    const recentHeartbeat = now + FIVE_MINUTES + 500;
    sql.exec('UPDATE acp_sessions SET last_heartbeat_at = ?, updated_at = ? WHERE id = ?', recentHeartbeat, recentHeartbeat, 'acp-task');

    vi.setSystemTime(now + FIVE_MINUTES + 1000);
    const healed = reconcileStaleActivity(sql);

    expect(healed).not.toContain('acp-task');
    expect(getActivity('acp-task')).toBe('prompting');
  });

  it('does not heal stale prompting sessions when a message arrived since activity_at', () => {
    createAcpSession('acp-chat', 'chat-live', 'completed', null);
    upsertActivityState(sql, 'acp-chat', { activity: 'prompting' });
    const activityAt = now;
    insertMessage('chat-live', activityAt + 1);

    vi.setSystemTime(now + FIVE_MINUTES + 1000);
    const healed = reconcileStaleActivity(sql);

    expect(healed).not.toContain('acp-chat');
    expect(getActivity('acp-chat')).toBe('prompting');
  });

  it('heals stale prompting sessions with no messages and no live ACP evidence', () => {
    createAcpSession('acp-dead', 'chat-dead', 'completed', null);
    upsertActivityState(sql, 'acp-dead', { activity: 'prompting' });

    vi.setSystemTime(now + FIVE_MINUTES + 1000);
    const healed = reconcileStaleActivity(sql);

    expect(healed).toEqual(['acp-dead']);
    expect(getActivity('acp-dead')).toBe('idle');
  });

  it('does not reselect a healed zombie on the second sweep', () => {
    createAcpSession('acp-zombie', 'chat-zombie', 'failed', null);
    upsertActivityState(sql, 'acp-zombie', { activity: 'recovering' });

    vi.setSystemTime(now + FIVE_MINUTES + 1000);
    expect(reconcileStaleActivity(sql)).toEqual(['acp-zombie']);
    expect(reconcileStaleActivity(sql)).toEqual([]);
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
