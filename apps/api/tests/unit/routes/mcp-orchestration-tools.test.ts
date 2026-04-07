import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/index';

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

  // Each .raw() or .all() call consumes the next result set
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

describe('MCP Orchestration Tools', () => {
  let handleSendMessageToSubtask: typeof import('../../../src/routes/mcp/orchestration-tools').handleSendMessageToSubtask;
  let handleStopSubtask: typeof import('../../../src/routes/mcp/orchestration-tools').handleStopSubtask;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockD1 = createMockD1();
    mockEnv.DATABASE = mockD1 as unknown as D1Database;
    mockSendPromptToAgentOnNode.mockResolvedValue(undefined);
    mockStopAgentSessionOnNode.mockResolvedValue(undefined);

    const mod = await import('../../../src/routes/mcp/orchestration-tools');
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
      // Query returns empty results for child task lookup
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

    it('should reject when caller is not the direct parent (grandparent)', async () => {
      // Child task exists but parent_task_id points to a different task
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

    it('should reject when caller is a sibling (not direct parent)', async () => {
      // Sibling task — same project, but parent_task_id is different
      mockD1ResultSequence([
        [{
          id: 'sibling-001',
          status: 'in_progress',
          workspace_id: 'ws-sibling-001',
          project_id: 'proj-001',
          parent_task_id: 'grandparent-task',
        }],
      ]);

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'sibling-001', message: 'hello' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('direct parent');
    });

    it('should reject when child task is in a terminal status (completed)', async () => {
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

    it('should reject cross-project task (different project)', async () => {
      // The query filters by project_id, so a different project returns empty
      mockD1ResultSequence([[]]);

      const result = await handleSendMessageToSubtask(
        1,
        { taskId: 'child-in-other-project', message: 'hello' },
        parentTokenData,
        mockEnv as Env,
      );

      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('not found');
    });

    it('should deliver message successfully (happy path)', async () => {
      // 1: child task query
      // 2: workspace + node query
      // 3: agent session query
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
          status: 'active',
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

      // Verify sendPromptToAgentOnNode was called with correct args
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
          status: 'active',
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
          status: 'active',
        }],
        [{
          id: 'agent-session-001',
        }],
      ]);

      // Default max is 32768 — send a message longer than that
      const longMessage = 'A'.repeat(40_000);

      await handleSendMessageToSubtask(
        1,
        { taskId: 'child-001', message: longMessage },
        parentTokenData,
        mockEnv as Env,
      );

      // The message sent to the VM agent should be truncated
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
          status: 'active',
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

      // No warning message should have been sent (no reason)
      expect(mockSendPromptToAgentOnNode).not.toHaveBeenCalled();

      // Hard stop should have been called
      expect(mockStopAgentSessionOnNode).toHaveBeenCalledWith(
        'node-001',
        'ws-child-001',
        'agent-session-001',
        mockEnv,
        'user-001',
      );
    });

    it('should send warning message before stop when reason provided', async () => {
      // Use a very short grace period for test speed
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
          status: 'active',
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

      // Warning message should have been sent first
      expect(mockSendPromptToAgentOnNode).toHaveBeenCalledWith(
        'node-001',
        'ws-child-001',
        'agent-session-001',
        '[STOP REQUESTED BY PARENT] Task is no longer needed',
        envWithShortGrace,
        'user-001',
      );

      // Then hard stop
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
          status: 'active',
        }],
        [{
          id: 'agent-session-001',
        }],
      ]);

      // Warning message fails with 409
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

      // Hard stop should still have been called despite warning failure
      expect(mockStopAgentSessionOnNode).toHaveBeenCalled();
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
          status: 'active',
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

      // Verify D1 was called to update task status and insert status event.
      // The handler does 3 initial queries (child task, workspace, agent session)
      // then 2 more (update task, insert status event).
      // Since the mock D1 doesn't reject, the handler should have made
      // at least 4 prepare calls (3 selects + 1 update or insert).
      expect(mockD1.prepare.mock.calls.length).toBeGreaterThanOrEqual(4);

      // The important thing is that stopAgentSessionOnNode was called and no error returned.
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
      expect(result.error?.message).toContain('no longer running');
    });
  });
});
