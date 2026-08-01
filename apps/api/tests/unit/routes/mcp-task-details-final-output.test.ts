import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { getFinalAssistantOutputForTask, handleGetTaskDetails } from '../../../src/routes/mcp/task-tools';

const getMessagesSpy = vi.fn();
let taskRows: TaskDetailRow[] = [];

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(taskRows),
        }),
      }),
    }),
  }),
}));

vi.mock('../../../src/services/project-data', () => ({
  getMessages: (...args: unknown[]) => getMessagesSpy(...args),
  recordActivityEvent: vi.fn().mockResolvedValue('activity-1'),
}));

vi.mock('../../../src/services/notification', () => ({
  getProjectName: vi.fn().mockResolvedValue('Project'),
  getChatSessionId: vi.fn().mockResolvedValue('session-1'),
  notifyProgress: vi.fn().mockResolvedValue(undefined),
  notifyTaskComplete: vi.fn().mockResolvedValue(undefined),
  notifySessionEnded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/project-orchestrator', () => ({
  notifyTaskEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/scheduler-state-sync', () => ({
  recomputeMissionSchedulerStates: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResources: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/services/trigger-execution-sync', () => ({
  syncTriggerExecutionStatus: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type TaskDetailRow = {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  outputBranch: string | null;
  outputPrUrl: string | null;
  outputSummary: string | null;
  completionEvidence: string | null;
  errorMessage: string | null;
  projectId: string;
  chatSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

function createEnv(row: TaskDetailRow | null): Env {
  taskRows = row ? [row] : [];
  return {
    DATABASE: {} as D1Database,
    PROJECT_DATA: {
      idFromName: vi.fn().mockReturnValue('project-data-id'),
      get: vi.fn(),
    },
  } as unknown as Env;
}

const tokenData: McpTokenData = {
  taskId: 'parent-task',
  projectId: 'proj-1',
  userId: 'user-1',
  workspaceId: 'ws-parent',
  createdAt: new Date().toISOString(),
};

const completedTask: TaskDetailRow = {
  id: 'child-task',
  title: 'Review implementation',
  description: 'Rank the remaining issues',
  status: 'completed',
  priority: 0,
  outputBranch: null,
  outputPrUrl: null,
  outputSummary: 'Completed review.',
  completionEvidence: null,
  errorMessage: null,
  projectId: 'proj-1',
  chatSessionId: 'session-child',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:05:00.000Z',
  startedAt: '2026-08-01T00:01:00.000Z',
  completedAt: '2026-08-01T00:05:00.000Z',
};

describe('MCP get_task_details finalAssistantOutput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns latest grouped assistant output for a completed child task while preserving existing fields', async () => {
    getMessagesSpy.mockResolvedValue({
      hasMore: false,
      messages: [
        { id: 'm4', role: 'assistant', content: '2. Then fix tests.', createdAt: 4 },
        { id: 'm3', role: 'assistant', content: 'Final ranked report:\n1. Fix API.\n', createdAt: 3 },
        { id: 'm2b', role: 'user', content: 'Please revise the report', createdAt: 2.5 },
        { id: 'm2', role: 'assistant', content: 'Earlier draft', createdAt: 2 },
      ],
    });

    const result = await handleGetTaskDetails(1, { taskId: 'child-task' }, tokenData, createEnv(completedTask));

    expect(result.error).toBeUndefined();
    const text = (result.result as { content: Array<{ text: string }> }).content[0].text;
    const body = JSON.parse(text);

    expect(body).toMatchObject({
      id: 'child-task',
      status: 'completed',
      outputSummary: 'Completed review.',
      sessionId: 'session-child',
    });
    expect(body.finalAssistantOutput).toBe('Final ranked report:\n1. Fix API.\n2. Then fix tests.');
    expect(getMessagesSpy).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'session-child',
      20,
      null,
      ['user', 'assistant'],
      false,
      'desc'
    );
  });

  it('omits final assistant content when the completed task has no session messages', async () => {
    getMessagesSpy.mockResolvedValue({ hasMore: false, messages: [] });

    const result = await handleGetTaskDetails(1, { taskId: 'child-task' }, tokenData, createEnv(completedTask));

    const text = (result.result as { content: Array<{ text: string }> }).content[0].text;
    const body = JSON.parse(text);

    expect(body.outputSummary).toBe('Completed review.');
    expect(body.finalAssistantOutput).toBeNull();
  });

  it('does not query ProjectData for active tasks', async () => {
    const output = await getFinalAssistantOutputForTask(createEnv(null), {
      projectId: 'proj-1',
      chatSessionId: 'session-child',
      status: 'in_progress',
    });

    expect(output).toBeNull();
    expect(getMessagesSpy).not.toHaveBeenCalled();
  });
});
