import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Constitution XV: an agent's text never reaches another agent's chat as a plain message.
 * These tests drive the real handler and the real channel gate; only the ProjectData channel
 * write and the raw prompt-delivery surfaces are mocked, so a reintroduced raw path is caught.
 */
const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  enqueue: vi.fn(),
  sendPrompt: vi.fn(),
  channelSend: vi.fn(),
}));

vi.mock('../../../src/services/project-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/project-data')>()),
  acceptPromptDelivery: (...args: unknown[]) => mocks.accept(...args),
  enqueueMailboxMessage: (...args: unknown[]) => mocks.enqueue(...args),
}));
vi.mock('../../../src/services/node-agent', () => ({
  sendPromptToAgentOnNode: (...args: unknown[]) => mocks.sendPrompt(...args),
  stopAgentSessionOnNode: vi.fn(),
}));
vi.mock('../../../src/services/agent-message-channels', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/agent-message-channels')>()),
  sendAgentMessageOverChannel: (...args: unknown[]) => mocks.channelSend(...args),
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

function setup(overrides: Record<string, string> = {}): Env {
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
    PROJECT_EVENT_WAKE_ENABLED: 'true',
    AGENT_MESSAGE_CHANNELS_ENABLED: 'true',
    ...overrides,
  } as unknown as Env;
}

function expectNoRawDelivery() {
  expect(mocks.accept).not.toHaveBeenCalled();
  expect(mocks.enqueue).not.toHaveBeenCalled();
  expect(mocks.sendPrompt).not.toHaveBeenCalled();
}

function parse(response: { result?: unknown }) {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe('send_durable_message carries agent text only over the pair channel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.channelSend.mockResolvedValue({
      outcome: 'created',
      channel: { name: 'agent-dm.pair' },
      eventId: 'event-1',
      sequence: 1,
      recipientSubscriptionId: 'sub-recipient',
      senderSubscriptionId: 'sub-sender',
      retiredSubscriptionIds: [],
    });
  });

  it.each(['queue', 'steer'])(
    'sends a %s message over the channel, never into the recipient chat',
    async (deliveryIntent) => {
      const response = await handleSendDurableMessage(
        1,
        { targetTaskId: 'task-peer', message: 'the API moved to v2', deliveryIntent },
        caller,
        setup()
      );
      expect(response.error).toBeUndefined();
      expect(parse(response)).toMatchObject({
        transport: 'agent_message_channel',
        eventId: 'event-1',
        accepted: true,
        delivered: false,
      });
      expect(mocks.channelSend).toHaveBeenCalledTimes(1);
      expect(mocks.channelSend.mock.calls[0]![1]).toMatchObject({
        projectId: 'project-a',
        message: 'the API moved to v2',
        messageClass: 'deliver',
        recipient: { taskId: 'task-peer', chatSessionId: 'chat-task-peer' },
        actor: { taskId: 'task-caller', chatSessionId: 'chat-caller' },
      });
      expectNoRawDelivery();
    }
  );

  it.each(['interrupt', 'preempt_and_replan', 'shutdown_with_final_prompt'])(
    'sends an urgent %s message over the channel too',
    async (messageClass) => {
      const response = await handleSendDurableMessage(
        1,
        { targetTaskId: 'task-peer', message: 'stop pushing to main', messageClass },
        caller,
        setup()
      );
      expect(response.error).toBeUndefined();
      expect(mocks.channelSend.mock.calls[0]![1]).toMatchObject({ messageClass });
      expectNoRawDelivery();
    }
  );

  it.each([
    ['flag_off', { AGENT_MESSAGE_CHANNELS_ENABLED: 'false' }],
    ['project_event_wake_disabled', { PROJECT_EVENT_WAKE_ENABLED: 'false' }],
    ['durable_prompt_delivery_disabled', { DURABLE_PROMPT_DELIVERY_ENABLED: 'false' }],
  ] as const)('refuses the send when the channel is unavailable (%s)', async (reason, env) => {
    for (const messageClass of ['deliver', 'interrupt']) {
      const response = await handleSendDurableMessage(
        1,
        { targetTaskId: 'task-peer', message: 'x', messageClass },
        caller,
        setup(env)
      );
      expect(response.error?.message).toContain('Agent messaging is unavailable');
      expect(response.error?.data).toMatchObject({ outcome: 'unavailable', reason });
    }
    expect(mocks.channelSend).not.toHaveBeenCalled();
    expectNoRawDelivery();
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
      expect(mocks.channelSend).not.toHaveBeenCalled();
    }
  );

  it('rejects an unknown intent and a cross-project target', async () => {
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
    expect(mocks.channelSend).not.toHaveBeenCalled();
    expectNoRawDelivery();
  });
});
