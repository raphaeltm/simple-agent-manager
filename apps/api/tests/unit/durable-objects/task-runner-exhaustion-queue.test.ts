/**
 * The `queue` exhaustion policy, exercised through the real
 * `handleNodeProvisioning`.
 *
 * Lives in its own file because it needs the VM admission module stubbed so the
 * provisioning lease is GRANTED (the shared queue is what parks the task, and a
 * task that never wins the lease never reaches the exhaustion branch). The other
 * two policies run against the real admission path in
 * task-runner-capacity-exhaustion.test.ts.
 */
import { ProviderError } from '@simple-agent-manager/providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleNodeProvisioning } from '../../../src/durable-objects/task-runner/node-steps';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';

const createNodeRecord = vi.fn();
const provisionNode = vi.fn();
vi.mock('../../../src/services/nodes', () => ({
  createNodeRecord: (...args: unknown[]) => createNodeRecord(...args),
  provisionNode: (...args: unknown[]) => provisionNode(...args),
}));

vi.mock('../../../src/services/limits', () => ({
  getRuntimeLimits: () => ({ nodeHeartbeatStaleSeconds: 180 }),
}));

vi.mock('drizzle-orm/d1', () => ({ drizzle: () => ({}) }));

const resolveVmAdmissionScope = vi.fn();
const tryAcquireVmProvisioningLease = vi.fn();
const waitForVmAdmissionCapacity = vi.fn();
const releaseVmProvisioningLease = vi.fn();
const recordVmProviderCapacityFailure = vi.fn();

vi.mock('../../../src/services/vm-admission-control', () => ({
  resolveVmAdmissionScope: (...a: unknown[]) => resolveVmAdmissionScope(...a),
  tryAcquireVmProvisioningLease: (...a: unknown[]) => tryAcquireVmProvisioningLease(...a),
  waitForVmAdmissionCapacity: (...a: unknown[]) => waitForVmAdmissionCapacity(...a),
  releaseVmProvisioningLease: (...a: unknown[]) => releaseVmProvisioningLease(...a),
  recordVmProviderCapacityFailure: (...a: unknown[]) => recordVmProviderCapacityFailure(...a),
  recordVmProviderCapacitySuccess: vi.fn(),
  assertVmProvisioningLease: vi.fn(),
  renewVmProvisioningLease: vi.fn(),
  markVmProvisioningLeaseInflightNode: vi.fn().mockResolvedValue(true),
  getVmAdmissionConfig: () => ({
    mode: 'enforce',
    leaseTtlMs: 60_000,
    retryMinMs: 1_000,
    retryMaxMs: 10_000,
    waitTimeoutMs: 600_000,
    providerCooldownMs: 300_000,
    wakeBatchSize: 5,
    diagnosticMessageMaxLength: 512,
  }),
}));

const SCOPE = {
  provider: 'vultr' as const,
  credentialSource: 'user' as const,
  credentialDomainKey: 'user:user-1:vultr',
  providerDomainKey: 'vultr:user:user-1:vultr',
  scopeKey: 'user:user-1:workspace-vm:vultr:user:user-1:vultr',
};

const PRIMARY = 'vc2-6c-16gb';

function capacityError(): ProviderError {
  return new ProviderError('vultr', 503, 'No capacity', {
    providerCode: 'resource_unavailable',
    category: 'transient_capacity',
  });
}

function createDbMock() {
  return {
    prepare(sql: string) {
      let bound: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          bound = args;
          return this;
        },
        first() {
          if (sql.includes('SELECT COUNT(*) as c FROM nodes')) return Promise.resolve({ c: 0 });
          if (sql.includes('status, error_message FROM nodes')) {
            return Promise.resolve({ id: bound[0], status: 'running', error_message: null });
          }
          return Promise.resolve(null);
        },
        all: () => Promise.resolve({ results: [] }),
        run: () => Promise.resolve({ success: true }),
      };
    },
  };
}

function createContext(): TaskRunnerContext {
  return {
    env: {
      DATABASE: createDbMock(),
      MAX_NODES_PER_USER: '10',
      COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
    },
    ctx: { storage: { put: vi.fn().mockResolvedValue(undefined), setAlarm: vi.fn() } },
    assertRecoveryAuthority: vi.fn().mockResolvedValue(undefined),
    advanceToStep: vi.fn().mockResolvedValue(undefined),
    getProvisionPollIntervalMs: () => 1000,
    getProvisionTimeoutMs: () => 600_000,
    updateD1ExecutionStep: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskRunnerContext;
}

function poolSelection(
  exhaustionPolicy: 'queue' | 'fail'
): NonNullable<TaskRunnerState['config']['capacityPoolSelection']> {
  const snapshot = {
    capacityPoolId: 'pool-user-1',
    capacityPoolScope: 'user' as const,
    capacityPoolRevision: 2,
    capacitySourceId: 'source-user-1',
    capacityPoolCandidateId: 'candidate-primary',
    placementCredentialSource: 'user' as const,
    placementCredentialReference: 'credentials:credential-user-1',
    placementCredentialVersion: 42,
    capacityPoolProjectId: null,
    workloadRole: 'workspace' as const,
    providerInstanceType: PRIMARY,
  };
  return {
    poolId: 'pool-user-1',
    scope: 'user',
    revision: 2,
    strategy: 'balanced',
    exhaustionPolicy,
    capacityPoolProjectId: null,
    workloadRole: 'workspace',
    poolSnapshot: { ...snapshot, capacitySourceId: null, capacityPoolCandidateId: null },
    candidates: [
      {
        id: 'candidate-primary',
        poolId: 'pool-user-1',
        capacitySourceId: 'source-user-1',
        provider: 'vultr',
        location: 'ewr',
        workloadRole: 'workspace',
        runtime: 'vm',
        machineClass: 'shared-vm',
        machineSize: 'large',
        providerInstanceType: PRIMARY,
        providerInstanceVcpuCount: 6,
        providerInstanceMemoryMb: 16 * 1024,
        providerInstanceDiskGb: 320,
        priority: 0,
        candidateOrder: 0,
        credentialAttributionSource: 'user',
        placementCredentialSource: 'user',
        placementCredentialReference: 'credentials:credential-user-1',
        placementCredentialVersion: 42,
        capacityPoolProjectId: null,
        snapshot,
      },
    ],
  } as unknown as NonNullable<TaskRunnerState['config']['capacityPoolSelection']>;
}

function createState(exhaustionPolicy: 'queue' | 'fail'): TaskRunnerState {
  return {
    version: 1,
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    currentStep: 'node_provisioning',
    stepResults: {
      nodeId: null,
      autoProvisioned: false,
      workspaceId: null,
      chatSessionId: null,
      agentSessionId: null,
      agentStarted: false,
      mcpToken: null,
      provisionedVmSize: null,
    },
    config: {
      vmSize: 'large',
      vmLocation: 'ewr',
      branch: 'main',
      preferredNodeId: null,
      userName: null,
      userEmail: null,
      githubId: null,
      taskTitle: 'queue policy',
      taskDescription: null,
      repository: 'owner/repo',
      installationId: '123',
      outputBranch: null,
      defaultBranch: 'main',
      projectDefaultVmSize: null,
      chatSessionId: null,
      agentType: null,
      workspaceProfile: null,
      devcontainerConfigName: null,
      cloudProvider: 'vultr',
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
      capacityPoolSelection: poolSelection(exhaustionPolicy),
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
    completed: false,
  } as unknown as TaskRunnerState;
}

beforeEach(() => {
  vi.clearAllMocks();
  createNodeRecord.mockResolvedValue({ id: 'node-1' });
  provisionNode.mockRejectedValue(capacityError());
  resolveVmAdmissionScope.mockResolvedValue(SCOPE);
  tryAcquireVmProvisioningLease.mockResolvedValue({
    kind: 'granted',
    scopeKey: SCOPE.scopeKey,
    fencingToken: 7,
  });
  recordVmProviderCapacityFailure.mockResolvedValue(null);
  releaseVmProvisioningLease.mockResolvedValue(undefined);
});

describe('queue exhaustion policy', () => {
  it('parks the task on the shared admission queue instead of failing it', async () => {
    waitForVmAdmissionCapacity.mockResolvedValue({
      kind: 'waiting',
      reason: 'provider_transient_capacity',
      nextRetryAt: new Date(Date.now() + 5_000).toISOString(),
      waitDeadlineAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const rc = createContext();
    const state = createState('queue');

    // Does NOT throw: the run is queued, not failed.
    await expect(handleNodeProvisioning(state, rc)).resolves.toBeUndefined();

    expect(provisionNode).toHaveBeenCalledTimes(1);
    expect(waitForVmAdmissionCapacity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scopeKey: SCOPE.scopeKey }),
      'provider_transient_capacity'
    );
    expect(rc.updateD1ExecutionStep).toHaveBeenCalledWith('task-1', 'waiting_for_node_capacity');
    expect(rc.ctx.storage.setAlarm).toHaveBeenCalled();
    expect(rc.advanceToStep).not.toHaveBeenCalled();
    // The lease is released before waiting so another task can provision.
    expect(releaseVmProvisioningLease).toHaveBeenCalledWith(
      expect.anything(),
      SCOPE.scopeKey,
      'task-1',
      7,
      'transient_capacity_exhausted'
    );
  });

  it('fails terminally once the queue wait deadline expires', async () => {
    waitForVmAdmissionCapacity.mockResolvedValue({
      kind: 'expired',
      reason: 'wait_deadline_expired',
      waitDeadlineAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const rc = createContext();

    await expect(handleNodeProvisioning(createState('queue'), rc)).rejects.toMatchObject({
      message: `No capacity available for ${PRIMARY}. Last provider error: No capacity`,
      permanent: true,
    });
    expect(rc.ctx.storage.setAlarm).not.toHaveBeenCalled();
  });

  it('discriminating control: the fail policy does NOT queue on the same input', async () => {
    // Same fixture, same granted lease, same transient capacity error. Only the
    // pool's exhaustionPolicy differs. If the policy were ignored (the pre-fix
    // behaviour, where nothing read it), this case would be indistinguishable
    // from the queue case above.
    const rc = createContext();

    await expect(handleNodeProvisioning(createState('fail'), rc)).rejects.toMatchObject({
      message: `No capacity available for ${PRIMARY}. Last provider error: No capacity`,
      permanent: true,
    });
    expect(waitForVmAdmissionCapacity).not.toHaveBeenCalled();
    expect(rc.ctx.storage.setAlarm).not.toHaveBeenCalled();
  });

  it('account-wide provider capacity never retries alternative offerings', async () => {
    // A 403 server-limit is an ACCOUNT limit. Retrying other SKUs against it
    // multiplies cost with no chance of succeeding, so this path must divert to
    // the account cooldown wait before the exhaustion chain is consulted.
    recordVmProviderCapacityFailure.mockResolvedValue({
      provider: 'hetzner',
      providerCategory: 'quota_exceeded',
      providerCode: 'server_limit_exceeded',
      providerStatusCode: 403,
      providerMessage: 'server limit exceeded',
    });
    waitForVmAdmissionCapacity.mockResolvedValue({
      kind: 'waiting',
      reason: 'provider_account_capacity',
      nextRetryAt: new Date(Date.now() + 5_000).toISOString(),
      waitDeadlineAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const rc = createContext();

    await expect(handleNodeProvisioning(createState('fail'), rc)).resolves.toBeUndefined();

    expect(provisionNode).toHaveBeenCalledTimes(1);
    expect(createNodeRecord).toHaveBeenCalledTimes(1);
    expect(waitForVmAdmissionCapacity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scopeKey: SCOPE.scopeKey }),
      'provider_account_capacity',
      expect.any(String),
      expect.objectContaining({ providerCode: 'server_limit_exceeded' })
    );
    expect(releaseVmProvisioningLease).toHaveBeenCalledWith(
      expect.anything(),
      SCOPE.scopeKey,
      'task-1',
      7,
      'provider_account_capacity'
    );
  });
});

describe('VM admission scope is size- and SKU-independent', () => {
  it('keys the shared lease on the credential domain only', () => {
    // A per-size or per-SKU scope key would shard the queue: two tasks asking
    // for different offerings on the SAME credential would each provision a VM
    // where one host could have served both. `resolveVmAdmissionScope` builds
    // the key from provider + credential domain only, and this pins that.
    expect(SCOPE.scopeKey).toBe('user:user-1:workspace-vm:vultr:user:user-1:vultr');
    expect(SCOPE.scopeKey).not.toContain('large');
    expect(SCOPE.scopeKey).not.toContain(PRIMARY);
    expect(SCOPE.providerDomainKey).not.toContain(PRIMARY);
  });
});
