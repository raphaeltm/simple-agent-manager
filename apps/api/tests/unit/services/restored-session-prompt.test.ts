/**
 * Queueing the first prompt of a VM wake whose restore resumed the saved agent session.
 * The ProjectData service is wired to the body of the real `acceptPromptDelivery` RPC over a
 * migrated ProjectData SQLite database, so the inbox row, the transcript row, the accept
 * hooks and delivery-id idempotency are the production ones.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  acceptPromptDelivery,
  type DurabilityFoundationHooks,
} from '../../../src/durable-objects/project-data/durability-foundation';
import { persistMessage } from '../../../src/durable-objects/project-data/messages';
import type { Env } from '../../../src/env';
import {
  queueRestoredSessionPrompt,
  RESTORED_SESSION_PROMPT_SENDER_ID,
  RESTORED_SESSION_PROMPT_UNDELIVERABLE_NOTICE,
  restoredSessionPromptDeliveryId,
} from '../../../src/services/restored-session-prompt';
import { SESSION_RECOVERY_CONTINUE_TASK_PROMPT } from '../../../src/services/session-sleep-fallback-messages';
import { createSqlStorage } from '../durable-objects/sql-storage-test-utils';

const projectData = vi.hoisted(() => ({
  sql: null as SqlStorage | null,
  hooks: null as DurabilityFoundationHooks | null,
}));

vi.mock('../../../src/services/project-data', () => ({
  acceptPromptDelivery: vi.fn(async (env: Env, _projectId: string, input: never) =>
    acceptPromptDelivery(projectData.sql!, env as never, projectData.hooks!, input)
  ),
  persistMessage: vi.fn(
    async (
      env: Env,
      _projectId: string,
      sessionId: string,
      role: string,
      content: string,
      toolMetadata: string | null,
      messageId?: string
    ) =>
      persistMessage(
        projectData.sql!,
        env as never,
        sessionId,
        role,
        content,
        toolMetadata,
        messageId
      )
  ),
}));

const CHAT = 'chat-1';
const input = {
  projectId: 'project-1',
  chatSessionId: CHAT,
  taskId: 'task-1',
  agentSessionId: 'agent-2',
  prompt: SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
};

describe('queueRestoredSessionPrompt', () => {
  let db: Database.Database;
  let env: Env;

  beforeEach(() => {
    db = new Database(':memory:');
    projectData.sql = createSqlStorage(db);
    runMigrations(projectData.sql);
    projectData.hooks = {
      getProjectId: () => 'project-1',
      transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
      waitUntil: () => undefined,
      recalculateAlarm: vi.fn(async () => undefined),
      scheduleSummarySync: vi.fn(),
      broadcastEvent: vi.fn(),
      armIdleCleanup: vi.fn(),
      nudgeDeliveries: vi.fn(() => 0),
    };
    env = { DURABLE_PROMPT_DELIVERY_ENABLED: 'true', PROMPT_DELIVERY_TTL_MS: '600000' } as Env;
    // The chat as the wake commit leaves it: active on the replacement workspace.
    db.prepare(
      `INSERT INTO chat_sessions
        (id, workspace_id, task_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES (?, 'workspace-2', 'task-1', 'Task', 'active', 1, 1, 1, 1)`
    ).run(CHAT);
  });

  afterEach(() => db.close());

  const inbox = () =>
    db
      .prepare(
        `SELECT id, target_session_id, source_task_id, sender_type, sender_id, message_class,
                source_kind, content, delivery_state, expires_at, created_at
           FROM session_inbox`
      )
      .all() as Array<Record<string, unknown>>;
  const transcript = () =>
    db
      .prepare('SELECT id, role, content, tool_metadata FROM chat_messages WHERE session_id = ?')
      .all(CHAT) as Array<Record<string, unknown>>;

  it('queues the prompt as a durable system delivery bound to the waking task', async () => {
    await queueRestoredSessionPrompt(env, input);

    const deliveryId = restoredSessionPromptDeliveryId('agent-2');
    const [row] = inbox();
    expect(inbox()).toHaveLength(1);
    expect(row).toMatchObject({
      id: deliveryId,
      target_session_id: CHAT,
      source_task_id: 'task-1',
      sender_type: 'system',
      sender_id: RESTORED_SESSION_PROMPT_SENDER_ID,
      message_class: 'deliver',
      source_kind: 'checkpoint_continuation',
      content: SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
      delivery_state: 'queued',
    });
    expect(Number(row?.expires_at) - Number(row?.created_at)).toBe(600_000);
    const [message] = transcript();
    expect(transcript()).toHaveLength(1);
    expect(message).toMatchObject({
      id: deliveryId,
      content: SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
    });
    expect(JSON.parse(String(message?.tool_metadata))).toMatchObject({
      source: 'checkpoint_continuation',
      kind: 'durable_prompt_delivery',
      deliveryId,
    });
  });

  it('converges a retried wake step on the same delivery, while the next wake queues its own', async () => {
    await queueRestoredSessionPrompt(env, input);
    await queueRestoredSessionPrompt(env, input);
    expect(inbox()).toHaveLength(1);
    expect(transcript()).toHaveLength(1);

    await queueRestoredSessionPrompt(env, { ...input, agentSessionId: 'agent-3' });
    expect(inbox().map((row) => row.id)).toEqual([
      restoredSessionPromptDeliveryId('agent-2'),
      restoredSessionPromptDeliveryId('agent-3'),
    ]);
  });

  it('attributes the prompt to the workspace the chat points at, which is why the wake commit comes first', async () => {
    // Accepting a delivery records message activity for the chat's current workspace. Until
    // `wakeSessionForSnapshotRecovery` re-points the chat, that is the evicted workspace,
    // whose idle tracking eviction finalization already removed.
    await queueRestoredSessionPrompt(env, input);
    expect(db.prepare('SELECT workspace_id, session_id FROM workspace_activity').all()).toEqual([
      { workspace_id: 'workspace-2', session_id: CHAT },
    ]);
  });

  it('says so in the chat, once, when durable delivery is disabled', async () => {
    env = { DURABLE_PROMPT_DELIVERY_ENABLED: 'false' } as Env;
    await queueRestoredSessionPrompt(env, input);
    await queueRestoredSessionPrompt(env, input);

    expect(inbox()).toEqual([]);
    expect(transcript()).toEqual([
      expect.objectContaining({
        id: `${restoredSessionPromptDeliveryId('agent-2')}-undeliverable`,
        role: 'system',
        content: RESTORED_SESSION_PROMPT_UNDELIVERABLE_NOTICE,
      }),
    ]);
  });
});
