import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

// ─── Mock setup ────────────────────────────────────────────────────────────

// Mock node-agent service functions
const mockSendPromptToAgentOnNode = vi.fn();
const mockStopAgentSessionOnNode = vi.fn();

vi.mock('../../../src/services/node-agent', () => ({
  sendPromptToAgentOnNode: (...args: unknown[]) => mockSendPromptToAgentOnNode(...args),
  stopAgentSessionOnNode: (...args: unknown[]) => mockStopAgentSessionOnNode(...args),
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
    batch: vi.fn(),
    _stmt: stmt,
  };
}

let mockD1 = createMockD1();
const mockEnv: Partial<Env> = {
  DATABASE: mockD1 as unknown as D1Database,
  BASE_DOMAIN: 'example.com',
};

const parentTokenData = {
  taskId: 'parent-task-001',
  projectId: 'proj-001',
  userId: 'user-001',
  workspaceId: 'ws-parent-001',
  createdAt: '2026-04-07T00:00:00Z',
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

    const mod = await import('../../../src/routes/mcp/orchestration-comms');
    handleSendMessageToSubtask = mod.handleSendMessageToSubtask;
    handleStopSubtask = mod.handleStopSubtask;
  });

  // ─── send_message_to_subtask ──────────────────────────────────────────

  describe('send_message_to_subtask', () => {
    it('should reject when caller has no taskId (not a task agent)', async () => {
      const tokenData = { ...parentTokenData, taskId: '' };
      const result = await handleSendMessageToSubtask(1, { taskId: 'child-001', message: 'hello' }, tokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Only task agents');
    });

    it('should reject when taskId param is missing', async () => {
      const result = await handleSendMessageToSubtask(1, { message: 'hello' }, parentTokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('taskId is required');
    });

    it('should reject when message param is missing', async () => {
      const result = await handleSendMessageToSubtask(1, { taskId: 'child-001' }, parentTokenData, mockEnv as Env);

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('message is required');
    });

    it('should reject when child task is not found', async () => {
      mockD1ResultSequence([[]]);

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'nonexistent', message: 'hello' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('Child task not found');
    });

    it('should reject when caller is not the direct parent', async () => {
      mockD1ResultSequence([
        [{
          id: 'child-001',
          status: 'in_progress',
          workspace_id: 'ws-child-001',
          project_id: 'proj-001',
          parent_task_id: 'some-other-task',
        }],
      ]);

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'hello' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('direct parent');
    });

    it('should reject when child task is in a terminal status', async () => {
      mockD1ResultSequence([
        [{
          id: 'child-001',
          status: 'completed',
          workspace_id: 'ws-child-001',
          project_id: 'proj-001',
          parent_task_id: 'parent-task-001',
        }],
      ]);

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'hello' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain("'completed' status");
    });

    it('should reject when child has no workspace assigned', async () => {
      mockD1ResultSequence([
        [{
          id: 'child-001',
          status: 'queued',
          workspace_id: null,
          project_id: 'proj-001',
          parent_task_id: 'parent-task-001',
        }],
      ]);

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'hello' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('no workspace assigned');
    });

    it('should deliver message successfully (happy path)', async () => {
      mockD1ResultSequence([
        [{
          id: 'child-001',
          status: 'in_progress',
          workspace_id: 'ws-child-001',
          project_id: 'proj-001',
          parent_task_id: 'parent-task-001',
        }],
        [{
          id: 'ws-child-001',
          node_id: 'node-001',
          status: 'running',
        }],
        [{
          id: 'agent-session-001',
        }],
      ]);

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'Please focus on the auth module' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.delivered).toBe(true);

      expect(mockSendPromptToAgentOnNode).toHaveBeenCalledWith(
        'node-001',
        'ws-child-001',
        'agent-session-001',
        'Please focus on the auth module',
        mockEnv,
        'user-001',
      );
    });

    it('should return agent_busy when child responds with 409', async () => {
      mockD1ResultSequence([
        [{
          id: 'child-001',
          status: 'in_progress',
          workspace_id: 'ws-child-001',
          project_id: 'proj-001',
          parent_task_id: 'parent-task-001',
        }],
        [{
          id: 'ws-child-001',
          node_id: 'node-001',
          status: 'running',
        }],
        [{
          id: 'agent-session-001',
        }],
      ]);

      mockSendPromptToAgentOnNode.mockRejectedValue(
        new Error('Node Agent request failed: 409 Agent is busy'),
      );

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'hello' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.delivered).toBe(false);
      expect(content.reason).toBe('agent_busy');
    });

    it('should return internal error for non-409 delivery failures', async () => {
      mockD1ResultSequence([
        [{
          id: 'child-001',
          status: 'in_progress',
          workspace_id: 'ws-child-001',
          project_id: 'proj-001',
          parent_task_id: 'parent-task-001',
        }],
        [{
          id: 'ws-child-001',
          node_id: 'node-001',
          status: 'running',
        }],
        [{
          id: 'agent-session-001',
        }],
      ]);

      mockSendPromptToAgentOnNode.mockRejectedValue(new Error('Network timeout'));

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'hello' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe(-32603);
      expect(result.error?.message).toContain('Failed to send message');
    });

    it('should reject when no running agent session exists', async () => {
      mockD1ResultSequence([
        [{
          id: 'child-001',
          status: 'in_progress',
          workspace_id: 'ws-child-001',
          project_id: 'proj-001',
          parent_task_id: 'parent-task-001',
        }],
        [{
          id: 'ws-child-001',
          node_id: 'node-001',
          status: 'running',
        }],
        [],
      ]);

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: 'hello' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('No running agent session');
    });

    it('should truncate message to max length', async () => {
      mockD1ResultSequence([
        [{
          id: 'child-001',
          status: 'in_progress',
          workspace_id: 'ws-child-001',
          project_id: 'proj-001',
          parent_task_id: 'parent-task-001',
        }],
        [{
          id: 'ws-child-001',
          node_id: 'node-001',
          status: 'running',
        }],
        [{
          id: 'agent-session-001',
        }],
      ]);

      const longMessage = 'A'.repeat(40_000);

      await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: longMessage },
        parentTokenData,
        mockEnv as Env,
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
        [{
          id: 'child-001',
          status: 'in_progress',
          workspace_id: 'ws-child-001',
          project_id: 'proj-001',
          parent_task_id: 'not-my-parent',
        }],
      ]);

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('direct parent');
    });

    it('should stop child without warning when no reason provided', async () => {
      mockD1ResultSequence([
        [{
          id: 'child-001',
          status: 'in_progress',
          workspace_id: 'ws-child-001',
          project_id: 'proj-001',
          parent_task_id: 'parent-task-001',
        }],
        [{
          id: 'ws-child-001',
          node_id: 'node-001',
          status: 'running',
        }],
        [{
          id: 'agent-session-001',
        }],
      ]);

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.stopped).toBe(true);
      expect(content.taskId).toBe('child-001');

      expect(mockSendPromptToAgentOnNode).not.toHaveBeenCalled();

      expect(mockStopAgentSessionOnNode).toHaveBeenCalledWith(
        'node-001',
        'ws-child-001',
        'agent-session-001',
        mockEnv,
        'user-001',
      );
    });

    it('should send warning message before stop when reason provided', async () => {
      const envWithShortGrace = { ...mockEnv, ORCHESTRATOR_STOP_GRACE_MS: '10' };

      mockD1ResultSequence([
        [{
          id: 'child-001',
          status: 'in_progress',
          workspace_id: 'ws-child-001',
          project_id: 'proj-001',
          parent_task_id: 'parent-task-001',
        }],
        [{
          id: 'ws-child-001',
          node_id: 'node-001',
          status: 'running',
        }],
        [{
          id: 'agent-session-001',
        }],
      ]);

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001', reason: 'Task is no longer needed' },
        parentTokenData,
        envWithShortGrace as unknown as Env,
      );

      expect(result.error).toBeUndefined();

      expect(mockSendPromptToAgentOnNode).toHaveBeenCalledWith(
        'node-001',
        'ws-child-001',
        'agent-session-001',
        '[STOP REQUESTED BY PARENT] Task is no longer needed',
        envWithShortGrace,
        'user-001',
      );

      expect(mockStopAgentSessionOnNode).toHaveBeenCalledWith(
        'node-001',
        'ws-child-001',
        'agent-session-001',
        envWithShortGrace,
        'user-001',
      );
    });

    it('should still stop even if warning message fails (409 busy)', async () => {
      const envWithShortGrace = { ...mockEnv, ORCHESTRATOR_STOP_GRACE_MS: '10' };

      mockD1ResultSequence([
        [{
          id: 'child-001',
          status: 'in_progress',
          workspace_id: 'ws-child-001',
          project_id: 'proj-001',
          parent_task_id: 'parent-task-001',
        }],
        [{
          id: 'ws-child-001',
          node_id: 'node-001',
          status: 'running',
        }],
        [{
          id: 'agent-session-001',
        }],
      ]);

      mockSendPromptToAgentOnNode.mockRejectedValue(
        new Error('Node Agent request failed: 409 Agent is busy'),
      );

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001', reason: 'stopping anyway' },
        parentTokenData,
        envWithShortGrace as unknown as Env,
      );

      expect(result.error).toBeUndefined();
      const content = JSON.parse((result.result as { content: Array<{ text: string }> }).content[0].text);
      expect(content.stopped).toBe(true);

      expect(mockStopAgentSessionOnNode).toHaveBeenCalled();
    });

    it('should return internal error when hard stop fails', async () => {
      mockD1ResultSequence([
        [{
          id: 'child-001',
          status: 'in_progress',
          workspace_id: 'ws-child-001',
          project_id: 'proj-001',
          parent_task_id: 'parent-task-001',
        }],
        [{
          id: 'ws-child-001',
          node_id: 'node-001',
          status: 'running',
        }],
        [{
          id: 'agent-session-001',
        }],
      ]);

      mockStopAgentSessionOnNode.mockRejectedValue(new Error('VM agent unreachable'));

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe(-32603);
      expect(result.error?.message).toContain('Failed to stop child agent session');
    });

    it('should reject when child task is completed', async () => {
      mockD1ResultSequence([
        [{
          id: 'child-001',
          status: 'completed',
          workspace_id: 'ws-child-001',
          project_id: 'proj-001',
          parent_task_id: 'parent-task-001',
        }],
      ]);

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain("'completed' status");
    });

    it('should update task status to failed with stop reason', async () => {
      mockD1ResultSequence([
        [{
          id: 'child-001',
          status: 'in_progress',
          workspace_id: 'ws-child-001',
          project_id: 'proj-001',
          parent_task_id: 'parent-task-001',
        }],
        [{
          id: 'ws-child-001',
          node_id: 'node-001',
          status: 'running',
        }],
        [{
          id: 'agent-session-001',
        }],
      ]);

      await handleStopSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(mockD1.prepare.mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(mockStopAgentSessionOnNode).toHaveBeenCalled();
    });

    it('should reject when node is in destroyed state', async () => {
      mockD1ResultSequence([
        [{
          id: 'child-001',
          status: 'in_progress',
          workspace_id: 'ws-child-001',
          project_id: 'proj-001',
          parent_task_id: 'parent-task-001',
        }],
        [{
          id: 'ws-child-001',
          node_id: 'node-001',
          status: 'destroying',
        }],
      ]);

      const result = await handleStopSubtask(
        1,
        { taskId: 'child-001' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('not running');
    });
  });
});
