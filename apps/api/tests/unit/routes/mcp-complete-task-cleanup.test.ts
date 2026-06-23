/**
 * Tests for complete_task lifecycle cleanup behavior.
 *
 * Verifies:
 * 1. Task-mode complete_task triggers session stop + workspace cleanup
 * 2. Conversation-mode complete_task does NOT trigger cleanup
 * 3. Trigger execution sync happens on complete_task
 */
import { beforeEach,describe, expect, it, vi } from 'vitest';

// ── Module mocks (must be before imports) ───────────────────────────────────

// Track calls to projectDataService.stopSession
const stopSessionSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/services/project-data', () => ({
  stopSession: (...args: unknown[]) => stopSessionSpy(...args),
  recordActivityEvent: vi.fn().mockResolvedValue(undefined),
  markAgentCompleted: vi.fn().mockResolvedValue(undefined),
  scheduleIdleCleanup: vi.fn().mockResolvedValue({ cleanupAt: Date.now() + 60000 }),
}));

// Track calls to cleanupTaskRun
const cleanupTaskRunSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/services/task-runner', () => ({
  cleanupTaskRun: (...args: unknown[]) => cleanupTaskRunSpy(...args),
}));

// Track calls to syncTriggerExecutionStatus
const syncTriggerSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/services/trigger-execution-sync', () => ({
  syncTriggerExecutionStatus: (...args: unknown[]) => syncTriggerSpy(...args),
}));

// Mock orchestrator + scheduler
const notifyTaskEventSpy = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/services/project-orchestrator', () => ({
  notifyTaskEvent: (...args: unknown[]) => notifyTaskEventSpy(...args),
}));
vi.mock('../../../src/services/scheduler-state-sync', () => ({
  recomputeMissionSchedulerStates: vi.fn().mockResolvedValue(undefined),
}));

// Mock notification service
vi.mock('../../../src/services/notification', () => ({
  getProjectName: vi.fn().mockResolvedValue('Test Project'),
  getChatSessionId: vi.fn().mockResolvedValue('session-1'),
  notifyTaskComplete: vi.fn().mockResolvedValue(undefined),
  notifySessionEnded: vi.fn().mockResolvedValue(undefined),
}));

// Mock logger
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleCompleteTask } from '../../../src/routes/mcp/task-tools';
import type { McpTokenData } from '../../../src/services/mcp-token';

// ── Test helpers ────────────────────────────────────────────────────────────

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

const mockDoStub = {
  fetch: vi.fn().mockResolvedValue(new Response('ok')),
};
const mockProjectData = {
  idFromName: vi.fn().mockReturnValue('do-id'),
  get: vi.fn().mockReturnValue(mockDoStub),
};

const tokenData: McpTokenData = {
  taskId: 'task-123',
  projectId: 'proj-456',
  userId: 'user-789',
  workspaceId: 'ws-abc',
  createdAt: new Date().toISOString(),
};

function createMockEnv(mockD1: ReturnType<typeof createMockD1>) {
  return {
    DATABASE: mockD1 as unknown,
    PROJECT_DATA: mockProjectData,
    NOTIFICATION: null,
  } as unknown as import('../../../src/env').Env;
}

function createMockExecutionCtx(): ExecutionContext {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => { promises.push(p); },
    passThroughOnException: () => {},
    // Expose for test inspection
    _promises: promises,
  } as unknown as ExecutionContext & { _promises: Promise<unknown>[] };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('complete_task cleanup behavior', () => {
  let mockD1: ReturnType<typeof createMockD1>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockD1 = createMockD1();
  });

  it('task-mode complete_task triggers session stop and cleanup', async () => {
    // D1 query: task_mode = 'task'
    mockD1._stmt.first.mockResolvedValueOnce({
      task_mode: 'task',
      user_id: 'user-789',
      title: 'Fix bug',
      output_pr_url: null,
      output_branch: null,
      mission_id: null,
    });
    // D1 update: status = 'completed' succeeds
    mockD1._stmt.run.mockResolvedValue({ success: true, meta: { changes: 1 } });
    // D1 query for workspace chatSessionId (used by stopSessionAndCleanup)
    mockD1._stmt.raw.mockResolvedValueOnce([['session-xyz']]);

    const env = createMockEnv(mockD1);
    const ctx = createMockExecutionCtx();

    const result = await handleCompleteTask(1, { summary: 'Done' }, tokenData, env, ctx);

    expect(result.result).toBeDefined();
    expect((result.result as { content: Array<{ text: string }> }).content[0].text).toContain('completed');

    // Wait for background work to complete
    await Promise.allSettled(ctx._promises);

    // Verify session stop was called
    expect(stopSessionSpy).toHaveBeenCalledWith(env, 'proj-456', 'session-xyz');

    // Verify workspace cleanup was triggered
    expect(cleanupTaskRunSpy).toHaveBeenCalledWith('task-123', env);

    // Non-mission tasks must not wake ProjectOrchestrator.
    expect(notifyTaskEventSpy).not.toHaveBeenCalled();
  });

  it('conversation-mode complete_task does NOT trigger session stop or cleanup', async () => {
    // D1 query: task_mode = 'conversation'
    mockD1._stmt.first.mockResolvedValueOnce({
      task_mode: 'conversation',
      user_id: 'user-789',
      title: 'Chat session',
      output_pr_url: null,
      output_branch: null,
      mission_id: null,
    });
    // D1 update: awaiting_followup succeeds
    mockD1._stmt.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

    const env = createMockEnv(mockD1);
    const ctx = createMockExecutionCtx();

    const result = await handleCompleteTask(1, { summary: 'Explored' }, tokenData, env, ctx);

    expect(result.result).toBeDefined();
    expect((result.result as { content: Array<{ text: string }> }).content[0].text).toContain('Conversation remains open');

    // Wait for any background work
    await Promise.allSettled(ctx._promises);

    // Session stop and cleanup should NOT be called
    expect(stopSessionSpy).not.toHaveBeenCalled();
    expect(cleanupTaskRunSpy).not.toHaveBeenCalled();
  });

  it('task-mode complete_task syncs trigger execution status', async () => {
    mockD1._stmt.first.mockResolvedValueOnce({
      task_mode: 'task',
      user_id: 'user-789',
      title: 'Triggered task',
      output_pr_url: null,
      output_branch: null,
      mission_id: null,
    });
    mockD1._stmt.run.mockResolvedValue({ success: true, meta: { changes: 1 } });
    mockD1._stmt.raw.mockResolvedValueOnce([['session-xyz']]);

    const env = createMockEnv(mockD1);
    const ctx = createMockExecutionCtx();

    await handleCompleteTask(1, { summary: 'Done' }, tokenData, env, ctx);

    // syncTriggerExecutionStatus is called synchronously (not in waitUntil)
    expect(syncTriggerSpy).toHaveBeenCalledWith(
      expect.anything(), // D1 database
      'task-123',
      'completed',
    );
  });

  it('task-mode complete_task without executionCtx still completes (no cleanup)', async () => {
    // Verify graceful degradation when executionCtx is not provided
    mockD1._stmt.first.mockResolvedValueOnce({
      task_mode: 'task',
      user_id: 'user-789',
      title: 'Fix',
      output_pr_url: null,
      output_branch: null,
      mission_id: null,
    });
    mockD1._stmt.run.mockResolvedValue({ success: true, meta: { changes: 1 } });

    const env = createMockEnv(mockD1);

    // No executionCtx — cleanup won't run but task completion still succeeds
    const result = await handleCompleteTask(1, { summary: 'Done' }, tokenData, env);

    expect(result.result).toBeDefined();
    expect((result.result as { content: Array<{ text: string }> }).content[0].text).toContain('completed');

    // Cleanup not called since no executionCtx
    expect(stopSessionSpy).not.toHaveBeenCalled();
    expect(cleanupTaskRunSpy).not.toHaveBeenCalled();
  });

  it('task-mode complete_task skips stopSession when workspace has no chatSessionId', async () => {
    mockD1._stmt.first.mockResolvedValueOnce({
      task_mode: 'task',
      user_id: 'user-789',
      title: 'Fix bug',
      output_pr_url: null,
      output_branch: null,
      mission_id: null,
    });
    mockD1._stmt.run.mockResolvedValue({ success: true, meta: { changes: 1 } });
    // Workspace exists but has no linked chat session
    mockD1._stmt.raw.mockResolvedValueOnce([[null]]);

    const env = createMockEnv(mockD1);
    const ctx = createMockExecutionCtx();

    await handleCompleteTask(1, { summary: 'Done' }, tokenData, env, ctx);
    await Promise.allSettled(ctx._promises);

    // stopSession should NOT be called when chatSessionId is null
    expect(stopSessionSpy).not.toHaveBeenCalled();

    // cleanupTaskRun should still run
    expect(cleanupTaskRunSpy).toHaveBeenCalledWith('task-123', env);
  });

  it('task-mode complete_task still runs cleanupTaskRun when stopSession fails', async () => {
    mockD1._stmt.first.mockResolvedValueOnce({
      task_mode: 'task',
      user_id: 'user-789',
      title: 'Fix bug',
      output_pr_url: null,
      output_branch: null,
      mission_id: null,
    });
    mockD1._stmt.run.mockResolvedValue({ success: true, meta: { changes: 1 } });
    mockD1._stmt.raw.mockResolvedValueOnce([['session-xyz']]);

    // Make stopSession throw
    stopSessionSpy.mockRejectedValueOnce(new Error('DO unavailable'));

    const env = createMockEnv(mockD1);
    const ctx = createMockExecutionCtx();

    const result = await handleCompleteTask(1, { summary: 'Done' }, tokenData, env, ctx);
    expect(result.result).toBeDefined();

    await Promise.allSettled(ctx._promises);

    // stopSession was attempted and failed
    expect(stopSessionSpy).toHaveBeenCalled();

    // cleanupTaskRun still ran despite stopSession failure — prevents VM leaks
    expect(cleanupTaskRunSpy).toHaveBeenCalledWith('task-123', env);
  });
});
