import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

// ─── Mock setup ────────────────────────────────────────────────────────────

// Mock node-agent service functions
const mockSendPromptToAgentOnNode = vi.fn();
const mockStopAgentSessionOnNode = vi.fn();
const mockPersistOrchestrationPrompt = vi.fn();
const mockEnqueueMailboxMessage = vi.fn();
const mockCleanupTerminalTaskResources = vi.fn();
const mockSyncTriggerExecutionStatus = vi.fn();
const mockAcceptPromptDelivery = vi.fn();

vi.mock('../../../src/services/node-agent', () => ({
  sendPromptToAgentOnNode: (...args: unknown[]) => mockSendPromptToAgentOnNode(...args),
  stopAgentSessionOnNode: (...args: unknown[]) => mockStopAgentSessionOnNode(...args),
}));

vi.mock('../../../src/services/orchestration-prompts', () => ({
  persistOrchestrationPrompt: (...args: unknown[]) => mockPersistOrchestrationPrompt(...args),
}));

vi.mock('../../../src/services/project-data', () => ({
  enqueueMailboxMessage: (...args: unknown[]) => mockEnqueueMailboxMessage(...args),
  acceptPromptDelivery: (...args: unknown[]) => mockAcceptPromptDelivery(...args),
}));

vi.mock('../../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResources: (...args: unknown[]) => mockCleanupTerminalTaskResources(...args),
}));

vi.mock('../../../src/services/trigger-execution-sync', () => ({
  syncTriggerExecutionStatus: (...args: unknown[]) => mockSyncTriggerExecutionStatus(...args),
}));

// Mock ulid for deterministic IDs
vi.mock('../../../src/lib/ulid', () => ({
  ulid: () => 'mock-ulid-001',
}));

function createMockD1() {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn(),
    raw: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };
  return {
    prepare: vi.fn().mockReturnValue(stmt),
    batch: vi.fn().mockResolvedValue([
      { success: true, meta: { changes: 1 } },
      { success: true, meta: { changes: 1 } },
    ]),
    _stmt: stmt,
  };
}

let mockD1 = createMockD1();
const mockEnv: Partial<Env> = {
  DATABASE: mockD1 as unknown as D1Database,
  BASE_DOMAIN: 'example.com',
  // These tests exercise the legacy direct-send compatibility path unless a
  // case explicitly opts into the default-on durable handoff below.
  DURABLE_PROMPT_DELIVERY_ENABLED: 'false',
};

const parentTokenData = {
  taskId: 'parent-task-001',
  projectId: 'proj-001',
  userId: 'user-001',
  workspaceId: 'ws-parent-001',
  createdAt: new Date().toISOString(),
};

/**
 * Helper: set mock D1 results for BOTH .all() and .raw() paths.
 * Drizzle uses .all() for select() and .raw() for select({...}).
 */
function mockD1ResultSequence(results: Record<string, unknown>[][]) {
  let callIndex = 0;
  const stmt = mockD1._stmt;

  stmt.raw.mockImplementation(() => {
    const rows = results[callIndex] ?? [];
    callIndex++;
    return Promise.resolve(rows.map((row) => Object.values(row)));
  });

  stmt.all.mockImplementation(() => {
    const rows = results[callIndex] ?? [];
    callIndex++;
    return Promise.resolve({ results: rows });
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('MCP Orchestration Communication Tools', () => {
  let handleSendMessageToSubtask: typeof import('../../../src/routes/mcp/orchestration-comms').handleSendMessageToSubtask;
  let handleStopSubtask: typeof import('../../../src/routes/mcp/orchestration-comms').handleStopSubtask;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockD1 = createMockD1();
    mockEnv.DATABASE = mockD1 as unknown as D1Database;
    mockSendPromptToAgentOnNode.mockResolvedValue(undefined);
    mockStopAgentSessionOnNode.mockResolvedValue(undefined);
    mockPersistOrchestrationPrompt.mockResolvedValue('persisted-msg-001');
    mockEnqueueMailboxMessage.mockResolvedValue({ id: 'mailbox-msg-001' });
    mockCleanupTerminalTaskResources.mockResolvedValue(undefined);
    mockSyncTriggerExecutionStatus.mockResolvedValue(undefined);
    mockAcceptPromptDelivery.mockResolvedValue({ message: { id: 'durable-message-001' } });

    const mod = await import('../../../src/routes/mcp/orchestration-comms');
    handleSendMessageToSubtask = mod.handleSendMessageToSubtask;
    handleStopSubtask = mod.handleStopSubtask;
  });

  // ─── send_message_to_subtask ──────────────────────────────────────────

  describe('send_message_to_subtask', () => {
    it('should reject when caller has no taskId (not a task agent)', async () => {
      const tokenData = { ...parentTokenData, taskId: '' };
      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'hello' },
        tokenData,
        mockEnv as Env
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Only task agents');
    });

    it('should reject when taskId param is missing', async () => {
      const result = await handleSendMessageToSubtask(
        1,
        { message: 'hello' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('taskId is required');
    });

    it('should reject when message param is missing', async () => {
      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('message is required');
    });

    it('should reject when child task is not found', async () => {
      mockD1ResultSequence([[]]);

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'nonexistent', message: 'hello' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Child task not found');
    });

    it('should reject when caller is not the direct parent', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'some-other-task',
          },
        ],
      ]);

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'hello' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('direct parent');
    });

    it('should reject when child task is in a terminal status', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'completed',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
      ]);

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'hello' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain("'completed' status");
    });

    it('should reject when child has no workspace assigned', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'queued',
            workspace_id: null,
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
      ]);

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'hello' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('no workspace assigned');
    });

    it('should deliver message successfully (happy path)', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [
          {
            id: 'agent-session-001',
          },
        ],
        [
          {
            chat_session_id: 'chat-child-001',
          },
        ],
      ]);

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'Please focus on the auth module' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeUndefined();
      const content = JSON.parse(
        (result.result as { content: Array<{ text: string }> }).content[0].text
      );
      expect(content.delivered).toBe(true);

      expect(mockSendPromptToAgentOnNode).toHaveBeenCalledWith(
        'node-001',
        'ws-child-001',
        'agent-session-001',
        'Please focus on the auth module',
        mockEnv,
        'user-001',
        'persisted-msg-001'
      );
      expect(mockPersistOrchestrationPrompt).toHaveBeenCalledWith({
        env: mockEnv,
        projectId: 'proj-001',
        chatSessionId: 'chat-child-001',
        content: 'Please focus on the auth module',
        source: 'parent_agent',
        kind: 'orchestration_prompt',
        parentTaskId: 'parent-task-001',
        childTaskId: 'child-001',
        senderId: 'ws-parent-001',
      });
      expect(mockPersistOrchestrationPrompt.mock.invocationCallOrder[0]).toBeLessThan(
        mockSendPromptToAgentOnNode.mock.invocationCallOrder[0]
      );
    });

    it('durably accepts the handoff and skips direct VM delivery when enabled', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [{ id: 'agent-session-001' }],
      ]);
      const durableEnv = {
        ...mockEnv,
        DURABLE_PROMPT_DELIVERY_ENABLED: 'true',
      } as Env;

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'durable handoff' },
        parentTokenData,
        durableEnv
      );

      expect(result.error).toBeUndefined();
      const content = JSON.parse(
        (result.result as { content: Array<{ text: string }> }).content[0]!.text
      );
      expect(content).toEqual({
        delivered: false,
        queued: true,
        accepted: true,
        messageId: 'durable-message-001',
      });
      expect(mockAcceptPromptDelivery).toHaveBeenCalledWith(
        durableEnv,
        'proj-001',
        expect.objectContaining({
          targetSessionId: 'chat-child-001',
          sourceKind: 'orchestration_handoff',
        })
      );
      expect(mockSendPromptToAgentOnNode).not.toHaveBeenCalled();
      expect(mockPersistOrchestrationPrompt).not.toHaveBeenCalled();
    });

    it('should return agent_busy when child responds with 409', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [
          {
            id: 'agent-session-001',
          },
        ],
        [
          {
            chat_session_id: 'chat-child-001',
          },
        ],
      ]);

      mockSendPromptToAgentOnNode.mockRejectedValue(
        new Error('Node Agent request failed: 409 Agent is busy')
      );

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'hello' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeUndefined();
      const content = JSON.parse(
        (result.result as { content: Array<{ text: string }> }).content[0].text
      );
      expect(content.delivered).toBe(false);
      expect(content.queued).toBe(true);
      expect(content.reason).toBe('agent_busy');
      expect(mockPersistOrchestrationPrompt.mock.invocationCallOrder[0]).toBeLessThan(
        mockSendPromptToAgentOnNode.mock.invocationCallOrder[0]
      );
      expect(mockEnqueueMailboxMessage).toHaveBeenCalledWith(
        mockEnv,
        'proj-001',
        expect.objectContaining({
          targetSessionId: 'chat-child-001',
          sourceTaskId: 'parent-task-001',
          content: 'hello',
        })
      );
    });

    it('should return internal error for non-409 delivery failures', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [
          {
            id: 'agent-session-001',
          },
        ],
      ]);

      mockSendPromptToAgentOnNode.mockRejectedValue(new Error('Network timeout'));

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'hello' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe(-32603);
      expect(result.error?.message).toContain('Failed to send message');
    });

    it('should reject when no running agent session exists', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [],
      ]);

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'hello' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('No running agent session');
    });

    it('should truncate message to max length', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [
          {
            id: 'agent-session-001',
          },
        ],
      ]);

      const longMessage = 'A'.repeat(40_000);

      await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: longMessage },
        parentTokenData,
        mockEnv as Env
      );

      const sentMessage = mockSendPromptToAgentOnNode.mock.calls[0][3] as string;
      expect(sentMessage.length).toBeLessThanOrEqual(32_768);
    });
  });

  // ─── stop_subtask ─────────────────────────────────────────────────────

  describe('stop_subtask', () => {
    it('should reject when taskId param is missing', async () => {
      const result = await handleStopSubtask(1, {}, parentTokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('taskId is required');
    });

    it('should reject when caller is not direct parent', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'not-my-parent',
          },
        ],
      ]);

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('direct parent');
    });

    it('should stop child without warning when no reason provided', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [
          {
            id: 'agent-session-001',
          },
        ],
      ]);

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeUndefined();
      const content = JSON.parse(
        (result.result as { content: Array<{ text: string }> }).content[0].text
      );
      expect(content.stopped).toBe(true);
      expect(content.taskId).toBe('child-001');

      expect(mockSendPromptToAgentOnNode).not.toHaveBeenCalled();

      expect(mockStopAgentSessionOnNode).toHaveBeenCalledWith(
        'node-001',
        'ws-child-001',
        'agent-session-001',
        mockEnv,
        'user-001'
      );
    });

    it('should send warning message before stop when reason provided', async () => {
      const envWithShortGrace = { ...mockEnv, ORCHESTRATOR_STOP_GRACE_MS: '10' };

      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [
          {
            id: 'agent-session-001',
          },
        ],
      ]);

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001', reason: 'Task is no longer needed' },
        parentTokenData,
        envWithShortGrace as unknown as Env
      );

      expect(result.error).toBeUndefined();

      expect(mockSendPromptToAgentOnNode).toHaveBeenCalledWith(
        'node-001',
        'ws-child-001',
        'agent-session-001',
        '[STOP REQUESTED BY PARENT] Task is no longer needed',
        envWithShortGrace,
        'user-001'
      );

      expect(mockStopAgentSessionOnNode).toHaveBeenCalledWith(
        'node-001',
        'ws-child-001',
        'agent-session-001',
        envWithShortGrace,
        'user-001'
      );
    });

    it('should still stop even if warning message fails (409 busy)', async () => {
      const envWithShortGrace = { ...mockEnv, ORCHESTRATOR_STOP_GRACE_MS: '10' };

      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [
          {
            id: 'agent-session-001',
          },
        ],
      ]);

      mockSendPromptToAgentOnNode.mockRejectedValue(
        new Error('Node Agent request failed: 409 Agent is busy')
      );

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001', reason: 'stopping anyway' },
        parentTokenData,
        envWithShortGrace as unknown as Env
      );

      expect(result.error).toBeUndefined();
      const content = JSON.parse(
        (result.result as { content: Array<{ text: string }> }).content[0].text
      );
      expect(content.stopped).toBe(true);

      expect(mockStopAgentSessionOnNode).toHaveBeenCalled();
    });

    it('should return internal error when hard stop fails', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [
          {
            id: 'agent-session-001',
          },
        ],
      ]);

      mockStopAgentSessionOnNode.mockRejectedValue(new Error('VM agent unreachable'));

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe(-32603);
      expect(result.error?.message).toContain('Failed to stop child agent session');
    });

    it('should reject when child task is completed', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'completed',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
      ]);

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain("'completed' status");
    });

    it('should stop the runtime before atomically cancelling and cleaning up the task', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [
          {
            id: 'agent-session-001',
          },
        ],
      ]);

      await handleStopSubtask(
        1,
        { taskId: 'child-001', reason: 'No longer needed' },
        parentTokenData,
        { ...mockEnv, ORCHESTRATOR_STOP_GRACE_MS: '1' } as Env
      );

      expect(mockStopAgentSessionOnNode).toHaveBeenCalled();
      expect(mockStopAgentSessionOnNode.mock.invocationCallOrder[0]).toBeLessThan(
        mockD1.batch.mock.invocationCallOrder[0]
      );
      const preparedSql = mockD1.prepare.mock.calls.map(([sql]) => String(sql));
      expect(preparedSql).toEqual(
        expect.arrayContaining([
          expect.stringContaining("SET status = 'cancelled'"),
          expect.stringContaining("'cancelled', 'agent'"),
        ])
      );
      expect(mockSyncTriggerExecutionStatus).toHaveBeenCalledWith(
        mockEnv.DATABASE,
        'child-001',
        'cancelled'
      );
      expect(mockCleanupTerminalTaskResources).toHaveBeenCalledWith(
        expect.anything(),
        'child-001',
        expect.objectContaining({
          status: 'cancelled',
          errorMessage: 'Stopped by parent: No longer needed',
          requiredUserId: 'user-001',
        })
      );
    });

    it('preserves a concurrent fatal terminal state instead of overwriting it with cancellation', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [{ id: 'agent-session-001' }],
      ]);
      mockD1.batch.mockResolvedValueOnce([
        { success: true, meta: { changes: 0 } },
        { success: true, meta: { changes: 0 } },
      ]);
      mockD1._stmt.first.mockResolvedValueOnce({ status: 'failed' });

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env
      );

      const content = JSON.parse(
        (result.result as { content: Array<{ text: string }> }).content[0].text
      );
      expect(content).toMatchObject({ stopped: true, terminalStatePreserved: true });
      expect(mockStopAgentSessionOnNode).toHaveBeenCalled();
      expect(mockCleanupTerminalTaskResources).not.toHaveBeenCalled();
    });

    it('retries cancellation when a concurrent transition keeps the child active', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [{ id: 'agent-session-001' }],
      ]);
      mockD1.batch
        .mockResolvedValueOnce([
          { success: true, meta: { changes: 0 } },
          { success: true, meta: { changes: 0 } },
        ])
        .mockResolvedValueOnce([
          { success: true, meta: { changes: 1 } },
          { success: true, meta: { changes: 1 } },
        ]);
      mockD1._stmt.first.mockResolvedValueOnce({ status: 'delegated' });

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeUndefined();
      expect(mockD1.batch).toHaveBeenCalledTimes(2);
      expect(mockCleanupTerminalTaskResources).toHaveBeenCalledWith(
        expect.anything(),
        'child-001',
        expect.objectContaining({ status: 'cancelled' })
      );
    });

    it('honors the configured task-status CAS attempt bound', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [{ id: 'agent-session-001' }],
      ]);
      mockD1.batch.mockResolvedValueOnce([
        { success: true, meta: { changes: 0 } },
        { success: true, meta: { changes: 0 } },
      ]);
      mockD1._stmt.first.mockResolvedValueOnce({ status: 'delegated' });

      const result = await handleStopSubtask(1, { taskId: 'child-001' }, parentTokenData, {
        ...mockEnv,
        ORCHESTRATOR_STOP_CAS_MAX_ATTEMPTS: '1',
      } as Env);

      expect(result.error?.message).toContain('task cancellation failed');
      expect(mockD1.batch).toHaveBeenCalledTimes(1);
      expect(mockCleanupTerminalTaskResources).not.toHaveBeenCalled();
    });

    it('reports cancellation persistence failure when D1 returns no transition result', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [{ id: 'agent-session-001' }],
      ]);
      mockD1.batch.mockResolvedValueOnce([]);

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error?.message).toContain('task cancellation failed');
      expect(mockCleanupTerminalTaskResources).not.toHaveBeenCalled();
    });

    it('reports cleanup failure after persisting cancellation', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'running',
          },
        ],
        [{ id: 'agent-session-001' }],
      ]);
      mockCleanupTerminalTaskResources.mockRejectedValueOnce(new Error('cleanup unavailable'));

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error?.message).toContain('runtime cleanup failed');
      expect(mockSyncTriggerExecutionStatus).toHaveBeenCalledWith(
        mockEnv.DATABASE,
        'child-001',
        'cancelled'
      );
    });

    it('should reject when node is in destroyed state', async () => {
      mockD1ResultSequence([
        [
          {
            id: 'child-001',
            status: 'in_progress',
            workspace_id: 'ws-child-001',
            project_id: 'proj-001',
            parent_task_id: 'parent-task-001',
          },
        ],
        [
          {
            id: 'ws-child-001',
            node_id: 'node-001',
            chat_session_id: 'chat-child-001',
            status: 'destroying',
          },
        ],
      ]);

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('not running');
    });
  });
});
