import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  channel: vi.fn(),
}));

vi.mock('../../../src/services/project-data', () => ({
  acceptPromptDelivery: (...args: unknown[]) => mocks.accept(...args),
  enqueueMailboxMessage: vi.fn(),
  markMailboxMessageDelivered: vi.fn(),
}));
vi.mock('../../../src/services/node-agent', () => ({
  sendPromptToAgentOnNode: vi.fn(),
  stopAgentSessionOnNode: vi.fn(),
}));
vi.mock('../../../src/routes/mcp/agent-message-channel-send', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/routes/mcp/agent-message-channel-send')>()),
  trySendOverAgentMessageChannel: (...args: unknown[]) => mocks.channel(...args),
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleSendDurableMessage } from '../../../src/routes/mcp/mailbox-tools';
import type { McpTokenData } from '../../../src/services/mcp-token';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const caller: McpTokenData = {
  taskId: 'task-caller',
  projectId: 'project-a',
  userId: 'user-caller',
  workspaceId: 'workspace-caller',
  chatSessionId: 'chat-caller',
  createdAt: '2026-11-05T00:00:00.000Z',
};

function setup(): Env {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.tasks, schema.nodes, schema.workspaces, schema.agentSessions]);
  const now = '2026-11-05T00:00:00.000Z';
  const task = sqlite.prepare(
    `INSERT INTO tasks (id, project_id, user_id, status, workspace_id, title, created_by, created_at, updated_at)
     VALUES (?, ?, 'user-caller', 'in_progress', ?, 'task', 'user-caller', ?, ?)`
  );
  task.run('task-caller', 'project-a', 'workspace-caller', now, now);
  for (const [taskId, projectId] of [
    ['task-peer', 'project-a'],
    ['task-foreign', 'project-b'],
  ] as const) {
    sqlite
      .prepare(
        "INSERT INTO nodes (id, user_id, name, status) VALUES (?, 'user-caller', ?, 'running')"
      )
      .run(`node-${taskId}`, taskId);
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, node_id, project_id, user_id, name, repository, branch, vm_size, vm_location, chat_session_id)
         VALUES (?, ?, ?, 'user-caller', 'ws', 'o/r', 'main', 'small', 'nbg1', ?)`
      )
      .run(`ws-${taskId}`, `node-${taskId}`, projectId, `chat-${taskId}`);
    sqlite
      .prepare(
        `INSERT INTO agent_sessions (id, workspace_id, user_id, status, created_at, updated_at)
         VALUES (?, ?, 'user-caller', 'running', ?, ?)`
      )
      .run(`agent-${taskId}`, `ws-${taskId}`, now, now);
    task.run(taskId, projectId, `ws-${taskId}`, now, now);
  }
  return {
    DATABASE: createSqliteD1(sqlite),
    DURABLE_PROMPT_DELIVERY_ENABLED: 'true',
  } as unknown as Env;
}

describe('send_durable_message deliveryIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.channel.mockResolvedValue(null);
    mocks.accept.mockResolvedValue({
      message: { id: 'delivery-1', deliveryState: 'queued', deliveryIntent: 'steer' },
    });
  });

  it('steers a peer with provenance: an agent message, not the human, fenced as untrusted', async () => {
    const response = await handleSendDurableMessage(
      1,
      { targetTaskId: 'task-peer', message: 'the API moved to v2', deliveryIntent: 'steer' },
      caller,
      setup()
    );
    expect(response.error).toBeUndefined();
    const [, projectId, input] = mocks.accept.mock.calls[0]!;
    expect(projectId).toBe('project-a');
    expect(input).toMatchObject({
      targetSessionId: 'chat-task-peer',
      displayContent: 'the API moved to v2',
      deliveryIntent: 'steer',
      messageClass: 'deliver',
      senderType: 'agent',
    });
    expect(input.deliveryContent).toContain('[Agent message from task task-caller');
    expect(input.deliveryContent).toContain('not from the human');
    expect(input.deliveryContent).toContain('<<<\nthe API moved to v2\n>>>');
    // A steer needs the running turn, which only durable delivery reaches.
    expect(mocks.channel).not.toHaveBeenCalled();
  });

  it('keeps queued messages on the preview channel and raw', async () => {
    await handleSendDurableMessage(
      1,
      { targetTaskId: 'task-peer', message: 'fyi' },
      caller,
      setup()
    );
    expect(mocks.channel).toHaveBeenCalledTimes(1);
    expect(mocks.accept.mock.calls[0]![2]).toMatchObject({
      deliveryContent: 'fyi',
      deliveryIntent: 'queue',
    });
  });

  it.each(['interrupt', 'preempt_and_replan', 'shutdown_with_final_prompt'])(
    'never lets a steer become an interrupt (%s)',
    async (messageClass) => {
      const response = await handleSendDurableMessage(
        1,
        { targetTaskId: 'task-peer', message: 'x', messageClass, deliveryIntent: 'steer' },
        caller,
        setup()
      );
      expect(response.error?.message).toContain('requires messageClass "notify" or "deliver"');
      expect(mocks.accept).not.toHaveBeenCalled();
    }
  );

  it('rejects an unknown intent and a cross-project steer', async () => {
    expect(
      (
        await handleSendDurableMessage(
          1,
          { targetTaskId: 'task-peer', message: 'x', deliveryIntent: 'now' },
          caller,
          setup()
        )
      ).error?.message
    ).toContain('Invalid deliveryIntent');
    const foreign = await handleSendDurableMessage(
      1,
      { targetTaskId: 'task-foreign', message: 'x', deliveryIntent: 'steer' },
      caller,
      setup()
    );
    expect(foreign.error).toBeDefined();
    expect(mocks.accept).not.toHaveBeenCalled();
  });
});
