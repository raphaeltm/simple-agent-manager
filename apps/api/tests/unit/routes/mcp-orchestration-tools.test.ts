import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/index';
import { handleGetSubtaskSummary } from '../../../src/routes/mcp/orchestration-tools';
import { handleGetTaskDependencies } from '../../../src/routes/mcp/workspace-tools-direct';

// ─── Mock helpers ───────────────────────────────────────────────────────────

function createMockD1() {
  const stmt = {
    bind: vi.fn().mockReturnThis(),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn(),
    raw: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue({ success: true }),
  };
  return {
    prepare: vi.fn().mockReturnValue(stmt),
    batch: vi.fn(),
    _stmt: stmt,
  };
}

/**
 * Drizzle uses .raw() for select({...}) with specific column selection.
 * Each row is an array of values in positional order matching the select keys.
 */
function mockD1RawSequence(d1: ReturnType<typeof createMockD1>, ...callResults: unknown[][][]) {
  const raw = d1._stmt.raw;
  for (const result of callResults) {
    raw.mockResolvedValueOnce(result);
  }
}

const mockDoStub = {
  fetch: vi.fn().mockResolvedValue(new Response('ok')),
  ensureProjectId: vi.fn(),
  getSessionsByTaskIds: vi.fn().mockResolvedValue([]),
};
const mockProjectData = {
  idFromName: vi.fn().mockReturnValue('do-id'),
  get: vi.fn().mockReturnValue(mockDoStub),
};

const validTokenData = {
  taskId: 'parent-task-1',
  projectId: 'proj-1',
  userId: 'user-1',
  workspaceId: 'ws-1',
  createdAt: '2026-04-07T00:00:00Z',
};

function createMockEnv(d1: ReturnType<typeof createMockD1>): Env {
  return {
    DATABASE: d1 as unknown,
    PROJECT_DATA: mockProjectData,
    BASE_DOMAIN: 'example.com',
  } as unknown as Env;
}

// ─── get_task_dependencies enriched fields ──────────────────────────────────

describe('get_task_dependencies (enriched)', () => {
  let mockD1: ReturnType<typeof createMockD1>;
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockD1 = createMockD1();
    mockEnv = createMockEnv(mockD1);
  });

  it('returns enriched fields for downstream tasks', async () => {
    // Call 1: Get current task (id, title, parentTaskId)
    // Call 2: Downstream tasks (enriched select)
    // Call 3: Siblings query skipped because no parentTaskId
    mockD1RawSequence(
      mockD1,
      // Current task
      [['parent-task-1', 'Parent Task', null]],
      // Downstream children (id, title, status, outputBranch, outputSummary, completedAt, errorMessage, executionStep)
      [
        ['child-1', 'Child One', 'completed', 'sam/child-1', 'Implemented feature X', '2026-04-07T12:00:00Z', null, 'running'],
        ['child-2', 'Child Two', 'in_progress', null, null, null, null, 'workspace_creation'],
      ],
    );

    const result = await handleGetTaskDependencies(1, validTokenData, mockEnv);
    expect(result.error).toBeUndefined();

    const data = JSON.parse(result.result!.content[0].text);

    // Downstream should have enriched fields
    expect(data.downstream).toHaveLength(2);

    const child1 = data.downstream[0];
    expect(child1.id).toBe('child-1');
    expect(child1.outputSummary).toBe('Implemented feature X');
    expect(child1.completedAt).toBe('2026-04-07T12:00:00Z');
    expect(child1.errorMessage).toBeNull();
    expect(child1.executionStep).toBe('running');
    expect(child1.pendingInput).toBe(false);

    const child2 = data.downstream[1];
    expect(child2.id).toBe('child-2');
    expect(child2.outputSummary).toBeNull();
    expect(child2.completedAt).toBeNull();
    expect(child2.executionStep).toBe('workspace_creation');
    expect(child2.pendingInput).toBe(false);
  });

  it('sets pendingInput true when executionStep is awaiting_followup', async () => {
    mockD1RawSequence(
      mockD1,
      // Current task
      [['parent-task-1', 'Parent Task', null]],
      // Downstream child with awaiting_followup
      [['child-3', 'Blocked Child', 'in_progress', null, null, null, null, 'awaiting_followup']],
    );

    const result = await handleGetTaskDependencies(1, validTokenData, mockEnv);
    const data = JSON.parse(result.result!.content[0].text);

    expect(data.downstream[0].pendingInput).toBe(true);
    expect(data.downstream[0].executionStep).toBe('awaiting_followup');
  });

  it('returns enriched fields for sibling tasks', async () => {
    const tokenWithParent = { ...validTokenData, taskId: 'sibling-task-1' };

    mockD1RawSequence(
      mockD1,
      // Current task (has a parent)
      [['sibling-task-1', 'Sibling Task', 'parent-task-1']],
      // Upstream parent (basic select)
      [['parent-task-1', 'Parent', 'completed', 'parent-task-1', 'main']],
      // Downstream (no children)
      [],
      // Siblings (enriched select, includes self which gets filtered)
      [
        ['sibling-task-1', 'Sibling Task', 'in_progress', null, null, null, null, 'running'],
        ['sibling-task-2', 'Other Sibling', 'completed', 'sam/other', 'Done doing X', '2026-04-07T10:00:00Z', null, 'running'],
      ],
    );

    const result = await handleGetTaskDependencies(1, tokenWithParent, mockEnv);
    const data = JSON.parse(result.result!.content[0].text);

    // Self should be filtered out
    expect(data.siblings).toHaveLength(1);
    const sibling = data.siblings[0];
    expect(sibling.id).toBe('sibling-task-2');
    expect(sibling.outputSummary).toBe('Done doing X');
    expect(sibling.completedAt).toBe('2026-04-07T10:00:00Z');
    expect(sibling.pendingInput).toBe(false);
  });

  it('returns errorMessage for failed downstream tasks', async () => {
    mockD1RawSequence(
      mockD1,
      // Current task
      [['parent-task-1', 'Parent Task', null]],
      // Failed child
      [['child-fail', 'Failed Child', 'failed', null, null, '2026-04-07T11:00:00Z', 'Build error in step 3', null]],
    );

    const result = await handleGetTaskDependencies(1, validTokenData, mockEnv);
    const data = JSON.parse(result.result!.content[0].text);

    expect(data.downstream[0].errorMessage).toBe('Build error in step 3');
    expect(data.downstream[0].status).toBe('failed');
  });
});

// ─── get_subtask_summary ────────────────────────────────────────────────────

describe('get_subtask_summary', () => {
  let mockD1: ReturnType<typeof createMockD1>;
  let mockEnv: Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mockD1 = createMockD1();
    mockEnv = createMockEnv(mockD1);
  });

  it('returns full summary for a completed child task', async () => {
    // Query child task
    mockD1RawSequence(
      mockD1,
      [[
        'child-1', 'Child Task', 'completed',
        'Implement the feature as described in the spec',
        'Successfully implemented feature X with tests',
        'sam/child-1', '2026-04-07T12:00:00Z', null, 'running',
        'parent-task-1',
      ]],
    );

    // Mock DO session query
    mockDoStub.getSessionsByTaskIds.mockResolvedValueOnce([
      { id: 'session-1', taskId: 'child-1', messageCount: 42 },
    ]);

    const result = await handleGetSubtaskSummary(
      1,
      { taskId: 'child-1' },
      validTokenData,
      mockEnv,
    );

    expect(result.error).toBeUndefined();
    const data = JSON.parse(result.result!.content[0].text);

    expect(data.id).toBe('child-1');
    expect(data.title).toBe('Child Task');
    expect(data.status).toBe('completed');
    expect(data.outputSummary).toBe('Successfully implemented feature X with tests');
    expect(data.outputBranch).toBe('sam/child-1');
    expect(data.completedAt).toBe('2026-04-07T12:00:00Z');
    expect(data.errorMessage).toBeNull();
    expect(data.sessionMessageCount).toBe(42);
    // Description should be present (truncated to default 500 chars)
    expect(data.description).toBe('Implement the feature as described in the spec');
  });

  it('rejects access from non-parent tasks', async () => {
    // Child belongs to a different parent
    mockD1RawSequence(
      mockD1,
      [[
        'child-1', 'Child Task', 'completed',
        'Some description', null, null, null, null, null,
        'other-parent-task', // parentTaskId !== validTokenData.taskId
      ]],
    );

    const result = await handleGetSubtaskSummary(
      1,
      { taskId: 'child-1' },
      validTokenData,
      mockEnv,
    );

    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('Access denied');
    expect(result.error!.message).toContain('not the parent');
  });

  it('returns error for non-existent task', async () => {
    mockD1RawSequence(mockD1, []);

    const result = await handleGetSubtaskSummary(
      1,
      { taskId: 'nonexistent' },
      validTokenData,
      mockEnv,
    );

    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('not found');
  });

  it('returns errorMessage for failed child tasks', async () => {
    mockD1RawSequence(
      mockD1,
      [[
        'child-fail', 'Failed Child', 'failed',
        'Task description here', null, null, null,
        'Build failed: exit code 1', null,
        'parent-task-1',
      ]],
    );

    mockDoStub.getSessionsByTaskIds.mockResolvedValueOnce([]);

    const result = await handleGetSubtaskSummary(
      1,
      { taskId: 'child-fail' },
      validTokenData,
      mockEnv,
    );

    const data = JSON.parse(result.result!.content[0].text);
    expect(data.status).toBe('failed');
    expect(data.errorMessage).toBe('Build failed: exit code 1');
    expect(data.sessionMessageCount).toBeNull();
  });

  it('returns executionStep for in-progress child tasks', async () => {
    mockD1RawSequence(
      mockD1,
      [[
        'child-running', 'Running Child', 'in_progress',
        'Working on feature', null, null, null, null, 'workspace_creation',
        'parent-task-1',
      ]],
    );

    mockDoStub.getSessionsByTaskIds.mockResolvedValueOnce([
      { id: 'session-2', taskId: 'child-running', messageCount: 5 },
    ]);

    const result = await handleGetSubtaskSummary(
      1,
      { taskId: 'child-running' },
      validTokenData,
      mockEnv,
    );

    const data = JSON.parse(result.result!.content[0].text);
    expect(data.status).toBe('in_progress');
    expect(data.executionStep).toBe('workspace_creation');
    expect(data.outputSummary).toBeNull();
    expect(data.sessionMessageCount).toBe(5);
  });

  it('requires task-scoped MCP token', async () => {
    const tokenWithoutTask = { ...validTokenData, taskId: undefined };

    const result = await handleGetSubtaskSummary(
      1,
      { taskId: 'child-1' },
      tokenWithoutTask as any,
      mockEnv,
    );

    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('task-scoped');
  });

  it('requires taskId parameter', async () => {
    const result = await handleGetSubtaskSummary(
      1,
      {},
      validTokenData,
      mockEnv,
    );

    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain('taskId is required');
  });

  it('truncates description to configured max length', async () => {
    const longDescription = 'A'.repeat(1000);
    mockD1RawSequence(
      mockD1,
      [[
        'child-1', 'Child', 'completed',
        longDescription, 'summary', 'branch', '2026-04-07T12:00:00Z', null, null,
        'parent-task-1',
      ]],
    );

    mockDoStub.getSessionsByTaskIds.mockResolvedValueOnce([]);

    // Default max is 500
    const result = await handleGetSubtaskSummary(
      1,
      { taskId: 'child-1' },
      validTokenData,
      mockEnv,
    );

    const data = JSON.parse(result.result!.content[0].text);
    expect(data.description).toHaveLength(500);
    expect(data.description).toBe('A'.repeat(500));
  });

  it('handles DO unavailability gracefully', async () => {
    mockD1RawSequence(
      mockD1,
      [[
        'child-1', 'Child', 'completed',
        'desc', 'summary', 'branch', '2026-04-07T12:00:00Z', null, null,
        'parent-task-1',
      ]],
    );

    // Simulate DO failure
    mockDoStub.getSessionsByTaskIds.mockRejectedValueOnce(new Error('DO unavailable'));

    const result = await handleGetSubtaskSummary(
      1,
      { taskId: 'child-1' },
      validTokenData,
      mockEnv,
    );

    // Should still succeed — session message count is best-effort
    expect(result.error).toBeUndefined();
    const data = JSON.parse(result.result!.content[0].text);
    expect(data.sessionMessageCount).toBeNull();
  });
});
