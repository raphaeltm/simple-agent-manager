/**
 * A restored session's continuation prompt (`services/restored-session-prompt.ts`) can outlive
 * the wake that queued it: the handoff can fail after the prompt is queued and return the chat to
 * sleep. The real ProjectData delivery alarm then decides what the continuation may do. It may
 * wake the chat again only under its own task's guard, an ended task's continuation is dropped
 * without a misleading wake failure, and one that expires while the chat sleeps is reported.
 * Only the wake itself (`ensureSessionRecovery`) is a boundary.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { runMigrations } from '../../src/durable-objects/migrations';
import {
  type DurabilityFoundationHooks,
  processPromptDeliveryAlarm,
} from '../../src/durable-objects/project-data/durability-foundation';
import { acceptPromptDelivery } from '../../src/durable-objects/project-data/prompt-delivery';
import { WAKE_FAILED_ATTENTION_KIND } from '../../src/durable-objects/project-data/wake-failure';
import type { Env } from '../../src/env';
import { restoredSessionPromptDelivery } from '../../src/services/restored-session-prompt';
import { SESSION_RECOVERY_CONTINUE_TASK_PROMPT } from '../../src/services/session-sleep-fallback-messages';
import { createAllSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';
import { createSqlStorage } from '../unit/durable-objects/sql-storage-test-utils';

const recovery = vi.hoisted(() => ({ ensure: vi.fn(), report: vi.fn() }));
vi.mock('../../src/services/session-recovery', () => ({
  ensureSessionRecovery: recovery.ensure,
  reportSessionRecoveryRefusal: recovery.report,
}));

const PROJECT = 'project-1';
const CHAT = 'chat-1';
const TASK = 'task-1';
const TTL_MS = 10 * 60_000;
const START = new Date('2026-10-10T16:00:00.000Z');

describe('a checkpoint continuation that outlives its wake', () => {
  let d1: Database.Database;
  let doDb: Database.Database;
  let sql: SqlStorage;
  let env: Env;
  let hooks: DurabilityFoundationHooks;
  let deliveries: Promise<unknown>[];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(START);
    vi.clearAllMocks();
    d1 = new Database(':memory:');
    createAllSchemaTables(d1, schema);
    // The handoff failed after the prompt was queued and the chat went back to sleep.
    d1.exec(`
      INSERT INTO nodes (id, user_id, status, runtime) VALUES ('node-2', 'user-1', 'running', 'vm');
      INSERT INTO workspaces (id, node_id, project_id, user_id, chat_session_id, status, updated_at)
        VALUES ('workspace-2', 'node-2', '${PROJECT}', 'user-1', '${CHAT}', 'sleeping',
                '${START.toISOString()}');
      INSERT INTO session_snapshots
        (id, project_id, workspace_id, user_id, chat_session_id, runtime, status, degradation,
         sleep_status, recovery_attempts, sleep_attempts, created_at, updated_at)
        VALUES ('snapshot-1', '${PROJECT}', 'workspace-2', 'user-1', '${CHAT}', 'vm', 'available',
                'none', 'sleeping', 0, 0, '${START.toISOString()}', '${START.toISOString()}');
    `);
    doDb = new Database(':memory:');
    sql = createSqlStorage(doDb);
    runMigrations(sql);
    sql.exec(
      `INSERT INTO chat_sessions
        (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES (?, 'workspace-2', ?, 'Task', 'sleeping', 1, ?, ?, ?)`,
      CHAT,
      TASK,
      START.getTime(),
      START.getTime(),
      START.getTime()
    );
    env = {
      DATABASE: createSqliteD1(d1),
      DURABLE_PROMPT_DELIVERY_ENABLED: 'true',
    } as unknown as Env;
    recovery.ensure.mockResolvedValue({ status: 'waking', taskId: TASK });
    deliveries = [];
    hooks = {
      getProjectId: () => PROJECT,
      transactionSync: <T>(fn: () => T): T => doDb.transaction(fn)(),
      waitUntil: (promise) => {
        deliveries.push(promise);
      },
      recalculateAlarm: vi.fn(async () => undefined),
      scheduleSummarySync: vi.fn(),
      broadcastEvent: vi.fn(),
      armIdleCleanup: vi.fn(),
      nudgeDeliveries: vi.fn(() => 0),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    doDb.close();
    d1.close();
  });

  function seedTask(status: string) {
    d1.prepare(
      `INSERT INTO tasks (id, project_id, user_id, chat_session_id, workspace_id, status, task_mode)
       VALUES (?, ?, 'user-1', ?, 'workspace-2', ?, 'task')`
    ).run(TASK, PROJECT, CHAT, status);
  }

  /** Queue the delivery exactly as the TaskRunner's restored-session step builds it. */
  function queueContinuation() {
    hooks.transactionSync(() =>
      acceptPromptDelivery(
        sql,
        env as never,
        restoredSessionPromptDelivery(
          {
            projectId: PROJECT,
            chatSessionId: CHAT,
            taskId: TASK,
            agentSessionId: 'agent-2',
            prompt: SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
          },
          TTL_MS
        )
      )
    );
  }

  async function runDeliveryAlarm() {
    processPromptDeliveryAlarm(sql, env as never, hooks);
    await Promise.all(deliveries.splice(0));
  }

  const continuation = () =>
    doDb
      .prepare(
        `SELECT delivery_state AS state, terminal_reason AS terminalReason, last_error AS lastError
           FROM session_inbox WHERE source_kind = 'checkpoint_continuation'`
      )
      .get();
  const wakeFailures = () =>
    doDb
      .prepare('SELECT session_id AS sessionId FROM session_attention_markers WHERE kind = ?')
      .all(WAKE_FAILED_ATTENTION_KIND);

  it('wakes the chat again only under its own task guard', async () => {
    seedTask('sleeping');
    queueContinuation();

    await runDeliveryAlarm();

    expect(recovery.ensure).toHaveBeenCalledOnce();
    expect(recovery.ensure).toHaveBeenCalledWith(env, PROJECT, CHAT, {
      taskId: TASK,
      projectId: PROJECT,
      chatSessionId: CHAT,
    });
    expect(continuation()).toMatchObject({ state: 'retry_wait' });
  });

  it.each(['completed', 'failed', 'cancelled'])(
    'drops the continuation of a %s task without waking or reporting a wake failure',
    async (status) => {
      seedTask(status);
      queueContinuation();

      await runDeliveryAlarm();

      expect(recovery.ensure).not.toHaveBeenCalled();
      expect(continuation()).toMatchObject({
        state: 'failed',
        terminalReason: 'terminal_target',
        lastError: 'Checkpoint continuation task is no longer live for this chat',
      });
      expect(wakeFailures()).toEqual([]);
    }
  );

  it('reports a wake failure when it expires while the chat still sleeps', async () => {
    seedTask('sleeping');
    queueContinuation();
    vi.setSystemTime(START.getTime() + TTL_MS + 1);

    await runDeliveryAlarm();

    expect(continuation()).toMatchObject({ state: 'expired', terminalReason: 'ttl_expired' });
    expect(wakeFailures()).toEqual([{ sessionId: CHAT }]);
  });
});
