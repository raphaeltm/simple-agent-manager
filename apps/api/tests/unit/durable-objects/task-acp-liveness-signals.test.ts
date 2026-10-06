/**
 * The ProjectData reader behind task-runtime liveness, on a real migrated SQLite
 * store with the real activity writer (`.claude/rules/28`, `/62`).
 *
 * `sessionWork` (a verdict input) and `workEvidence` (a description) both come
 * from one per-row classification. A chat can hold several assigned/running ACP
 * sessions (forks, restarts). These tests pin which one counts: the newest
 * session with positive work, scanning past newer sessions that are idle or
 * unproven, exactly as the reader did before the evidence refactor.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import { upsertActivityState } from '../../../src/durable-objects/project-data/session-state';
import { readTaskAcpLivenessSignals } from '../../../src/durable-objects/project-data/task-acp-liveness-signals';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { createSqlStorage } from './sql-storage-test-utils';

const CHAT_SESSION_ID = 'chat-1';
const WORKSPACE_ID = 'workspace-1';
const NOW = Date.parse('2026-10-04T07:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let sql: SqlStorage;

function seedAcpSession(id: string, startedAt: number, workspaceId = WORKSPACE_ID): void {
  sql.exec(
    `INSERT INTO acp_sessions (id, chat_session_id, workspace_id, node_id, status, agent_type,
                               last_heartbeat_at, created_at, updated_at, started_at)
     VALUES (?, ?, ?, 'node-1', 'running', 'claude-code', ?, ?, ?, ?)`,
    id,
    CHAT_SESSION_ID,
    workspaceId,
    NOW - 20_000,
    startedAt,
    NOW - 20_000,
    startedAt
  );
}

function read() {
  return readTaskAcpLivenessSignals(sql, {} as Env, {
    chatSessionId: CHAT_SESSION_ID,
    workspaceId: WORKSPACE_ID,
    limit: 5,
    nowMs: NOW,
  });
}

beforeEach(() => {
  sql = createSqlStorage(new Database(':memory:'));
  runMigrations(sql);
  sql.exec(
    `INSERT INTO chat_sessions (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
     VALUES (?, ?, 'task-1', 'Task', 'active', 0, ?, ?, ?)`,
    CHAT_SESSION_ID,
    WORKSPACE_ID,
    NOW - 10 * HOUR,
    NOW - 10 * HOUR,
    NOW
  );
});

describe('readTaskAcpLivenessSignals — several ACP sessions on one chat', () => {
  it('scans past a newer unproven turn to the older session with fresh tool work', () => {
    seedAcpSession('acp-old', NOW - 5 * HOUR);
    seedAcpSession('acp-new', NOW - HOUR);
    // Newest: a prompt turn that has reported nothing for 40 minutes.
    upsertActivityState(sql, 'acp-new', {
      activity: 'prompting',
      observedAt: NOW - 40 * MINUTE,
      now: NOW - 40 * MINUTE,
    });
    // Older: idle turn, but harness work reported a minute ago.
    upsertActivityState(sql, 'acp-old', {
      activity: 'idle',
      observedAt: NOW - MINUTE,
      now: NOW - MINUTE,
      runtimeWorkState: 'active',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude-background-tasks',
      runtimeWorkProgressAt: NOW - MINUTE,
    });

    const signals = read();

    expect(signals.sessionWork).toEqual({
      active: true,
      activeAcpSessionId: 'acp-old',
      reason: 'task_runtime_work_active',
    });
    // Evidence describes every session, newest first, each in its own state.
    expect(signals.workEvidence?.map((entry) => [entry.acpSessionId, entry.state])).toEqual([
      ['acp-new', 'prompt_turn_unproven'],
      ['acp-old', 'runtime_work_active'],
    ]);
  });

  it('prefers the newest session when more than one has positive work', () => {
    seedAcpSession('acp-old', NOW - 5 * HOUR);
    seedAcpSession('acp-new', NOW - HOUR);
    for (const id of ['acp-old', 'acp-new']) {
      upsertActivityState(sql, id, {
        activity: 'prompting',
        observedAt: NOW - MINUTE,
        now: NOW - MINUTE,
      });
    }

    expect(read().sessionWork).toEqual({
      active: true,
      activeAcpSessionId: 'acp-new',
      reason: 'task_prompt_turn_active',
    });
  });

  it('reports no work, but still describes the sessions, when none is working', () => {
    seedAcpSession('acp-old', NOW - 5 * HOUR);
    seedAcpSession('acp-new', NOW - HOUR);
    upsertActivityState(sql, 'acp-new', {
      activity: 'idle',
      observedAt: NOW - 2 * HOUR,
      now: NOW - 2 * HOUR,
    });

    const signals = read();

    expect(signals.sessionWork).toBeNull();
    expect(signals.workEvidence?.map((entry) => [entry.acpSessionId, entry.state])).toEqual([
      ['acp-new', 'idle'],
      // No session_state row: unknown, never assumed idle.
      ['acp-old', 'unknown'],
    ]);
  });

  it('ignores an ACP session bound to another workspace generation', () => {
    seedAcpSession('acp-elsewhere', NOW - HOUR, 'previous-workspace');
    upsertActivityState(sql, 'acp-elsewhere', {
      activity: 'prompting',
      observedAt: NOW - MINUTE,
      now: NOW - MINUTE,
    });

    const signals = read();

    expect(signals.sessionWork).toBeNull();
    expect(signals.workEvidence).toEqual([]);
    // Liveness: the session is still listed for the chat, just not as work here.
    expect(signals.sessions.map((session) => session.id)).toEqual(['acp-elsewhere']);
  });
});
