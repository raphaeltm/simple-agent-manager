/**
 * Unit tests for the task-mode inactivity reconciliation module.
 *
 * Uses better-sqlite3 as a stand-in for DO SQLite. D1 queries and
 * VM agent calls are mocked since they cross service boundaries.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import { computeProjectDataAlarmTime } from '../../../src/durable-objects/project-data/alarm-schedule';
import {
  createAttentionMarker,
  getExpiredMarkers,
  resolveAttentionMarkerById,
  resolveAttentionMarkers,
} from '../../../src/durable-objects/project-data/attention';
import {
  computeReconciliationAlarmTime,
  getReconciliationCandidates,
  processReconciliationCandidates,
} from '../../../src/durable-objects/project-data/reconciliation';
import { createSqlStorage } from './sql-storage-test-utils';

// Mock the node-agent service to prevent real HTTP calls
vi.mock('../../../src/services/node-agent', () => ({
  sendPromptToAgentOnNode: vi.fn().mockResolvedValue(undefined),
  cancelAgentSessionOnNode: vi.fn().mockResolvedValue({ success: true, status: 200 }),
}));

/** Helper to create a D1Database mock with configurable task queries */
function createMockD1(taskRows: Record<string, { task_mode: string; status: string }> = {}, workspaceRows: Record<string, { node_id: string | null; user_id: string }> = {}) {
  return {
    prepare: vi.fn().mockImplementation((query: string) => ({
      bind: vi.fn().mockImplementation((...args: unknown[]) => ({
        first: vi.fn().mockImplementation(async () => {
          if (query.includes('FROM tasks')) {
            return taskRows[args[0] as string] ?? null;
          }
          if (query.includes('FROM workspaces')) {
            return workspaceRows[args[0] as string] ?? null;
          }
          if (query.includes('FROM acp_sessions')) {
            return { id: `acp-${args[0]}` };
          }
          return null;
        }),
        run: vi.fn().mockResolvedValue({ success: true }),
      })),
    })),
  } as unknown as D1Database;
}

const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_MINUTE = 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;
const TWO_HOURS = 2 * 60 * 60 * 1000;
type ProjectDataEnv = import('../../../src/durable-objects/project-data/types').Env;

describe('Task Reconciliation Module', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  const now = Date.now();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** Helper to set up a task-mode session with idle cleanup and workspace activity */
  function setupTaskSession(opts: {
    sessionId?: string;
    workspaceId?: string;
    taskId?: string;
    lastActivityAt?: number;
    acpSessionId?: string;
    withIdleCleanup?: boolean;
  } = {}) {
    const sessionId = opts.sessionId ?? 'session-1';
    const workspaceId = opts.workspaceId ?? 'ws-1';
    const taskId = opts.taskId ?? 'task-1';
    const lastActivityAt = opts.lastActivityAt ?? (now - FIVE_MINUTES - 1000);
    const acpSessionId = opts.acpSessionId ?? 'acp-1';
    const withIdleCleanup = opts.withIdleCleanup ?? true;

    // Create chat session
    db.prepare(
      `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES (?, ?, ?, 'Test', 'active', 0, ?, ?, ?)`,
    ).run(sessionId, workspaceId, taskId, now - 600000, now - 600000, now - 600000);

    if (withIdleCleanup) {
      db.prepare(
        `INSERT INTO idle_cleanup_schedule (session_id, workspace_id, task_id, cleanup_at, created_at, retry_count)
         VALUES (?, ?, ?, ?, ?, 0)`,
      ).run(sessionId, workspaceId, taskId, now + 900000, now - 600000);
    }

    // Create workspace activity
    db.prepare(
      `INSERT INTO workspace_activity (workspace_id, session_id, last_message_at, last_terminal_activity_at, created_at)
       VALUES (?, ?, ?, 0, ?)`,
    ).run(workspaceId, sessionId, lastActivityAt, lastActivityAt);

    // Create ACP session
    db.prepare(
      `INSERT INTO acp_sessions (id, chat_session_id, status, agent_type, created_at, updated_at)
       VALUES (?, ?, 'running', 'claude_code', ?, ?)`,
    ).run(acpSessionId, sessionId, now - 600000, now - 600000);

    // Link ACP session to workspace
    db.prepare(
      `UPDATE acp_sessions SET workspace_id = ? WHERE id = ?`,
    ).run(workspaceId, acpSessionId);
  }

  function envWithRows(
    taskRows: Record<string, { task_mode: string; status: string }> = {},
    workspaceRows: Record<string, { node_id: string | null; user_id: string }> = {},
  ): ProjectDataEnv {
    return { DATABASE: createMockD1(taskRows, workspaceRows) } as unknown as ProjectDataEnv;
  }

  async function candidatesForTask(taskMode: string, status: string) {
    setupTaskSession();
    return getReconciliationCandidates(sql, envWithRows({
      'task-1': { task_mode: taskMode, status },
    }));
  }

  function setAcpHeartbeat(acpSessionId = 'acp-1', heartbeatAt = now) {
    db.prepare(
      `UPDATE acp_sessions SET node_id = 'node-1', last_heartbeat_at = ? WHERE id = ?`,
    ).run(heartbeatAt, acpSessionId);
  }

  function setSessionActivity(opts: {
    acpSessionId?: string;
    activity?: string;
    activityAt?: number;
    promptStartedAt?: number | null;
  } = {}) {
    const acpSessionId = opts.acpSessionId ?? 'acp-1';
    const activity = opts.activity ?? 'prompting';
    const activityAt = opts.activityAt ?? now;
    const promptStartedAt = opts.promptStartedAt ?? activityAt;
    db.prepare(
      `INSERT INTO session_state (session_id, activity, activity_at, prompt_started_at, restart_count)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(session_id) DO UPDATE SET
         activity = excluded.activity,
         activity_at = excluded.activity_at,
         prompt_started_at = excluded.prompt_started_at`,
    ).run(acpSessionId, activity, activityAt, promptStartedAt);
  }

  describe('getReconciliationCandidates', () => {
    it('selects task-mode sessions idle for 5 minutes', async () => {
      const candidates = await candidatesForTask('task', 'in_progress');

      expect(candidates).toHaveLength(1);
      expect(candidates[0].sessionId).toBe('session-1');
      expect(candidates[0].taskId).toBe('task-1');
      expect(candidates[0].workspaceId).toBe('ws-1');
      expect(candidates[0].acpSessionId).toBe('acp-1');
      expect(candidates[0].idleDurationMs).toBeGreaterThan(FIVE_MINUTES);
    });

    it('selects task-mode sessions even when idle cleanup schedule is missing', async () => {
      setupTaskSession({ withIdleCleanup: false });

      const candidates = await getReconciliationCandidates(sql, envWithRows({
        'task-1': { task_mode: 'task', status: 'in_progress' },
      }));

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        acpSessionId: 'acp-1',
      });
    });

    it('excludes conversation-mode tasks', async () => {
      const candidates = await candidatesForTask('conversation', 'in_progress');
      expect(candidates).toHaveLength(0);
    });

    it('excludes completed tasks', async () => {
      const candidates = await candidatesForTask('task', 'completed');
      expect(candidates).toHaveLength(0);
    });

    it('excludes failed tasks', async () => {
      const candidates = await candidatesForTask('task', 'failed');
      expect(candidates).toHaveLength(0);
    });

    it('excludes sessions with active needs_input marker', async () => {
      setupTaskSession();
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'needs_input',
        source: 'agent',
        reason: 'Waiting for user input',
        expiresAt: now + 7200000,
      });
      const candidates = await getReconciliationCandidates(sql, envWithRows({
        'task-1': { task_mode: 'task', status: 'in_progress' },
      }));
      expect(candidates).toHaveLength(0);
    });

    it('excludes sessions with unresolved reconciliation_checkin marker (loop prevention)', async () => {
      setupTaskSession();
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        reason: 'Agent idle — SAM check-in sent',
        expiresAt: now + ONE_MINUTE,
      });
      const candidates = await getReconciliationCandidates(sql, envWithRows({
        'task-1': { task_mode: 'task', status: 'in_progress' },
      }));
      expect(candidates).toHaveLength(0);
    });

    it('excludes sessions that are not idle long enough', async () => {
      // Activity 2 minutes ago — not idle for 5 minutes
      setupTaskSession({ lastActivityAt: now - 2 * 60 * 1000 });
      const mockDb = createMockD1({
        'task-1': { task_mode: 'task', status: 'in_progress' },
      });
      const env = { DATABASE: mockDb } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const candidates = await getReconciliationCandidates(sql, env);
      expect(candidates).toHaveLength(0);
    });

    it('excludes sessions without an active ACP session', async () => {
      setupTaskSession();
      // Remove the ACP session
      db.exec('DELETE FROM acp_sessions');

      const mockDb = createMockD1({
        'task-1': { task_mode: 'task', status: 'in_progress' },
      });
      const env = { DATABASE: mockDb } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const candidates = await getReconciliationCandidates(sql, env);
      expect(candidates).toHaveLength(0);
    });

    it('excludes sessions without a task_id in idle_cleanup_schedule', async () => {
      // Create a session without task_id (conversation mode)
      db.exec(
        `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
         VALUES ('session-conv', 'ws-conv', NULL, 'Conv', 'active', 0, ${now}, ${now}, ${now})`,
      );
      db.exec(
        `INSERT INTO idle_cleanup_schedule (session_id, workspace_id, task_id, cleanup_at, created_at, retry_count)
         VALUES ('session-conv', 'ws-conv', NULL, ${now + 900000}, ${now}, 0)`,
      );

      const candidates = await getReconciliationCandidates(sql, envWithRows());
      expect(candidates).toHaveLength(0);
    });

    it('includes delegated tasks', async () => {
      const candidates = await candidatesForTask('task', 'delegated');
      expect(candidates).toHaveLength(1);
    });

    it('includes awaiting_followup tasks because they are not complete', async () => {
      const candidates = await candidatesForTask('task', 'awaiting_followup');
      expect(candidates).toHaveLength(1);
    });

    it('defers check-in while a task prompt is in flight below the soft threshold', async () => {
      setupTaskSession({ lastActivityAt: now - FIVE_MINUTES - 1000 });
      setSessionActivity({ promptStartedAt: now - 10 * 60 * 1000 });

      const candidates = await getReconciliationCandidates(sql, {
        ...envWithRows({ 'task-1': { task_mode: 'task', status: 'in_progress' } }),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as ProjectDataEnv);

      expect(candidates).toHaveLength(0);
    });

    it('observes but does not interrupt prompts between soft and hard thresholds', async () => {
      setupTaskSession({ lastActivityAt: now - FIVE_MINUTES - 1000 });
      setSessionActivity({ promptStartedAt: now - THIRTY_MINUTES - 1000 });

      const candidates = await getReconciliationCandidates(sql, {
        ...envWithRows({ 'task-1': { task_mode: 'task', status: 'in_progress' } }),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as ProjectDataEnv);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        action: 'observe_prompt',
        promptStartedAt: now - THIRTY_MINUTES - 1000,
      });
      expect(candidates[0].promptAgeMs).toBe(THIRTY_MINUTES + 1000);
    });

    it('marks prompts beyond the hard threshold for cancellation', async () => {
      setupTaskSession({ lastActivityAt: now - FIVE_MINUTES - 1000 });
      setSessionActivity({ promptStartedAt: now - TWO_HOURS - 1000 });

      const candidates = await getReconciliationCandidates(sql, {
        ...envWithRows({ 'task-1': { task_mode: 'task', status: 'in_progress' } }),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as ProjectDataEnv);

      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        action: 'cancel_prompt',
        promptStartedAt: now - TWO_HOURS - 1000,
      });
    });
  });

  describe('processReconciliationCandidates', () => {
    it('persists check-in message with SAM orchestrator metadata', async () => {
      setupTaskSession();
      const env = envWithRows(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } },
      );
      const broadcastEvent = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, broadcastEvent);

      expect(processed).toBe(1);

      // Check the message was persisted
      const messages = db.prepare('SELECT * FROM chat_messages WHERE session_id = ?').all('session-1');
      expect(messages).toHaveLength(1);
      const msg = messages[0] as Record<string, unknown>;
      expect(msg.role).toBe('user');
      expect(msg.content).toContain('SAM Orchestrator Check-In');
      expect(msg.content).toContain('continue working from where you left off');
      expect(msg.content).toContain('Do not stop after the update');
      expect(msg.content).toContain('complete_task()');

      // Check metadata
      const metadata = JSON.parse(msg.tool_metadata as string);
      expect(metadata.source).toBe('sam_orchestrator');
      expect(metadata.kind).toBe('reconciliation_checkin');
    });

    it('creates reconciliation_checkin attention marker with deadline', async () => {
      setupTaskSession();
      const env = envWithRows(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } },
      );
      const broadcastEvent = vi.fn();

      await processReconciliationCandidates(sql, env, broadcastEvent);

      // Check the attention marker was created
      const markers = db.prepare(
        `SELECT * FROM session_attention_markers WHERE session_id = ? AND kind = 'reconciliation_checkin'`,
      ).all('session-1');
      expect(markers).toHaveLength(1);
      const marker = markers[0] as Record<string, unknown>;
      expect(marker.source).toBe('sam_orchestrator');
      expect(marker.resolved_at).toBeNull();
      // Expires ~1 minute from now
      expect(marker.expires_at).toBeGreaterThan(now);
      expect((marker.expires_at as number) - now).toBeLessThanOrEqual(ONE_MINUTE + 1000);
    });

    it('broadcasts message.new and attention.created events', async () => {
      setupTaskSession();
      const mockDb = createMockD1(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } },
      );
      const env = { DATABASE: mockDb } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const broadcastEvent = vi.fn();

      await processReconciliationCandidates(sql, env, broadcastEvent);

      // Should broadcast message.new
      const msgEvents = broadcastEvent.mock.calls.filter(([type]: string[]) => type === 'message.new');
      expect(msgEvents).toHaveLength(1);
      expect(msgEvents[0][1].role).toBe('user');
      expect(msgEvents[0][1].toolMetadata.source).toBe('sam_orchestrator');

      // Should broadcast attention.created
      const attnEvents = broadcastEvent.mock.calls.filter(([type]: string[]) => type === 'attention.created');
      expect(attnEvents).toHaveLength(1);
      expect(attnEvents[0][1].kind).toBe('reconciliation_checkin');
    });

    it('records activity event for check-in', async () => {
      setupTaskSession();
      const mockDb = createMockD1(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } },
      );
      const env = { DATABASE: mockDb } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const broadcastEvent = vi.fn();

      await processReconciliationCandidates(sql, env, broadcastEvent);

      const events = db.prepare(
        `SELECT * FROM activity_events WHERE event_type = 'reconciliation.checkin_sent'`,
      ).all();
      expect(events).toHaveLength(1);
    });

    it('does not send duplicate check-in when marker already exists', async () => {
      setupTaskSession();
      // Create an existing unresolved reconciliation_checkin marker
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        expiresAt: now + ONE_MINUTE,
      });

      const mockDb = createMockD1(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
      );
      const env = { DATABASE: mockDb } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const broadcastEvent = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, broadcastEvent);
      expect(processed).toBe(0);
    });

    it('does not process when task already completed via complete_task', async () => {
      setupTaskSession();
      const mockDb = createMockD1({
        'task-1': { task_mode: 'task', status: 'completed' },
      });
      const env = { DATABASE: mockDb } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const broadcastEvent = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, broadcastEvent);
      expect(processed).toBe(0);
    });

    it('calls sendPromptToAgentOnNode with correct parameters', async () => {
      const { sendPromptToAgentOnNode } = await import('../../../src/services/node-agent');
      setupTaskSession();
      const mockDb = createMockD1(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } },
      );
      const env = { DATABASE: mockDb } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const broadcastEvent = vi.fn();

      await processReconciliationCandidates(sql, env, broadcastEvent);

      expect(vi.mocked(sendPromptToAgentOnNode)).toHaveBeenCalledWith(
        'node-1',
        'ws-1',
        'acp-1',
        expect.stringContaining('continue working from where you left off'),
        expect.anything(),
        'user-1',
      );
    });

    it('still creates marker and message when agent send fails', async () => {
      const { sendPromptToAgentOnNode } = await import('../../../src/services/node-agent');
      vi.mocked(sendPromptToAgentOnNode).mockRejectedValueOnce(new Error('network error'));

      setupTaskSession();
      const mockDb = createMockD1(
        { 'task-1': { task_mode: 'task', status: 'in_progress' } },
        { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } },
      );
      const env = { DATABASE: mockDb } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const broadcastEvent = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, broadcastEvent);
      expect(processed).toBe(1);

      // Message and marker should still exist despite send failure
      const messages = db.prepare('SELECT * FROM chat_messages WHERE session_id = ?').all('session-1');
      expect(messages).toHaveLength(1);

      const markers = db.prepare(
        `SELECT * FROM session_attention_markers WHERE session_id = ? AND kind = 'reconciliation_checkin'`,
      ).all('session-1');
      expect(markers).toHaveLength(1);
    });

    it('processes multiple concurrent candidates independently', async () => {
      // Set up two idle task-mode sessions
      setupTaskSession({ sessionId: 'session-1', workspaceId: 'ws-1', taskId: 'task-1', acpSessionId: 'acp-1' });
      setupTaskSession({ sessionId: 'session-2', workspaceId: 'ws-2', taskId: 'task-2', acpSessionId: 'acp-2' });

      const mockDb = createMockD1(
        {
          'task-1': { task_mode: 'task', status: 'in_progress' },
          'task-2': { task_mode: 'task', status: 'in_progress' },
        },
        {
          'ws-1': { node_id: 'node-1', user_id: 'user-1' },
          'ws-2': { node_id: 'node-2', user_id: 'user-2' },
        },
      );
      const env = { DATABASE: mockDb } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const broadcastEvent = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, broadcastEvent);
      expect(processed).toBe(2);

      // Each session should have its own message and marker
      const msgs1 = db.prepare('SELECT * FROM chat_messages WHERE session_id = ?').all('session-1');
      const msgs2 = db.prepare('SELECT * FROM chat_messages WHERE session_id = ?').all('session-2');
      expect(msgs1).toHaveLength(1);
      expect(msgs2).toHaveLength(1);

      const markers = db.prepare(
        `SELECT * FROM session_attention_markers WHERE kind = 'reconciliation_checkin' AND resolved_at IS NULL`,
      ).all();
      expect(markers).toHaveLength(2);
    });

    it('does not create a visible check-in for an in-flight prompt below the hard threshold', async () => {
      const { cancelAgentSessionOnNode, sendPromptToAgentOnNode } = await import('../../../src/services/node-agent');
      setupTaskSession({ lastActivityAt: now - FIVE_MINUTES - 1000 });
      setSessionActivity({ promptStartedAt: now - THIRTY_MINUTES - 1000 });
      const env = {
        ...envWithRows(
          { 'task-1': { task_mode: 'task', status: 'in_progress' } },
          { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } },
        ),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as ProjectDataEnv;
      const broadcastEvent = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, broadcastEvent);

      expect(processed).toBe(1);
      expect(vi.mocked(sendPromptToAgentOnNode)).not.toHaveBeenCalled();
      expect(vi.mocked(cancelAgentSessionOnNode)).not.toHaveBeenCalled();
      expect(db.prepare('SELECT * FROM chat_messages WHERE session_id = ?').all('session-1')).toHaveLength(0);
      expect(db.prepare(`SELECT * FROM session_attention_markers WHERE kind = 'reconciliation_checkin'`).all()).toHaveLength(0);
      expect(db.prepare(
        `SELECT * FROM activity_events WHERE event_type = 'reconciliation.prompt_in_flight_observed'`,
      ).all()).toHaveLength(1);
    });

    it('requests prompt cancellation before creating any check-in marker for hard-stalled prompts', async () => {
      const { cancelAgentSessionOnNode, sendPromptToAgentOnNode } = await import('../../../src/services/node-agent');
      setupTaskSession({ lastActivityAt: now - FIVE_MINUTES - 1000 });
      setSessionActivity({ promptStartedAt: now - TWO_HOURS - 1000 });
      const env = {
        ...envWithRows(
          { 'task-1': { task_mode: 'task', status: 'in_progress' } },
          { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } },
        ),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as ProjectDataEnv;
      const broadcastEvent = vi.fn();

      const processed = await processReconciliationCandidates(sql, env, broadcastEvent);

      expect(processed).toBe(1);
      expect(vi.mocked(cancelAgentSessionOnNode)).toHaveBeenCalledWith(
        'node-1',
        'ws-1',
        'acp-1',
        expect.anything(),
        'user-1',
      );
      expect(vi.mocked(sendPromptToAgentOnNode)).not.toHaveBeenCalled();
      expect(db.prepare('SELECT * FROM chat_messages WHERE session_id = ?').all('session-1')).toHaveLength(0);
      expect(db.prepare(`SELECT * FROM session_attention_markers WHERE kind = 'reconciliation_checkin'`).all()).toHaveLength(0);
      expect(db.prepare(
        `SELECT * FROM activity_events WHERE event_type = 'reconciliation.prompt_cancel_requested'`,
      ).all()).toHaveLength(1);
    });

    it('repairs stale prompting mirror when the VM reports no prompt in flight during hard-stall cancel', async () => {
      const { cancelAgentSessionOnNode, sendPromptToAgentOnNode } = await import('../../../src/services/node-agent');
      vi.mocked(cancelAgentSessionOnNode).mockResolvedValueOnce({ success: false, status: 409 });
      setupTaskSession({ lastActivityAt: now - FIVE_MINUTES - 1000 });
      setSessionActivity({ promptStartedAt: now - TWO_HOURS - 1000 });
      const env = {
        ...envWithRows(
          { 'task-1': { task_mode: 'task', status: 'in_progress' } },
          { 'ws-1': { node_id: 'node-1', user_id: 'user-1' } },
        ),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as ProjectDataEnv;
      const broadcastEvent = vi.fn();

      const firstPass = await processReconciliationCandidates(sql, env, broadcastEvent);
      expect(firstPass).toBe(1);
      expect(vi.mocked(sendPromptToAgentOnNode)).not.toHaveBeenCalled();
      expect(db.prepare(`SELECT activity FROM session_state WHERE session_id = 'acp-1'`).get()).toMatchObject({
        activity: 'idle',
      });

      const secondPass = await processReconciliationCandidates(sql, env, broadcastEvent);
      expect(secondPass).toBe(1);
      expect(vi.mocked(sendPromptToAgentOnNode)).toHaveBeenCalledWith(
        'node-1',
        'ws-1',
        'acp-1',
        expect.stringContaining('continue working from where you left off'),
        expect.anything(),
        'user-1',
      );
    });
  });

  describe('computeReconciliationAlarmTime', () => {
    it('returns null when no task-mode sessions exist', () => {
      const env = { DATABASE: createMockD1() } as unknown as import('../../../src/durable-objects/project-data/types').Env;
      const time = computeReconciliationAlarmTime(sql, env);
      expect(time).toBeNull();
    });

    it('returns earliest activity + idle threshold for eligible sessions', () => {
      setupTaskSession({ lastActivityAt: now - 60000 }); // 1 minute ago
      const env = { DATABASE: createMockD1() } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const time = computeReconciliationAlarmTime(sql, env);
      expect(time).not.toBeNull();
      // Should fire at lastActivityAt + 5 minutes
      expect(time).toBe((now - 60000) + FIVE_MINUTES);
    });

    it('returns earliest activity + idle threshold when idle cleanup schedule is missing', () => {
      setupTaskSession({ lastActivityAt: now - 60000, withIdleCleanup: false });
      const env = { DATABASE: createMockD1() } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const time = computeReconciliationAlarmTime(sql, env);
      expect(time).toBe((now - 60000) + FIVE_MINUTES);
    });

    it('returns at least 10 seconds in the future', () => {
      // Activity was 10 minutes ago — alarm time would be in the past
      setupTaskSession({ lastActivityAt: now - 10 * 60 * 1000 });
      const env = { DATABASE: createMockD1() } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const time = computeReconciliationAlarmTime(sql, env);
      expect(time).not.toBeNull();
      expect(time!).toBeGreaterThanOrEqual(now + 10_000);
    });

    it('uses configurable minimum alarm delay from env', () => {
      setupTaskSession({ lastActivityAt: now - 10 * 60 * 1000 });
      const customDelayMs = 30_000;
      const env = {
        DATABASE: createMockD1(),
        TASK_RECONCILIATION_MIN_ALARM_DELAY_MS: String(customDelayMs),
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const time = computeReconciliationAlarmTime(sql, env);

      expect(time).toBe(now + customDelayMs);
    });

    it('excludes sessions with active markers from alarm calculation', () => {
      setupTaskSession();
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        expiresAt: now + ONE_MINUTE,
      });
      const env = { DATABASE: createMockD1() } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const time = computeReconciliationAlarmTime(sql, env);
      expect(time).toBeNull();
    });

    it('uses configurable idle threshold from env', () => {
      setupTaskSession({ lastActivityAt: now - 60000 }); // 1 minute ago
      const customIdleMs = 10 * 60 * 1000; // 10 minutes
      const env = {
        DATABASE: createMockD1(),
        TASK_RECONCILIATION_IDLE_MS: String(customIdleMs),
      } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const time = computeReconciliationAlarmTime(sql, env);
      expect(time).toBe((now - 60000) + customIdleMs);
    });

    it('schedules prompt-in-flight sessions at the soft threshold first', () => {
      setupTaskSession({ lastActivityAt: now - 10 * 60 * 1000 });
      setSessionActivity({ promptStartedAt: now - 10 * 60 * 1000 });
      const env = {
        DATABASE: createMockD1(),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as unknown as ProjectDataEnv;

      const time = computeReconciliationAlarmTime(sql, env);

      expect(time).toBe(now - 10 * 60 * 1000 + THIRTY_MINUTES);
    });

    it('schedules observed prompt-in-flight sessions at the hard threshold', () => {
      setupTaskSession({ lastActivityAt: now - 40 * 60 * 1000 });
      setSessionActivity({ promptStartedAt: now - 40 * 60 * 1000 });
      const env = {
        DATABASE: createMockD1(),
        TASK_RECONCILIATION_PROMPT_SOFT_STALL_MS: String(THIRTY_MINUTES),
        TASK_RECONCILIATION_PROMPT_HARD_STALL_MS: String(TWO_HOURS),
      } as unknown as ProjectDataEnv;

      const time = computeReconciliationAlarmTime(sql, env);

      expect(time).toBe(now - 40 * 60 * 1000 + TWO_HOURS);
    });
  });

  describe('computeProjectDataAlarmTime', () => {
    it('keeps reconciliation deadline ahead of healthy heartbeat timeout', () => {
      setupTaskSession({ lastActivityAt: now - 60000 }); // reconciliation due in 4 minutes
      setAcpHeartbeat('acp-1', now); // heartbeat timeout due in 5 minutes by default
      const env = { DATABASE: createMockD1() } as unknown as ProjectDataEnv;

      const time = computeProjectDataAlarmTime(sql, env);

      expect(time).toBe((now - 60000) + FIVE_MINUTES);
    });

    it('keeps workspace idle check ahead of healthy heartbeat timeout', () => {
      db.prepare(
        `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
         VALUES ('session-workspace', 'ws-workspace', NULL, 'Workspace', 'active', 0, ?, ?, ?)`,
      ).run(now - 600000, now - 600000, now - 600000);
      db.prepare(
        `INSERT INTO workspace_activity (workspace_id, session_id, last_message_at, last_terminal_activity_at, created_at)
         VALUES ('ws-workspace', 'session-workspace', ?, 0, ?)`,
      ).run(now - 4 * 60 * 1000, now - 4 * 60 * 1000);
      db.prepare(
        `INSERT INTO acp_sessions (id, chat_session_id, status, agent_type, workspace_id, node_id, last_heartbeat_at, created_at, updated_at)
         VALUES ('acp-workspace', 'session-workspace', 'running', 'claude_code', 'ws-workspace', 'node-1', ?, ?, ?)`,
      ).run(now, now - 600000, now - 600000);
      const env = { DATABASE: createMockD1() } as unknown as ProjectDataEnv;

      const time = computeProjectDataAlarmTime(sql, env);

      expect(time).toBe(now + 60_000);
    });
  });

  describe('Attention marker resolution on agent response', () => {
    it('agent message resolves reconciliation_checkin marker', () => {
      setupTaskSession();
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        expiresAt: now + ONE_MINUTE,
      });

      // Simulate: resolveAttentionMarkers is called when persistMessage role='user'
      // But actually, agent responses are role='assistant' — they reset idle cleanup
      // but don't resolve attention markers directly. The marker gets resolved when
      // complete_task or request_human_input is called (which creates a new marker or
      // completes the task), OR when a human message arrives.
      //
      // However, any activity (message persist) resets the idle cleanup timer,
      // which means the reconciliation won't fire again (no re-candidate).
      // The marker's 1-minute deadline is the safety net.

      // Verify marker exists
      const before = db.prepare(
        `SELECT * FROM session_attention_markers WHERE session_id = ? AND resolved_at IS NULL`,
      ).all('session-1');
      expect(before).toHaveLength(1);

      // Simulate agent message resolving markers
      const resolved = resolveAttentionMarkers(sql, 'session-1', 'msg-1', 'human', 'human_message');
      expect(resolved).toBe(1);

      const after = db.prepare(
        `SELECT * FROM session_attention_markers WHERE session_id = ? AND resolved_at IS NULL`,
      ).all('session-1');
      expect(after).toHaveLength(0);
    });
  });

  describe('Expired marker handling (expiry path)', () => {
    it('getExpiredMarkers returns reconciliation_checkin markers past their deadline', () => {
      setupTaskSession();
      // Create a reconciliation_checkin marker that has already expired
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        expiresAt: now - 1000, // expired 1 second ago
      });

      const expired = getExpiredMarkers(sql, now);
      expect(expired).toHaveLength(1);
      expect(expired[0].kind).toBe('reconciliation_checkin');
      expect(expired[0].taskId).toBe('task-1');
      expect(expired[0].workspaceId).toBe('ws-1');
      expect(expired[0].sessionId).toBe('session-1');
    });

    it('resolveAttentionMarkerById resolves expired reconciliation_checkin marker', () => {
      setupTaskSession();
      const marker = createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        expiresAt: now - 1000,
      });

      const resolved = resolveAttentionMarkerById(sql, marker.id, 'system', 'expired');
      expect(resolved).toBe(1);

      // Verify marker is now resolved
      const rows = db.prepare(
        `SELECT resolved_at, resolved_by_actor_type, resolved_reason
         FROM session_attention_markers WHERE id = ?`,
      ).all(marker.id);
      expect(rows).toHaveLength(1);
      expect((rows[0] as Record<string, unknown>).resolved_at).toBeTruthy();
      expect((rows[0] as Record<string, unknown>).resolved_by_actor_type).toBe('system');
      expect((rows[0] as Record<string, unknown>).resolved_reason).toBe('expired');
    });

    it('non-expired reconciliation_checkin marker is not returned by getExpiredMarkers', () => {
      setupTaskSession();
      createAttentionMarker(sql, {
        sessionId: 'session-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        kind: 'reconciliation_checkin',
        source: 'sam_orchestrator',
        expiresAt: now + ONE_MINUTE, // not yet expired
      });

      const expired = getExpiredMarkers(sql, now);
      expect(expired).toHaveLength(0);
    });
  });

  describe('Additional exclusion cases', () => {
    it('excludes cancelled tasks', async () => {
      setupTaskSession();
      const mockDb = createMockD1({
        'task-1': { task_mode: 'task', status: 'cancelled' },
      });
      const env = { DATABASE: mockDb } as unknown as import('../../../src/durable-objects/project-data/types').Env;

      const candidates = await getReconciliationCandidates(sql, env);
      expect(candidates).toHaveLength(0);
    });
  });
});
