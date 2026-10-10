/**
 * A checkpoint continuation tells a restored task-mode agent to continue its task, and is
 * valid only while that task is live and owns the chat. The check is a SQL predicate
 * (`isSessionRecoverySourceTaskGuardValid`), so it runs against a real SQLite engine, and
 * every refusal has an owner control beside it (rule 28).
 */
import type { AgentMailboxMessage, PromptDeliverySource } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { invalidCheckpointContinuationTarget } from '../../../src/durable-objects/project-data/checkpoint-continuation-delivery';
import type { PromptDeliveryClaim } from '../../../src/durable-objects/project-data/prompt-delivery';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const PROJECT = 'project-1';
const CHAT = 'chat-1';
const TASK = 'task-1';

function claim(
  overrides: Partial<AgentMailboxMessage> = {},
  mode: PromptDeliveryClaim['mode'] = 'submit'
): PromptDeliveryClaim {
  const message = {
    id: 'checkpoint-continuation-agent-2',
    targetSessionId: CHAT,
    sourceTaskId: TASK,
    senderType: 'system',
    senderId: 'session-recovery',
    messageClass: 'deliver',
    deliveryState: 'delivering',
    content: 'Resume your assigned task from the persisted transcript.',
    metadata: null,
    ackRequired: false,
    ackTimeoutMs: null,
    deliveryAttempts: 1,
    lastDeliveryAt: null,
    expiresAt: null,
    createdAt: 1,
    deliveredAt: null,
    ackedAt: null,
    sourceKind: 'checkpoint_continuation',
    promptMessageId: 'checkpoint-continuation-agent-2',
    nextAttemptAt: null,
    lastError: null,
    terminalReason: null,
    attemptId: 'attempt-1',
    attemptStartedAt: 1,
    runtimeIdentity: 'runtime-1',
    receiptState: null,
    receiptRuntimeIdentity: null,
    receiptCheckedAt: null,
    acceptedAt: null,
    adapterProtocolVersion: null,
    receiptSupported: null,
    ...overrides,
  } satisfies AgentMailboxMessage;
  return { message, attemptId: 'attempt-1', mode };
}

describe('invalidCheckpointContinuationTarget', () => {
  let sqlite: Database.Database;
  let env: Env;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;
  });

  afterEach(() => sqlite.close());

  function seedTask(status: string, options: { projectId?: string; chatSessionId?: string } = {}) {
    sqlite
      .prepare(
        `INSERT INTO tasks
          (id, project_id, user_id, chat_session_id, title, status, priority, task_mode,
           dispatch_depth, triggered_by, created_by, created_at, updated_at)
         VALUES (?, ?, 'user-1', ?, 'Task', ?, 0, 'task', 0, 'mcp', 'user-1',
           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      )
      .run(TASK, options.projectId ?? PROJECT, options.chatSessionId ?? CHAT, status);
  }

  it.each(['delegated', 'in_progress'])('lets a %s task own its continuation', async (status) => {
    // `delegated` is the uncommitted wake: the VM handoff hold, not this check, keeps it waiting.
    seedTask(status);
    await expect(invalidCheckpointContinuationTarget(env, PROJECT, claim())).resolves.toBeNull();
  });

  it.each(['completed', 'failed', 'cancelled'])(
    'drops the continuation of a %s task as a terminal target',
    async (status) => {
      seedTask(status);
      await expect(invalidCheckpointContinuationTarget(env, PROJECT, claim())).resolves.toEqual({
        kind: 'failed',
        reason: 'terminal_target',
        error: 'Checkpoint continuation task is no longer live for this chat',
        runtimeIdentity: 'runtime-1',
        capabilities: null,
      });
    }
  );

  it('drops a continuation whose task no longer owns the chat, with an owner-path control', async () => {
    seedTask('in_progress', { chatSessionId: 'chat-other' });
    await expect(invalidCheckpointContinuationTarget(env, PROJECT, claim())).resolves.toMatchObject(
      {
        kind: 'failed',
        reason: 'terminal_target',
      }
    );
    await expect(
      invalidCheckpointContinuationTarget(env, PROJECT, claim({ targetSessionId: 'chat-other' }))
    ).resolves.toBeNull();
  });

  it('drops a continuation addressed through another project, with an owner-path control', async () => {
    seedTask('in_progress', { projectId: 'project-other' });
    await expect(invalidCheckpointContinuationTarget(env, PROJECT, claim())).resolves.toMatchObject(
      {
        kind: 'failed',
        reason: 'terminal_target',
      }
    );
    await expect(
      invalidCheckpointContinuationTarget(env, 'project-other', claim())
    ).resolves.toBeNull();
  });

  it('drops a continuation without a task or project identity', async () => {
    seedTask('in_progress');
    const missing = {
      kind: 'failed',
      reason: 'terminal_target',
      error: 'Checkpoint continuation has no task identity',
    };
    await expect(
      invalidCheckpointContinuationTarget(env, PROJECT, claim({ sourceTaskId: null }))
    ).resolves.toMatchObject(missing);
    await expect(invalidCheckpointContinuationTarget(env, null, claim())).resolves.toMatchObject(
      missing
    );
  });

  it.each<PromptDeliverySource>(['user_followup', 'agent_mailbox', 'parent_wakeup'])(
    'leaves a %s delivery to its own checks',
    async (sourceKind) => {
      seedTask('failed');
      await expect(
        invalidCheckpointContinuationTarget(env, PROJECT, claim({ sourceKind }))
      ).resolves.toBeNull();
    }
  );

  it('retries a submit and stays ambiguous during reconciliation when the task read fails', async () => {
    sqlite.close();
    sqlite = new Database(':memory:'); // no tables: the read throws
    env = { DATABASE: createSqliteD1(sqlite) } as unknown as Env;

    await expect(invalidCheckpointContinuationTarget(env, PROJECT, claim())).resolves.toMatchObject(
      {
        kind: 'retry',
        reason: 'not_ready',
        error: expect.stringContaining('Checkpoint continuation task check temporarily failed'),
      }
    );
    await expect(
      invalidCheckpointContinuationTarget(env, PROJECT, claim({}, 'reconcile'))
    ).resolves.toMatchObject({
      kind: 'ambiguous',
      reason: 'receipt_unavailable',
      receipt: null,
    });
  });
});
