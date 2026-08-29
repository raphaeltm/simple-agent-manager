import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';
import { handleWorkspaceCreation } from '../../../src/durable-objects/task-runner/workspace-steps';

const ensureBranchExistsOnRemote = vi.fn();
vi.mock('../../../src/durable-objects/task-runner/workspace-branch', () => ({
  ensureBranchExistsOnRemote: (...args: unknown[]) => ensureBranchExistsOnRemote(...args),
}));

const markVmAdmissionPlaced = vi.fn();
vi.mock('../../../src/services/vm-admission-control', () => ({
  markVmAdmissionPlaced: (...args: unknown[]) => markVmAdmissionPlaced(...args),
  releaseVmProvisioningLease: vi.fn(),
}));

function createDatabase() {
  const runCalls: Array<{ sql: string; bound: unknown[] }> = [];
  return {
    runCalls,
    database: {
      prepare(sql: string) {
        let bound: unknown[] = [];
        return {
          bind(...args: unknown[]) {
            bound = args;
            return this;
          },
          first() {
            if (sql.includes('workspace_id AS workspaceId')) {
              return Promise.resolve({
                workspaceId: 'workspace-1',
                status: 'delegated',
                capacityPoolId: 'pool-user',
                capacityPoolScope: 'user',
                capacityPoolRevision: 7,
                capacitySourceId: 'source-user',
                capacityPoolCandidateId: 'candidate-cx42',
                placementCredentialSource: 'user',
                placementCredentialReference: 'credentials:user-hetzner',
                placementCredentialVersion: 1700000000000,
                capacityPoolProjectId: null,
                workloadRole: 'workspace',
                providerInstanceType: 'cx42',
                providerInstanceVcpuCount: 8,
                providerInstanceMemoryMb: 16 * 1024,
                providerInstanceDiskGb: 240,
                providerInstancePriceDisplay: '€18.49/mo',
                providerInstancePriceCurrency: 'EUR',
                providerInstancePriceMonthlyCents: 1849,
                providerInstancePriceHourlyMicros: 25329,
                placementExplanationJson: '{"candidate":"candidate-cx42"}',
              });
            }
            if (sql.includes('SELECT status FROM tasks WHERE id = ?')) {
              return Promise.resolve({ status: 'delegated' });
            }
            return Promise.resolve(null);
          },
          run() {
            runCalls.push({ sql, bound });
            return Promise.resolve({ meta: { changes: 1 } });
          },
        };
      },
    },
  };
}

function createContext(database: ReturnType<typeof createDatabase>['database']): TaskRunnerContext {
  return {
    env: { DATABASE: database },
    ctx: {
      storage: {
        put: vi.fn().mockResolvedValue(undefined),
      },
    },
    assertRecoveryAuthority: vi.fn().mockResolvedValue(undefined),
    advanceToStep: vi.fn().mockResolvedValue(undefined),
    updateD1ExecutionStep: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskRunnerContext;
}

function createState(): TaskRunnerState {
  return {
    version: 1,
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    currentStep: 'workspace_creation',
    stepResults: {
      nodeId: 'node-1',
      autoProvisioned: true,
      workspaceId: null,
      chatSessionId: null,
      agentSessionId: null,
      agentStarted: false,
      mcpToken: null,
      provisionedVmSize: 'large',
    },
    config: {
      vmSize: 'large',
      vmLocation: 'fsn1',
      branch: 'main',
      preferredNodeId: null,
      userName: null,
      userEmail: null,
      githubId: null,
      taskTitle: 'workspace recovery',
      taskDescription: null,
      repository: 'owner/repo',
      installationId: '123',
      outputBranch: 'sam/task-1',
      defaultBranch: 'main',
      projectDefaultVmSize: null,
      chatSessionId: null,
      agentType: null,
      workspaceProfile: null,
      devcontainerConfigName: null,
      cloudProvider: 'hetzner',
      credentialAttributionUserId: 'user-1',
      credentialAttributionProjectId: null,
      credentialAttributionSource: 'user',
      taskMode: 'task',
      model: null,
      effort: null,
      permissionMode: null,
      opencodeProvider: null,
      opencodeBaseUrl: null,
      systemPromptAppend: null,
      agentProfileHint: null,
      attachments: null,
      projectScaling: null,
      capacityPoolSelection: null,
      vmSizeSource: 'project',
    },
    retryCount: 0,
    workspaceReadyReceived: false,
    workspaceReadyStatus: null,
    workspaceErrorMessage: null,
    createdAt: Date.now(),
    lastStepAt: Date.now(),
    provisioningStartedAt: null,
    agentReadyStartedAt: null,
    workspaceReadyStartedAt: null,
    workspaceDispatchStartedAt: null,
    workspaceDispatchAttempts: 0,
    workspaceDispatchLastAttemptAt: null,
    workspaceDispatchLastError: null,
    workspaceDispatchAckedAt: null,
    lastD1Step: null,
    admissionScopeKey: null,
    admissionLeaseToken: null,
    completed: false,
  } as unknown as TaskRunnerState;
}

describe('TaskRunner workspace recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rehydrates concrete provider offering metadata from the task placement snapshot', async () => {
    const { database } = createDatabase();
    const rc = createContext(database);
    const state = createState();

    await handleWorkspaceCreation(state, rc);

    expect(state.stepResults.workspaceId).toBe('workspace-1');
    expect(state.stepResults.capacityPlacementSnapshot).toMatchObject({
      capacityPoolId: 'pool-user',
      capacityPoolCandidateId: 'candidate-cx42',
      providerInstanceType: 'cx42',
      providerInstanceVcpuCount: 8,
      providerInstanceMemoryMb: 16 * 1024,
      providerInstanceDiskGb: 240,
      providerInstancePriceDisplay: '€18.49/mo',
      providerInstancePriceCurrency: 'EUR',
      providerInstancePriceMonthlyCents: 1849,
      providerInstancePriceHourlyMicros: 25329,
    });
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'workspace_dispatch');
  });
});
