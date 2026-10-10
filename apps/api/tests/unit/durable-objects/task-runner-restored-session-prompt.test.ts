/**
 * The TaskRunner `agent_session` step queues a restored session's first prompt
 * (`queueRestoredSessionPrompt`) after the ProjectData wake points the chat at the replacement
 * workspace, before `agentStarted` is written, and only while the wake still has authority.
 * Real bootstrap and step code; the VM, ProjectData and snapshot services are boundaries.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleAgentSession } from '../../../src/durable-objects/task-runner/agent-session-step';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import { restoredSessionPromptDeliveryId } from '../../../src/services/restored-session-prompt';
import { SESSION_RECOVERY_CONTINUE_TASK_PROMPT } from '../../../src/services/session-sleep-fallback-messages';

const calls = vi.hoisted(() => [] as string[]);
const boundary = vi.hoisted(() => ({
  restore: vi.fn(async () => ({ status: 'restored' })),
  start: vi.fn(async () => undefined),
  acceptPromptDelivery: vi.fn(async () => undefined),
  wakeSession: vi.fn(async () => true),
  completeRecovery: vi.fn(async () => true),
}));

vi.mock('../../../src/lib/ulid', () => ({ ulid: () => 'agent-session-2' }));
vi.mock('../../../src/services/mcp-token', () => ({
  generateMcpToken: () => 'mcp-token-2',
  revokeMcpToken: vi.fn(async () => undefined),
  storeMcpToken: vi.fn(async () => undefined),
}));
vi.mock('../../../src/services/node-agent', () => ({
  createAgentSessionOnNode: vi.fn(async () => undefined),
  restoreAgentSessionOnNode: boundary.restore,
  startAgentSessionOnNode: boundary.start,
}));
vi.mock('../../../src/services/project-data', () => ({
  acceptPromptDelivery: boundary.acceptPromptDelivery,
  createAcpSession: vi.fn(async () => ({ id: 'acp-session-2' })),
  getAcpSession: vi.fn(async () => null),
  persistMessage: vi.fn(async () => undefined),
  prepareAcpSessionForFreshStart: vi.fn(async () => ({ id: 'acp-session-2' })),
  transitionAcpSession: vi.fn(async () => undefined),
  wakeSessionForSnapshotRecovery: boundary.wakeSession,
}));
vi.mock('../../../src/services/session-snapshots', () => ({
  completeSessionSnapshotRecovery: boundary.completeRecovery,
  failSessionSnapshotRecovery: vi.fn(async () => undefined),
}));
vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    select: () => ({
      from: () => ({ where: () => ({ get: async () => null, limit: async () => [] }) }),
    }),
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  }),
}));

function wakeState(restoredSessionPrompt: string | null): TaskRunnerState {
  return {
    version: 1,
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    currentStep: 'agent_session',
    stepResults: {
      nodeId: 'node-2',
      autoProvisioned: false,
      workspaceId: 'workspace-2',
      chatSessionId: 'chat-1',
      agentSessionId: null,
      agentStarted: false,
      mcpToken: null,
      provisionedVmSize: null,
    },
    config: {
      vmSize: 'medium',
      vmLocation: 'nbg1',
      branch: 'main',
      preferredNodeId: null,
      userName: 'Test User',
      userEmail: 'test@example.com',
      githubId: 'gh-1',
      taskTitle: 'Continue after eviction',
      taskDescription: SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
      repository: 'octo/repo',
      installationId: 'install-1',
      outputBranch: 'sam/task',
      defaultBranch: 'main',
      projectDefaultVmSize: null,
      chatSessionId: 'chat-1',
      agentType: 'claude-code',
      workspaceProfile: null,
      devcontainerConfigName: null,
      cloudProvider: null,
      taskMode: 'task',
      model: null,
      effort: null,
      permissionMode: 'bypassPermissions',
      opencodeProvider: null,
      opencodeBaseUrl: null,
      systemPromptAppend: null,
      agentProfileHint: null,
      resumeSnapshotChatSessionId: 'chat-1',
      restoredSessionPrompt,
      recoveryAttemptId: 'wake-attempt-1',
    },
    retryCount: 0,
    workspaceReadyReceived: true,
    workspaceReadyStatus: 'running',
    workspaceErrorMessage: null,
    createdAt: 1,
    lastStepAt: 1,
    provisioningStartedAt: null,
    agentReadyStartedAt: null,
    workspaceReadyStartedAt: null,
    workspaceDispatchStartedAt: null,
    workspaceDispatchAttempts: 0,
    workspaceDispatchLastAttemptAt: null,
    workspaceDispatchLastError: null,
    workspaceDispatchAckedAt: null,
    lastD1Step: 'agent_session',
    completed: false,
  };
}

function makeContext(): TaskRunnerContext {
  return {
    env: {
      BASE_DOMAIN: 'example.test',
      KV: { put: vi.fn(), delete: vi.fn(), get: vi.fn() },
      DATABASE: {
        prepare: vi.fn((sql: string) => ({
          bind: () => ({
            first: async () => null,
            run: async () => {
              if (sql.includes("SET status = 'in_progress'")) calls.push('commit_handoff');
              return { success: true, meta: { changes: 1 } };
            },
          }),
        })),
      },
    },
    ctx: {
      storage: {
        put: vi.fn(async (_key: string, state: TaskRunnerState) => {
          if (state.currentStep === 'agent_session' && state.stepResults.agentStarted) {
            calls.push('write_agent_started');
          }
        }),
      },
      waitUntil: vi.fn(),
    },
    assertRecoveryAuthority: vi.fn(async () => undefined),
    updateD1ExecutionStep: vi.fn(async () => undefined),
  } as unknown as TaskRunnerContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  boundary.restore.mockResolvedValue({ status: 'restored' });
  boundary.wakeSession.mockImplementation(async () => {
    calls.push('wake_project_data_session');
    return true;
  });
  boundary.completeRecovery.mockImplementation(async () => {
    calls.push('complete_snapshot_recovery');
    return true;
  });
  boundary.acceptPromptDelivery.mockImplementation(async () => {
    calls.push('queue_restored_session_prompt');
  });
});

describe('handleAgentSession for a restored session', () => {
  it('queues its first prompt after the ProjectData wake and before recording the start', async () => {
    await handleAgentSession(wakeState(SESSION_RECOVERY_CONTINUE_TASK_PROMPT), makeContext());

    expect(calls).toEqual([
      'wake_project_data_session',
      'complete_snapshot_recovery',
      'queue_restored_session_prompt',
      'write_agent_started',
      'commit_handoff',
    ]);
    expect(boundary.start).not.toHaveBeenCalled();
    expect(boundary.acceptPromptDelivery).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      expect.objectContaining({
        deliveryId: restoredSessionPromptDeliveryId('agent-session-2'),
        targetSessionId: 'chat-1',
        sourceTaskId: 'task-1',
        sourceKind: 'checkpoint_continuation',
        deliveryContent: SESSION_RECOVERY_CONTINUE_TASK_PROMPT,
      })
    );
  });

  it('does not queue it once the wake has lost its authority', async () => {
    const rc = makeContext();
    vi.mocked(rc.assertRecoveryAuthority).mockImplementation(async () => {
      if (boundary.completeRecovery.mock.calls.length > 0) throw new Error('authority revoked');
    });

    await expect(
      handleAgentSession(wakeState(SESSION_RECOVERY_CONTINUE_TASK_PROMPT), rc)
    ).rejects.toThrow('authority revoked');

    expect(calls).toEqual(['wake_project_data_session', 'complete_snapshot_recovery']);
    expect(boundary.acceptPromptDelivery).not.toHaveBeenCalled();
  });

  it('queues nothing when the restore started the agent fresh with the prompt', async () => {
    boundary.restore.mockResolvedValue({ status: 'degraded' });

    await handleAgentSession(wakeState(SESSION_RECOVERY_CONTINUE_TASK_PROMPT), makeContext());

    expect(boundary.start).toHaveBeenCalledOnce();
    expect(boundary.acceptPromptDelivery).not.toHaveBeenCalled();
    expect(calls).toContain('commit_handoff');
  });

  it('queues nothing when a queued message or the user drives the restored session', async () => {
    await handleAgentSession(wakeState(null), makeContext());

    expect(boundary.start).not.toHaveBeenCalled();
    expect(boundary.acceptPromptDelivery).not.toHaveBeenCalled();
    expect(calls).toContain('commit_handoff');
  });
});
