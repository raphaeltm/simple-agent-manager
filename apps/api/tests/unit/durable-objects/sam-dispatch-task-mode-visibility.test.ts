import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  db: {
    select: vi.fn(),
  },
  createSession: vi.fn(),
  persistMessage: vi.fn(),
  resolveCredentialSource: vi.fn(),
  resolveAgentProfile: vi.fn(),
  generateTaskTitle: vi.fn(),
  startTaskRunnerDO: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(() => mocks.db),
}));

vi.mock('../../../src/services/agent-profiles', () => ({
  resolveAgentProfile: mocks.resolveAgentProfile,
}));

vi.mock('../../../src/services/provider-credentials', () => ({
  resolveCredentialSource: mocks.resolveCredentialSource,
}));

vi.mock('../../../src/services/project-data', () => ({
  createSession: mocks.createSession,
  persistMessage: mocks.persistMessage,
}));

vi.mock('../../../src/services/task-title', () => ({
  generateTaskTitle: mocks.generateTaskTitle,
  getTaskTitleConfig: vi.fn(() => ({})),
}));

vi.mock('../../../src/services/task-runner-do', () => ({
  startTaskRunnerDO: mocks.startTaskRunnerDO,
}));

vi.mock('../../../src/lib/ulid', () => ({
  ulid: vi.fn()
    .mockReturnValueOnce('01TASKMODETASKID')
    .mockReturnValueOnce('01TASKMODESTATUS')
    .mockReturnValue('01TASKMODEOTHER'),
}));

import { dispatchTask } from '../../../src/durable-objects/sam-session/tools/dispatch-task';

const project = {
  id: 'proj-1',
  name: 'Project',
  repository: 'owner/repo',
  defaultBranch: 'main',
  installationId: 'inst-1',
  defaultVmSize: null,
  defaultWorkspaceProfile: null,
  defaultProvider: null,
  defaultAgentType: null,
  defaultLocation: null,
  agentDefaults: null,
  taskExecutionTimeoutMs: null,
  maxWorkspacesPerNode: null,
  nodeCpuThresholdPercent: null,
  nodeMemoryThresholdPercent: null,
  warmNodeTimeoutMs: null,
};

function selectRows(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(rows)),
      })),
    })),
  };
}

function buildCtx() {
  const statement = {
    bind: vi.fn().mockReturnThis(),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };

  return {
    env: {
      DATABASE: {
        prepare: vi.fn(() => statement),
      },
      PROJECT_DATA: {
        idFromName: vi.fn(() => 'project-data-id'),
        get: vi.fn(() => ({
          fetch: vi.fn().mockResolvedValue(new Response('ok')),
        })),
      },
      AI: {},
      BASE_DOMAIN: 'example.com',
      BRANCH_NAME_PREFIX: 'sam/',
      BRANCH_NAME_MAX_LENGTH: '60',
    },
    userId: 'user-1',
  };
}

describe('SAM dispatch_task taskMode visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.db.select
      .mockImplementationOnce(() => selectRows([project]))
      .mockImplementationOnce(() => selectRows([{ name: 'User', email: 'user@example.com', githubId: '12345' }]));
    mocks.resolveAgentProfile.mockResolvedValue(null);
    mocks.resolveCredentialSource.mockResolvedValue({ source: 'user', credential: { id: 'cred-1' } });
    mocks.generateTaskTitle.mockResolvedValue('Generated task title');
    mocks.createSession.mockResolvedValue('session-1');
    mocks.persistMessage.mockResolvedValue('message-1');
    mocks.startTaskRunnerDO.mockResolvedValue(undefined);
  });

  it('includes taskMode in the dispatch response', async () => {
    const result = await dispatchTask(
      { projectId: 'proj-1', description: 'Build the feature', taskMode: 'task' },
      buildCtx(),
    ) as { taskMode?: string };

    expect(result.taskMode).toBe('task');
  });

  it('includes a warning when dispatch resolves to conversation mode', async () => {
    const result = await dispatchTask(
      { projectId: 'proj-1', description: 'Discuss the implementation', taskMode: 'conversation' },
      buildCtx(),
    ) as { taskMode?: string; warning?: string };

    expect(result.taskMode).toBe('conversation');
    expect(result.warning).toContain('will not auto-complete');
    expect(result.warning).toContain('send_message_to_subtask');
    expect(result.warning).toContain('get_session_messages');
    expect(result.warning).toContain('taskMode: "task"');
  });

  it('defaults to task mode even with a lightweight workspace profile', async () => {
    const result = await dispatchTask(
      { projectId: 'proj-1', description: 'Quick delegated task', workspaceProfile: 'lightweight' },
      buildCtx(),
    ) as { taskMode?: string };

    expect(result.taskMode).toBe('task');
    expect(mocks.startTaskRunnerDO).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        workspaceProfile: 'lightweight',
        taskMode: 'task',
      }),
    );
  });
});
