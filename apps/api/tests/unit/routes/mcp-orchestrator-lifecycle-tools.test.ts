import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/routes/mcp/_helpers';
import { handleOverrideTaskState } from '../../../src/routes/mcp/orchestrator-lifecycle-tools';

const mocks = vi.hoisted(() => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  overrideTaskState: vi.fn(),
}));

vi.mock('../../../src/lib/logger', () => ({ log: mocks.log }));
vi.mock('../../../src/services/project-orchestrator', () => ({
  overrideTaskState: mocks.overrideTaskState,
}));

function createEnvWithTaskProject(projectId: string | null): Env {
  const first = vi.fn(async () => (
    projectId === null ? null : { projectId }
  ));
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));

  return {
    DATABASE: { prepare },
  } as unknown as Env;
}

const tokenData: McpTokenData = {
  workspaceId: 'workspace-1',
  projectId: 'project-caller',
  taskId: 'task-caller',
  sessionId: 'session-1',
  userId: 'user-1',
  tokenId: 'token-1',
  agentProfileId: null,
  taskMode: 'task',
};

describe('MCP orchestrator lifecycle tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects override_task_state when the target task belongs to another project', async () => {
    const env = createEnvWithTaskProject('project-target');

    const result = await handleOverrideTaskState(
      1,
      {
        missionId: 'mission-target',
        taskId: 'task-target',
        newState: 'blocked_human',
        reason: 'manual override',
      },
      tokenData,
      env,
    );

    expect(result.error).toMatchObject({
      code: -32602,
      message: 'Task not found',
      data: { httpStatus: 404 },
    });
    expect(mocks.overrideTaskState).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledWith('mcp.override_task_state.project_mismatch', {
      projectId: 'project-caller',
      callerProjectId: 'project-caller',
      missionId: 'mission-target',
      taskId: 'task-target',
      targetProjectId: 'project-target',
      expectedProjectId: 'project-caller',
      receivedProjectId: 'project-target',
      action: 'rejected',
    });
  });

  it('allows override_task_state when the target task belongs to the caller project', async () => {
    const env = createEnvWithTaskProject('project-caller');
    mocks.overrideTaskState.mockResolvedValueOnce(true);

    const result = await handleOverrideTaskState(
      1,
      {
        missionId: 'mission-caller',
        taskId: 'task-target',
        newState: 'blocked_human',
        reason: 'manual override',
      },
      tokenData,
      env,
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ success: true, taskId: 'task-target', newState: 'blocked_human' }) }],
    });
    expect(mocks.overrideTaskState).toHaveBeenCalledWith(
      env,
      'project-caller',
      'mission-caller',
      'task-target',
      'blocked_human',
      'manual override',
    );
  });
});
