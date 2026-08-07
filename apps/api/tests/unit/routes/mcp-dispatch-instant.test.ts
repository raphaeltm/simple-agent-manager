import { beforeEach, describe, expect, it, vi } from 'vitest';

const instantSessionMocks = vi.hoisted(() => ({
  acceptInstantSession: vi.fn(),
  markInstantLaunchFailed: vi.fn(),
}));

const taskFailureMocks = vi.hoisted(() => ({
  markQueuedTaskFailed: vi.fn(),
}));

vi.mock('../../../src/services/instant-session', () => ({
  acceptInstantSession: instantSessionMocks.acceptInstantSession,
  markInstantLaunchFailed: instantSessionMocks.markInstantLaunchFailed,
}));

vi.mock('../../../src/services/task-failure', () => ({
  markQueuedTaskFailed: taskFailureMocks.markQueuedTaskFailed,
}));

import { log } from '../../../src/lib/logger';
import {
  type LaunchDispatchedInstantInput,
  launchDispatchedInstantSession,
} from '../../../src/routes/mcp/dispatch-instant';

function makeInput(): LaunchDispatchedInstantInput {
  return {
    taskId: 'task-1',
    project: { id: 'proj-1' } as LaunchDispatchedInstantInput['project'],
    userId: 'user-1',
    fullDescription: 'Fix the bug',
    agentType: 'openai-codex',
    branch: 'main',
    taskMode: 'task',
  };
}

function makeAccepted() {
  return {
    taskId: 'task-1',
    runtime: 'cf-container',
    nodeId: 'node-1',
    workspaceId: 'ws-1',
    projectId: 'proj-1',
    chatSessionId: 'chat-1',
    agentType: 'openai-codex',
    containerId: 'node-1',
    workspaceUrl: 'https://ws-ws-1.example.com',
    branch: 'main',
    workspaceName: 'fix-the-bug',
    workspaceDir: '/workspaces/repo',
    nodeCallbackToken: 'token',
    startedAt: 0,
    gitSource: { repoProvider: 'github' },
  };
}

const fakeDb = { marker: 'db' } as never;

function makeEnv(startInstantLaunch: ReturnType<typeof vi.fn>) {
  return {
    TASK_RUNNER: {
      idFromName: vi.fn(() => ({ name: 'do-id' })),
      get: vi.fn(() => ({ startInstantLaunch })),
    },
  } as never;
}

describe('launchDispatchedInstantSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskFailureMocks.markQueuedTaskFailed.mockResolvedValue(true);
    instantSessionMocks.markInstantLaunchFailed.mockResolvedValue(undefined);
  });

  it('accepts inline and hands the launch to the TaskRunner DO', async () => {
    const accepted = makeAccepted();
    instantSessionMocks.acceptInstantSession.mockResolvedValueOnce(accepted);
    const startInstantLaunch = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv(startInstantLaunch);

    await expect(launchDispatchedInstantSession(fakeDb, env, makeInput())).resolves.toBeUndefined();

    expect(instantSessionMocks.acceptInstantSession).toHaveBeenCalledTimes(1);
    expect(instantSessionMocks.acceptInstantSession).toHaveBeenCalledWith(
      fakeDb,
      env,
      expect.objectContaining({
        taskId: 'task-1',
        initialPrompt: 'Fix the bug',
        taskMode: 'task',
      })
    );
    // The durable handoff receives the SAME launch input and accepted record —
    // the DO alarm runs the continuation from these exact values.
    expect(startInstantLaunch).toHaveBeenCalledTimes(1);
    expect(startInstantLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1' }),
      accepted
    );
    expect(taskFailureMocks.markQueuedTaskFailed).not.toHaveBeenCalled();
    expect(instantSessionMocks.markInstantLaunchFailed).not.toHaveBeenCalled();
  });

  it('appends the profile system prompt to the initial prompt', async () => {
    instantSessionMocks.acceptInstantSession.mockResolvedValueOnce(makeAccepted());
    const startInstantLaunch = vi.fn().mockResolvedValue(undefined);
    const env = makeEnv(startInstantLaunch);

    await launchDispatchedInstantSession(fakeDb, env, {
      ...makeInput(),
      systemPromptAppend: 'Always answer in French.',
    });

    expect(instantSessionMocks.acceptInstantSession).toHaveBeenCalledWith(
      fakeDb,
      env,
      expect.objectContaining({
        initialPrompt: 'Fix the bug\n\nAlways answer in French.',
        displayMessage: 'Fix the bug',
      })
    );
  });

  it('marks the queued task failed and rethrows when accept fails', async () => {
    instantSessionMocks.acceptInstantSession.mockRejectedValueOnce(new Error('quota exceeded'));
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const startInstantLaunch = vi.fn();
    const env = makeEnv(startInstantLaunch);

    await expect(launchDispatchedInstantSession(fakeDb, env, makeInput())).rejects.toThrow(
      'quota exceeded'
    );

    expect(taskFailureMocks.markQueuedTaskFailed).toHaveBeenCalledWith(
      fakeDb,
      'task-1',
      'Instant launch failed: quota exceeded'
    );
    expect(startInstantLaunch).not.toHaveBeenCalled();
    expect(instantSessionMocks.markInstantLaunchFailed).not.toHaveBeenCalled();
  });

  it('still rethrows the original accept error when failure persistence fails', async () => {
    instantSessionMocks.acceptInstantSession.mockRejectedValueOnce(new Error('quota exceeded'));
    taskFailureMocks.markQueuedTaskFailed.mockRejectedValueOnce(new Error('D1 unavailable'));
    const logSpy = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const env = makeEnv(vi.fn());

    await expect(launchDispatchedInstantSession(fakeDb, env, makeInput())).rejects.toThrow(
      'quota exceeded'
    );
    expect(logSpy).toHaveBeenCalledWith(
      'mcp.dispatch_task.instant_failure_persist_failed',
      expect.objectContaining({ taskId: 'task-1', error: 'D1 unavailable' })
    );
  });

  it('tears down accepted resources and rethrows when the DO handoff fails', async () => {
    const accepted = makeAccepted();
    instantSessionMocks.acceptInstantSession.mockResolvedValueOnce(accepted);
    vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const startInstantLaunch = vi.fn().mockRejectedValueOnce(new Error('do unavailable'));
    const env = makeEnv(startInstantLaunch);

    await expect(launchDispatchedInstantSession(fakeDb, env, makeInput())).rejects.toThrow(
      'do unavailable'
    );

    expect(instantSessionMocks.markInstantLaunchFailed).toHaveBeenCalledWith(
      fakeDb,
      env,
      {
        taskId: 'task-1',
        projectId: 'proj-1',
        chatSessionId: 'chat-1',
        workspaceId: 'ws-1',
        nodeId: 'node-1',
        containerId: 'node-1',
      },
      'Instant launch handoff failed: do unavailable'
    );
    // Full teardown supersedes the queued-only marker on this path.
    expect(taskFailureMocks.markQueuedTaskFailed).not.toHaveBeenCalled();
  });
});
