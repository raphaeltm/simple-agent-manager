import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSendPromptToAgentOnNode = vi.hoisted(() => vi.fn());
const mockPersistOrchestrationPrompt = vi.hoisted(() => vi.fn());
const mockAcceptPromptDelivery = vi.hoisted(() => vi.fn());
const mockEnqueueMailboxMessage = vi.hoisted(() => vi.fn());
const mockMarkMailboxMessageDelivered = vi.hoisted(() => vi.fn());

vi.mock('../../../src/services/node-agent', () => ({
  sendPromptToAgentOnNode: (...args: unknown[]) => mockSendPromptToAgentOnNode(...args),
  stopAgentSessionOnNode: vi.fn(),
}));

vi.mock('../../../src/services/orchestration-prompts', () => ({
  persistOrchestrationPrompt: (...args: unknown[]) => mockPersistOrchestrationPrompt(...args),
}));

vi.mock('../../../src/services/project-data', () => ({
  acceptPromptDelivery: (...args: unknown[]) => mockAcceptPromptDelivery(...args),
  enqueueMailboxMessage: (...args: unknown[]) => mockEnqueueMailboxMessage(...args),
  markMailboxMessageDelivered: (...args: unknown[]) => mockMarkMailboxMessageDelivered(...args),
}));

vi.mock('../../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResources: vi.fn(),
}));

vi.mock('../../../src/services/trigger-execution-sync', () => ({
  syncTriggerExecutionStatus: vi.fn(),
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleSendDurableMessage } from '../../../src/routes/mcp/mailbox-tools';
import { handleSendMessageToSubtask } from '../../../src/routes/mcp/orchestration-comms';
import type { McpTokenData } from '../../../src/services/mcp-token';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const callerToken: McpTokenData = {
  taskId: 'task-caller',
  projectId: 'project-a',
  userId: 'user-caller',
  workspaceId: 'workspace-caller',
  chatSessionId: 'chat-caller',
  createdAt: '2026-08-24T00:00:00.000Z',
};

function insertTask(
  sqlite: Database.Database,
  task: {
    id: string;
    projectId: string;
    status: string;
    parentTaskId?: string | null;
    workspaceId?: string | null;
    userId?: string;
  }
) {
  sqlite
    .prepare(
      `INSERT INTO tasks
        (id, project_id, user_id, status, parent_task_id, workspace_id, title, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      task.id,
      task.projectId,
      task.userId ?? 'user-caller',
      task.status,
      task.parentTaskId ?? null,
      task.workspaceId ?? null,
      `Task ${task.id}`,
      task.userId ?? 'user-caller',
      '2026-08-24T00:00:00.000Z',
      '2026-08-24T00:00:00.000Z'
    );
}

function insertActiveAgent(
  sqlite: Database.Database,
  input: {
    taskId: string;
    projectId: string;
    workspaceId: string;
    chatSessionId: string;
    nodeId: string;
    agentSessionId: string;
    parentTaskId?: string | null;
    status?: string;
  }
) {
  sqlite
    .prepare('INSERT INTO nodes (id, user_id, name, status) VALUES (?, ?, ?, ?)')
    .run(input.nodeId, 'user-caller', `Node ${input.nodeId}`, 'running');
  sqlite
    .prepare(
      `INSERT INTO workspaces
        (id, node_id, project_id, user_id, name, repository, branch, vm_size, vm_location, chat_session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.workspaceId,
      input.nodeId,
      input.projectId,
      'user-caller',
      `Workspace ${input.workspaceId}`,
      'raphaeltm/simple-agent-manager',
      'main',
      'small',
      'nbg1',
      input.chatSessionId
    );
  sqlite
    .prepare(
      `INSERT INTO agent_sessions
        (id, workspace_id, user_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.agentSessionId,
      input.workspaceId,
      'user-caller',
      'running',
      '2026-08-24T00:01:00.000Z',
      '2026-08-24T00:01:00.000Z'
    );
  insertTask(sqlite, {
    id: input.taskId,
    projectId: input.projectId,
    status: input.status ?? 'in_progress',
    parentTaskId: input.parentTaskId ?? null,
    workspaceId: input.workspaceId,
  });
}

function createMessagingEnv(): { env: Env; sqlite: Database.Database } {
  const sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.tasks, schema.nodes, schema.workspaces, schema.agentSessions]);

  insertTask(sqlite, {
    id: 'task-caller',
    projectId: 'project-a',
    status: 'in_progress',
    parentTaskId: 'shared-parent',
    workspaceId: 'workspace-caller',
  });
  insertActiveAgent(sqlite, {
    taskId: 'task-sibling',
    projectId: 'project-a',
    workspaceId: 'workspace-sibling',
    chatSessionId: 'chat-sibling',
    nodeId: 'node-sibling',
    agentSessionId: 'agent-sibling',
    parentTaskId: 'shared-parent',
  });
  insertActiveAgent(sqlite, {
    taskId: 'task-child',
    projectId: 'project-a',
    workspaceId: 'workspace-child',
    chatSessionId: 'chat-child',
    nodeId: 'node-child',
    agentSessionId: 'agent-child',
    parentTaskId: 'task-caller',
  });
  insertActiveAgent(sqlite, {
    taskId: 'task-foreign',
    projectId: 'project-b',
    workspaceId: 'workspace-foreign',
    chatSessionId: 'chat-foreign',
    nodeId: 'node-foreign',
    agentSessionId: 'agent-foreign',
    parentTaskId: 'task-caller',
  });
  insertActiveAgent(sqlite, {
    taskId: 'task-completed',
    projectId: 'project-a',
    workspaceId: 'workspace-completed',
    chatSessionId: 'chat-completed',
    nodeId: 'node-completed',
    agentSessionId: 'agent-completed',
    parentTaskId: 'shared-parent',
    status: 'completed',
  });

  return {
    sqlite,
    env: {
      DATABASE: createSqliteD1(sqlite),
      DURABLE_PROMPT_DELIVERY_ENABLED: 'false',
    } as unknown as Env,
  };
}

function textPayload(response: Awaited<ReturnType<typeof handleSendMessageToSubtask>>) {
  return JSON.parse((response.result as { content: Array<{ text: string }> }).content[0]!.text);
}

describe('project-scoped MCP agent messaging authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendPromptToAgentOnNode.mockResolvedValue(undefined);
    mockPersistOrchestrationPrompt.mockResolvedValue('persisted-message-id');
    mockAcceptPromptDelivery.mockResolvedValue({
      message: { id: 'accepted-message-id', deliveryState: 'queued' },
    });
    mockEnqueueMailboxMessage.mockResolvedValue({ id: 'mailbox-message-id' });
    mockMarkMailboxMessageDelivered.mockResolvedValue(true);
  });

  it('send_message_to_subtask allows same-project sibling agents and preserves verified-token provenance', async () => {
    const { env } = createMessagingEnv();

    const response = await handleSendMessageToSubtask(
      1,
      { taskId: 'task-sibling', message: 'please review the auth path' },
      callerToken,
      env
    );

    expect(response.error).toBeUndefined();
    expect(textPayload(response)).toEqual({ delivered: true });
    expect(mockPersistOrchestrationPrompt).toHaveBeenCalledWith({
      env,
      projectId: 'project-a',
      chatSessionId: 'chat-sibling',
      content: 'please review the auth path',
      source: 'parent_agent',
      kind: 'orchestration_prompt',
      parentTaskId: 'task-caller',
      childTaskId: 'task-sibling',
      senderId: 'workspace-caller',
    });
    expect(mockSendPromptToAgentOnNode).toHaveBeenCalledWith(
      'node-sibling',
      'workspace-sibling',
      'agent-sibling',
      'please review the auth path',
      env,
      'user-caller',
      'persisted-message-id'
    );
  });

  it('send_message_to_subtask still allows direct parent-to-child messaging', async () => {
    const { env } = createMessagingEnv();

    const response = await handleSendMessageToSubtask(
      1,
      { taskId: 'task-child', message: 'parent flow still works' },
      callerToken,
      env
    );

    expect(response.error).toBeUndefined();
    expect(mockSendPromptToAgentOnNode).toHaveBeenCalledWith(
      'node-child',
      'workspace-child',
      'agent-child',
      'parent flow still works',
      env,
      'user-caller',
      'persisted-message-id'
    );
  });

  it('send_message_to_subtask rejects cross-project targets without delivery side effects', async () => {
    const { env } = createMessagingEnv();

    const response = await handleSendMessageToSubtask(
      1,
      { taskId: 'task-foreign', message: 'cross-project attack' },
      callerToken,
      env
    );

    expect(response.error?.message).toContain('not found in this project');
    expect(mockPersistOrchestrationPrompt).not.toHaveBeenCalled();
    expect(mockSendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('send_message_to_subtask rejects a target whose workspace is no longer in the caller project', async () => {
    const { env, sqlite } = createMessagingEnv();
    sqlite
      .prepare('UPDATE workspaces SET project_id = ? WHERE id = ?')
      .run('project-b', 'workspace-sibling');

    const response = await handleSendMessageToSubtask(
      1,
      { taskId: 'task-sibling', message: 'stale workspace attack' },
      callerToken,
      env
    );

    expect(response.error?.message).toContain('workspace or node not found');
    expect(mockPersistOrchestrationPrompt).not.toHaveBeenCalled();
    expect(mockSendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('send_message_to_subtask rejects terminal same-project targets', async () => {
    const { env } = createMessagingEnv();

    const response = await handleSendMessageToSubtask(
      1,
      { taskId: 'task-completed', message: 'are you there?' },
      callerToken,
      env
    );

    expect(response.error?.message).toContain("Target task is in 'completed' status");
    expect(mockSendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('send_message_to_subtask rejects a terminal caller before delivery side effects', async () => {
    const { env, sqlite } = createMessagingEnv();
    sqlite.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('completed', 'task-caller');

    const response = await handleSendMessageToSubtask(
      1,
      { taskId: 'task-sibling', message: 'stale sender attack' },
      callerToken,
      env
    );

    expect(response.error?.message).toContain("Calling task is in 'completed' status");
    expect(mockPersistOrchestrationPrompt).not.toHaveBeenCalled();
    expect(mockSendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('send_message_to_subtask rejects self-targeting instead of widening to self-delivery', async () => {
    const { env } = createMessagingEnv();

    const response = await handleSendMessageToSubtask(
      1,
      { taskId: 'task-caller', message: 'loopback' },
      callerToken,
      env
    );

    expect(response.error?.message).toContain('another active task agent');
    expect(mockPersistOrchestrationPrompt).not.toHaveBeenCalled();
    expect(mockSendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('send_durable_message allows same-project sibling agents and preserves verified-token provenance', async () => {
    const { env } = createMessagingEnv();
    const durableEnv = { ...env, DURABLE_PROMPT_DELIVERY_ENABLED: 'true' } as Env;

    const response = await handleSendDurableMessage(
      1,
      {
        targetTaskId: 'task-sibling',
        message: 'durable handoff',
        messageClass: 'deliver',
        metadata: { sourceTaskId: 'spoofed', senderId: 'spoofed' },
      },
      callerToken,
      durableEnv
    );

    expect(response.error).toBeUndefined();
    expect(mockAcceptPromptDelivery).toHaveBeenCalledWith(
      durableEnv,
      'project-a',
      expect.objectContaining({
        targetSessionId: 'chat-sibling',
        displayContent: 'durable handoff',
        deliveryContent: 'durable handoff',
        sourceTaskId: 'task-caller',
        senderType: 'agent',
        senderId: 'workspace-caller',
        sourceKind: 'agent_mailbox',
        metadata: { sourceTaskId: 'spoofed', senderId: 'spoofed' },
      })
    );
    expect(mockSendPromptToAgentOnNode).not.toHaveBeenCalled();
  });

  it('send_durable_message rejects cross-project and terminal targets before accepting delivery', async () => {
    const { env } = createMessagingEnv();
    const durableEnv = { ...env, DURABLE_PROMPT_DELIVERY_ENABLED: 'true' } as Env;

    const crossProject = await handleSendDurableMessage(
      1,
      { targetTaskId: 'task-foreign', message: 'cross-project attack' },
      callerToken,
      durableEnv
    );
    const terminal = await handleSendDurableMessage(
      2,
      { targetTaskId: 'task-completed', message: 'still active?' },
      callerToken,
      durableEnv
    );

    expect(crossProject.error?.message).toContain('not found in this project');
    expect(terminal.error?.message).toContain("Target task is in 'completed' status");
    expect(mockAcceptPromptDelivery).not.toHaveBeenCalled();
  });

  it('send_durable_message rejects a terminal caller before accepting delivery', async () => {
    const { env, sqlite } = createMessagingEnv();
    sqlite.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('completed', 'task-caller');
    const durableEnv = { ...env, DURABLE_PROMPT_DELIVERY_ENABLED: 'true' } as Env;

    const response = await handleSendDurableMessage(
      1,
      { targetTaskId: 'task-sibling', message: 'stale sender attack' },
      callerToken,
      durableEnv
    );

    expect(response.error?.message).toContain("Calling task is in 'completed' status");
    expect(mockAcceptPromptDelivery).not.toHaveBeenCalled();
    expect(mockEnqueueMailboxMessage).not.toHaveBeenCalled();
  });

  it('send_durable_message rejects self-targeting instead of accepting self-delivery', async () => {
    const { env } = createMessagingEnv();
    const durableEnv = { ...env, DURABLE_PROMPT_DELIVERY_ENABLED: 'true' } as Env;

    const response = await handleSendDurableMessage(
      1,
      { targetTaskId: 'task-caller', message: 'loopback' },
      callerToken,
      durableEnv
    );

    expect(response.error?.message).toContain('another active task agent');
    expect(mockAcceptPromptDelivery).not.toHaveBeenCalled();
    expect(mockEnqueueMailboxMessage).not.toHaveBeenCalled();
  });

  it('send_durable_message rejects a target whose workspace is no longer in the caller project', async () => {
    const { env, sqlite } = createMessagingEnv();
    sqlite
      .prepare('UPDATE workspaces SET project_id = ? WHERE id = ?')
      .run('project-b', 'workspace-sibling');
    const durableEnv = { ...env, DURABLE_PROMPT_DELIVERY_ENABLED: 'true' } as Env;

    const response = await handleSendDurableMessage(
      1,
      { targetTaskId: 'task-sibling', message: 'stale workspace attack' },
      callerToken,
      durableEnv
    );

    expect(response.error?.message).toContain('workspace or node not found');
    expect(mockAcceptPromptDelivery).not.toHaveBeenCalled();
  });
});
