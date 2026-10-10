/**
 * A checkpoint continuation tells a restored task-mode agent to continue its task. It is valid
 * only while it is the chat's latest continuation and its task is live and owns the chat. Both
 * checks are SQL predicates, so they run against real SQLite: the ProjectData inbox holding
 * continuations queued by the production builder, and D1 holding the task. Every refusal has an
 * owner control beside it (rule 28).
 */
import type { PromptDeliverySource } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { runMigrations } from '../../../src/durable-objects/migrations';
import { invalidCheckpointContinuationTarget } from '../../../src/durable-objects/project-data/checkpoint-continuation-delivery';
import { getMessage } from '../../../src/durable-objects/project-data/mailbox';
import {
  acceptPromptDelivery,
  type PromptDeliveryClaim,
} from '../../../src/durable-objects/project-data/prompt-delivery';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { restoredSessionPromptDelivery } from '../../../src/services/restored-session-prompt';
import { SESSION_RECOVERY_CONTINUE_TASK_PROMPT } from '../../../src/services/session-sleep-fallback-messages';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
import { createSqlStorage } from './sql-storage-test-utils';

const PROJECT = 'project-1';
const CHAT = 'chat-1';
const TASK = 'task-1';
const TTL_MS = 60 * 60 * 1000;

describe('invalidCheckpointContinuationTarget', () => {
  let d1: Database.Database;
  let doDb: Database.Database;
  let sql: SqlStorage;
  let env: Env;

  beforeEach(() => {
    d1 = new Database(':memory:');
    createAllSchemaTables(d1, schema);
    doDb = new Database(':memory:');
    sql = createSqlStorage(doDb);
    runMigrations(sql);
    sql.exec(
      `INSERT INTO chat_sessions
        (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES (?, 'workspace-2', ?, 'Task', 'active', 1, 1, 1, 1)`,
      CHAT,
      TASK
    );
    env = { DATABASE: createSqliteD1(d1) } as unknown as Env;
  });

  afterEach(() => {
    doDb.close();
    d1.close();
  });

  function seedTask(status: string, options: { projectId?: string; chatSessionId?: string } = {}) {
    d1.prepare(
      `INSERT INTO tasks
        (id, project_id, user_id, chat_session_id, title, status, priority, task_mode,
         dispatch_depth, triggered_by, created_by, created_at, updated_at)
       VALUES (?, ?, 'user-1', ?, 'Task', ?, 0, 'task', 0, 'mcp', 'user-1',
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(TASK, options.projectId ?? PROJECT, options.chatSessionId ?? CHAT, status);
  }

  /** Queue a continuation exactly as the TaskRunner does for the session a wake restored. */
  function queueContinuation(agentSessionId: string, at: number, chatSessionId = CHAT): string {
    const delivery = restoredSessionPromptDelivery(
      {
        projectId: PROJECT,
        chatSessionId,
        taskId: TASK,
        agentSessionId,
        prompt: SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
      },
      TTL_MS
    );
    return acceptPromptDelivery(sql, {} as Env, delivery, at).message.id;
  }

  function claimFor(
    deliveryId: string,
    mode: PromptDeliveryClaim['mode'] = 'submit'
  ): PromptDeliveryClaim {
    const message = getMessage(sql, deliveryId);
    if (!message) throw new Error(`No queued delivery ${deliveryId}`);
    return { message, attemptId: 'attempt-1', mode };
  }

  const validate = (claim: PromptDeliveryClaim, projectId: string | null = PROJECT) =>
    invalidCheckpointContinuationTarget(sql, env, projectId, claim);

  it.each(['delegated', 'in_progress'])('lets a %s task own its continuation', async (status) => {
    // `delegated` is the uncommitted wake: the VM handoff hold, not this check, keeps it waiting.
    seedTask(status);
    await expect(validate(claimFor(queueContinuation('agent-2', 1_000)))).resolves.toBeNull();
  });

  it.each(['completed', 'failed', 'cancelled'])(
    'drops the continuation of a %s task as a terminal target',
    async (status) => {
      seedTask(status);
      await expect(validate(claimFor(queueContinuation('agent-2', 1_000)))).resolves.toEqual({
        kind: 'failed',
        reason: 'terminal_target',
        error: 'Checkpoint continuation task is no longer live for this chat',
        runtimeIdentity: null,
        capabilities: null,
      });
    }
  );

  it('drops a continuation whose task no longer owns the chat, with an owner-path control', async () => {
    seedTask('in_progress', { chatSessionId: 'chat-other' });
    sql.exec(
      `INSERT INTO chat_sessions
        (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES ('chat-other', 'workspace-3', ?, 'Task', 'active', 1, 1, 1, 1)`,
      TASK
    );
    await expect(validate(claimFor(queueContinuation('agent-2', 1_000)))).resolves.toMatchObject({
      kind: 'failed',
      reason: 'terminal_target',
    });
    await expect(
      validate(claimFor(queueContinuation('agent-3', 1_000, 'chat-other')))
    ).resolves.toBeNull();
  });

  it('drops a continuation addressed through another project, with an owner-path control', async () => {
    seedTask('in_progress', { projectId: 'project-other' });
    const claim = claimFor(queueContinuation('agent-2', 1_000));
    await expect(validate(claim)).resolves.toMatchObject({
      kind: 'failed',
      reason: 'terminal_target',
    });
    await expect(validate(claim, 'project-other')).resolves.toBeNull();
  });

  it('drops a continuation a later wake superseded, and keeps the later one', async () => {
    seedTask('in_progress');
    const earlier = queueContinuation('agent-2', 1_000);
    const later = queueContinuation('agent-3', 2_000);

    await expect(validate(claimFor(earlier))).resolves.toMatchObject({
      kind: 'failed',
      reason: 'terminal_target',
      error: 'Checkpoint continuation was superseded by a later wake',
    });
    await expect(validate(claimFor(later))).resolves.toBeNull();
  });

  it('is not superseded by an earlier continuation that already went out', async () => {
    seedTask('in_progress');
    const earlier = queueContinuation('agent-2', 1_000);
    sql.exec("UPDATE session_inbox SET delivery_state = 'acked' WHERE id = ?", earlier);
    const later = queueContinuation('agent-3', 2_000);

    await expect(validate(claimFor(later))).resolves.toBeNull();
  });

  it('drops a continuation without a task or project identity', async () => {
    seedTask('in_progress');
    const claim = claimFor(queueContinuation('agent-2', 1_000));
    const missing = {
      kind: 'failed',
      reason: 'terminal_target',
      error: 'Checkpoint continuation has no task identity',
    };
    await expect(
      validate({ ...claim, message: { ...claim.message, sourceTaskId: null } })
    ).resolves.toMatchObject(missing);
    await expect(validate(claim, null)).resolves.toMatchObject(missing);
  });

  it.each<PromptDeliverySource>(['user_followup', 'agent_mailbox', 'parent_wakeup'])(
    'leaves a %s delivery to its own checks',
    async (sourceKind) => {
      seedTask('failed');
      const claim = claimFor(queueContinuation('agent-2', 1_000));
      await expect(
        validate({ ...claim, message: { ...claim.message, sourceKind } })
      ).resolves.toBeNull();
    }
  );

  it('retries a submit and stays ambiguous during reconciliation when the task read fails', async () => {
    const claim = claimFor(queueContinuation('agent-2', 1_000));
    d1.close();
    d1 = new Database(':memory:'); // no tables: the task read throws
    env = { DATABASE: createSqliteD1(d1) } as unknown as Env;

    await expect(validate(claim)).resolves.toMatchObject({
      kind: 'retry',
      reason: 'not_ready',
      error: expect.stringContaining('Checkpoint continuation task check temporarily failed'),
    });
    await expect(validate({ ...claim, mode: 'reconcile' })).resolves.toMatchObject({
      kind: 'ambiguous',
      reason: 'receipt_unavailable',
      receipt: null,
    });
  });
});
