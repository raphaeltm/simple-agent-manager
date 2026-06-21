/**
 * Integration coverage for the task-mode lifecycle watchdog.
 *
 * These tests intentionally run several ProjectData modules together against
 * real SQLite storage: messages, idle cleanup, attention markers, and
 * reconciliation. D1 and VM-agent delivery stay mocked because they cross
 * service boundaries, but time and message flow are simulated end to end.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../src/durable-objects/migrations';
import { updateMessageActivity } from '../../src/durable-objects/project-data/activity';
import {
  createAttentionMarker,
  getExpiredMarkers,
  resolveAttentionMarkerById,
  resolveAttentionMarkers,
  resolveAttentionMarkersByKind,
} from '../../src/durable-objects/project-data/attention';
import { resetIdleCleanup, scheduleIdleCleanup, stopWorkspaceInD1 } from '../../src/durable-objects/project-data/idle-cleanup';
import { persistMessage } from '../../src/durable-objects/project-data/messages';
import {
  getReconciliationCandidates,
  processReconciliationCandidates,
} from '../../src/durable-objects/project-data/reconciliation';
import { failSession } from '../../src/durable-objects/project-data/sessions';
import type { Env } from '../../src/durable-objects/project-data/types';
import { sendPromptToAgentOnNode } from '../../src/services/node-agent';

vi.mock('../../src/services/node-agent', () => ({
  sendPromptToAgentOnNode: vi.fn().mockResolvedValue(undefined),
}));

type TaskRow = { task_mode: string; status: string; error?: string | null };
type WorkspaceRow = { node_id: string | null; user_id: string; status: string };

function createSqlStorage(db: Database.Database): SqlStorage {
  return {
    exec(query: string, ...params: unknown[]) {
      const trimmed = query.trim().toUpperCase();
      const isSelect = trimmed.startsWith('SELECT') || trimmed.startsWith('WITH');

      if (isSelect) {
        const rows = params.length > 0 ? db.prepare(query).all(...params) : db.prepare(query).all();
        return { toArray: () => rows, rowsWritten: 0 };
      }

      if (params.length === 0) {
        db.exec(query);
        return { toArray: () => [], rowsWritten: 0 };
      }

      const result = db.prepare(query).run(...params);
      return { toArray: () => [], rowsWritten: result.changes };
    },
  } as unknown as SqlStorage;
}

function createMockD1(
  tasks: Record<string, TaskRow>,
  workspaces: Record<string, WorkspaceRow>,
): D1Database {
  return {
    prepare: vi.fn().mockImplementation((query: string) => ({
      bind: vi.fn().mockImplementation((...args: unknown[]) => ({
        first: vi.fn().mockImplementation(async () => {
          if (query.includes('FROM tasks')) {
            return tasks[args[0] as string] ?? null;
          }
          if (query.includes('FROM workspaces')) {
            return workspaces[args[0] as string] ?? null;
          }
          return null;
        }),
        run: vi.fn().mockImplementation(async () => {
          if (query.includes("UPDATE tasks SET status = 'failed'")) {
            const error = args[0] as string;
            const taskId = args[1] as string;
            if (tasks[taskId] && ['in_progress', 'delegated'].includes(tasks[taskId].status)) {
              tasks[taskId].status = 'failed';
              tasks[taskId].error = error;
            }
          }
          if (query.includes("UPDATE workspaces SET status = 'stopped'")) {
            const workspaceId = args[1] as string;
            if (workspaces[workspaceId] && ['running', 'recovery'].includes(workspaces[workspaceId].status)) {
              workspaces[workspaceId].status = 'stopped';
            }
          }
          return { success: true };
        }),
      })),
    })),
  } as unknown as D1Database;
}

const FIVE_MINUTES = 5 * 60 * 1000;
const ONE_MINUTE = 60 * 1000;
const TWO_HOURS = 2 * 60 * 60 * 1000;
const START = new Date('2026-05-13T12:00:00.000Z').getTime();

describe('agent lifecycle orchestration integration', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  let tasks: Record<string, TaskRow>;
  let workspaces: Record<string, WorkspaceRow>;
  let env: Env;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    tasks = { 'task-1': { task_mode: 'task', status: 'in_progress' } };
    workspaces = { 'ws-1': { node_id: 'node-1', user_id: 'user-1', status: 'running' } };
    env = {
      DATABASE: createMockD1(tasks, workspaces),
      MAX_MESSAGES_PER_SESSION: '100000',
      TASK_RECONCILIATION_IDLE_MS: String(FIVE_MINUTES),
      TASK_RECONCILIATION_RESPONSE_DEADLINE_MS: String(ONE_MINUTE),
    } as unknown as Env;
    vi.mocked(sendPromptToAgentOnNode).mockClear();
  });

  afterEach(() => {
    db.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createRunningTaskSession(): void {
    sql.exec(
      `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES ('session-1', 'ws-1', 'task-1', 'Lifecycle test', 'active', 0, ?, ?, ?)`,
      START,
      START,
      START,
    );
    sql.exec(
      `INSERT INTO workspace_activity (workspace_id, session_id, last_message_at, last_terminal_activity_at, created_at)
       VALUES ('ws-1', 'session-1', ?, 0, ?)`,
      START,
      START,
    );
    sql.exec(
      `INSERT INTO acp_sessions (id, chat_session_id, workspace_id, status, agent_type, created_at, updated_at)
       VALUES ('acp-1', 'session-1', 'ws-1', 'running', 'claude_code', ?, ?)`,
      START,
      START,
    );
    scheduleIdleCleanup(sql, env, 'session-1', 'ws-1', 'task-1');
  }

  function persistProjectMessage(role: string, content: string): string {
    const result = persistMessage(sql, env, 'session-1', role, content, null);
    resetIdleCleanup(sql, env, 'session-1');

    if (role === 'user') {
      resolveAttentionMarkers(sql, 'session-1', result.id, 'human', 'human_message');
    } else if (role === 'assistant') {
      resolveAttentionMarkersByKind(
        sql,
        'session-1',
        'reconciliation_checkin',
        result.id,
        'agent',
        'agent_message',
      );
    }

    if (result.workspaceId) updateMessageActivity(sql, result.workspaceId, 'session-1');
    return result.id;
  }

  async function expireMarkerLikeProjectDataAlarm(kind: 'needs_input' | 'reconciliation_checkin'): Promise<void> {
    const [marker] = getExpiredMarkers(sql);
    expect(marker?.kind).toBe(kind);

    resolveAttentionMarkerById(sql, marker.id, 'system', 'expired');
    const errorMessage = kind === 'reconciliation_checkin'
      ? 'Agent became unresponsive after SAM check-in'
      : 'Human input request expired after timeout';

    await env.DATABASE.prepare(
      `UPDATE tasks SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('in_progress', 'delegated')`,
    ).bind(errorMessage, marker.taskId).run();
    expect(marker.workspaceId).toBeTypeOf('string');
    if (!marker.workspaceId) {
      throw new Error('Expected expired marker to include workspaceId');
    }
    await stopWorkspaceInD1(env.DATABASE, marker.workspaceId);
    failSession(sql, marker.sessionId);
  }

  it('sends one visible SAM check-in after task silence, then clears it on assistant response', async () => {
    createRunningTaskSession();

    vi.advanceTimersByTime(FIVE_MINUTES + 1);

    const processed = await processReconciliationCandidates(sql, env, () => {});

    expect(processed).toBe(1);
    expect(sendPromptToAgentOnNode).toHaveBeenCalledWith(
      'node-1',
      'ws-1',
      'acp-1',
      expect.stringContaining('continue working from where you left off'),
      expect.anything(),
      'user-1',
    );
    expect(db.prepare(`SELECT role, content, tool_metadata FROM chat_messages`).all()).toMatchObject([
      {
        role: 'user',
        content: expect.stringContaining('Do not stop after the update'),
        tool_metadata: JSON.stringify({ source: 'sam_orchestrator', kind: 'reconciliation_checkin' }),
      },
    ]);

    const checkinsBeforeReply = sql.exec(
      `SELECT kind, expires_at FROM session_attention_markers WHERE resolved_at IS NULL`,
    ).toArray();
    expect(checkinsBeforeReply).toHaveLength(1);
    expect(checkinsBeforeReply[0].kind).toBe('reconciliation_checkin');
    expect(checkinsBeforeReply[0].expires_at).toBe(START + FIVE_MINUTES + 1 + ONE_MINUTE);

    vi.advanceTimersByTime(30_000);
    persistProjectMessage('assistant', 'Still working; I am investigating the failing test.');

    expect(sql.exec(`SELECT * FROM session_attention_markers WHERE resolved_at IS NULL`).toArray()).toHaveLength(0);
    expect(tasks['task-1'].status).toBe('in_progress');

    vi.advanceTimersByTime(FIVE_MINUTES + 1);
    const processedAgain = await processReconciliationCandidates(sql, env, () => {});
    expect(processedAgain).toBe(1);
    expect(sendPromptToAgentOnNode).toHaveBeenCalledTimes(2);
  });

  it('does not clear human-input attention when the agent sends more assistant output', async () => {
    createRunningTaskSession();
    createAttentionMarker(sql, {
      sessionId: 'session-1',
      taskId: 'task-1',
      workspaceId: 'ws-1',
      kind: 'needs_input',
      source: 'request_human_input',
      reason: 'Need a product decision',
      expiresAt: START + TWO_HOURS,
    });

    vi.advanceTimersByTime(FIVE_MINUTES + 1);

    expect(await getReconciliationCandidates(sql, env)).toHaveLength(0);

    persistProjectMessage('assistant', 'I found more context, but still need your decision.');

    const markers = sql.exec(
      `SELECT kind, resolved_at FROM session_attention_markers WHERE session_id = 'session-1'`,
    ).toArray();
    expect(markers).toMatchObject([{ kind: 'needs_input', resolved_at: null }]);
    expect(await getReconciliationCandidates(sql, env)).toHaveLength(0);
  });

  it('resumes reconciliation after the human answers a needs_input marker and silence returns', async () => {
    createRunningTaskSession();
    createAttentionMarker(sql, {
      sessionId: 'session-1',
      taskId: 'task-1',
      workspaceId: 'ws-1',
      kind: 'needs_input',
      source: 'request_human_input',
      reason: 'Approve deployment?',
      expiresAt: START + TWO_HOURS,
    });

    vi.advanceTimersByTime(FIVE_MINUTES + 1);
    expect(await processReconciliationCandidates(sql, env, () => {})).toBe(0);

    persistProjectMessage('user', 'Approved. Continue.');
    expect(sql.exec(`SELECT * FROM session_attention_markers WHERE resolved_at IS NULL`).toArray()).toHaveLength(0);

    vi.advanceTimersByTime(FIVE_MINUTES + 1);
    expect(await processReconciliationCandidates(sql, env, () => {})).toBe(1);
  });

  it('fails and stops a task workspace when a SAM check-in deadline expires without response', async () => {
    createRunningTaskSession();
    vi.advanceTimersByTime(FIVE_MINUTES + 1);
    expect(await processReconciliationCandidates(sql, env, () => {})).toBe(1);

    vi.advanceTimersByTime(ONE_MINUTE + 1);
    await expireMarkerLikeProjectDataAlarm('reconciliation_checkin');

    expect(tasks['task-1']).toMatchObject({
      status: 'failed',
      error: 'Agent became unresponsive after SAM check-in',
    });
    expect(workspaces['ws-1'].status).toBe('stopped');
    expect(sql.exec(`SELECT status FROM chat_sessions WHERE id = 'session-1'`).toArray()).toMatchObject([
      { status: 'failed' },
    ]);
    expect(sql.exec(`SELECT resolved_reason FROM session_attention_markers`).toArray()).toMatchObject([
      { resolved_reason: 'expired' },
    ]);
  });

  it('expires unanswered human input after two hours and cleans up without a reconciliation check-in', async () => {
    createRunningTaskSession();
    createAttentionMarker(sql, {
      sessionId: 'session-1',
      taskId: 'task-1',
      workspaceId: 'ws-1',
      kind: 'needs_input',
      source: 'request_human_input',
      reason: 'Need secrets configured',
      expiresAt: START + TWO_HOURS,
    });

    vi.advanceTimersByTime(TWO_HOURS + 1);
    expect(await processReconciliationCandidates(sql, env, () => {})).toBe(0);
    await expireMarkerLikeProjectDataAlarm('needs_input');

    expect(tasks['task-1']).toMatchObject({
      status: 'failed',
      error: 'Human input request expired after timeout',
    });
    expect(workspaces['ws-1'].status).toBe('stopped');
    expect(sql.exec(`SELECT status FROM chat_sessions WHERE id = 'session-1'`).toArray()).toMatchObject([
      { status: 'failed' },
    ]);
    expect(sendPromptToAgentOnNode).not.toHaveBeenCalled();
  });
});
