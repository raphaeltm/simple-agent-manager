/**
 * Unit tests for TrialOrchestrator step handlers.
 *
 * Covers the highest-value invariants that do not depend on D1/DO plumbing:
 *   - `handleRunning` marks state completed (terminal-for-orchestrator)
 *   - `handleDiscoveryAgentStart` throws a permanent error when the required
 *     projectId / workspaceId are missing (invariant: we never start an agent
 *     without its target workspace).
 *   - `handleDiscoveryAgentStart` idempotency: already-linked session skips
 *     the `startDiscoveryAgent` call and advances straight to `running`.
 *
 * Broader per-handler coverage (project_creation D1 inserts, node selection
 * branching, workspace readiness polling, etc.) is tracked separately in
 * tasks/backlog/2026-04-19-trial-orchestrator-step-handler-coverage.md — those
 * paths require mocking drizzle + node provisioning + project-data services,
 * which is out of scope for this PR.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn(),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub the trial-runner so handleDiscoveryAgentStart doesn't reach the real
// worker-side session bootstrap.
const { startDiscoveryAgentMock, emitTrialEventMock } = vi.hoisted(() => ({
  startDiscoveryAgentMock: vi.fn(),
  emitTrialEventMock: vi.fn(async () => {}),
}));
vi.mock('../../../src/services/trial/trial-runner', () => ({
  emitTrialEvent: emitTrialEventMock,
  emitTrialEventForProject: vi.fn(async () => {}),
  startDiscoveryAgent: startDiscoveryAgentMock,
  resolveTrialRunnerConfig: vi.fn(() => ({
    mode: 'staging' as const,
    agentType: 'opencode',
    model: '@cf/meta/llama-4-scout-17b-16e-instruct',
    provider: 'workers-ai' as const,
  })),
}));

vi.mock('../../../src/services/trial/trial-store', () => ({
  readTrial: vi.fn(async () => null),
  readTrialByProject: vi.fn(async () => null),
  writeTrial: vi.fn(async () => {}),
}));

vi.mock('../../../src/services/project-data', () => ({
  linkSessionToWorkspace: vi.fn(async () => {}),
  transitionAcpSession: vi.fn(async () => {}),
}));

const {
  assertTrialProvisioningAuthorityMock,
  cleanupFreshProvisioningNodeMock,
  createWorkspaceOnNodeMock,
  reserveWorkspacePlacementMock,
  resolveUniqueWorkspaceDisplayNameMock,
} = vi.hoisted(() => ({
  assertTrialProvisioningAuthorityMock: vi.fn(async () => {}),
  cleanupFreshProvisioningNodeMock: vi.fn(async () => 'placeholder-deleted'),
  createWorkspaceOnNodeMock: vi.fn(async () => {}),
  reserveWorkspacePlacementMock: vi.fn(async () => true),
  resolveUniqueWorkspaceDisplayNameMock: vi.fn(async () => ({
    displayName: 'trial-repo',
    normalizedDisplayName: 'trial-repo',
  })),
}));

vi.mock('../../../src/services/node-agent', () => ({
  createAgentSessionOnNode: vi.fn(async () => {}),
  startAgentSessionOnNode: vi.fn(async () => {}),
  createWorkspaceOnNode: createWorkspaceOnNodeMock,
}));

vi.mock('../../../src/services/mcp-token', () => ({
  generateMcpToken: vi.fn(() => 'mcp_tok_idempotent'),
  storeMcpToken: vi.fn(async () => {}),
}));

vi.mock('../../../src/services/provisioning-authority', () => ({
  assertTrialProvisioningAuthority: assertTrialProvisioningAuthorityMock,
  cleanupFreshProvisioningNode: cleanupFreshProvisioningNodeMock,
}));

vi.mock('../../../src/services/workspace-placement', () => ({
  reserveWorkspacePlacement: reserveWorkspacePlacementMock,
}));

vi.mock('../../../src/services/workspace-names', () => ({
  resolveUniqueWorkspaceDisplayName: resolveUniqueWorkspaceDisplayNameMock,
}));

// Mock services/nodes so handleNodeProvisioning doesn't reach real provider code.
const { createNodeRecordMock, provisionNodeMock } = vi.hoisted(() => ({
  createNodeRecordMock: vi.fn(),
  provisionNodeMock: vi.fn(async () => {}),
}));
vi.mock('../../../src/services/nodes', () => ({
  createNodeRecord: createNodeRecordMock,
  provisionNode: provisionNodeMock,
}));

const { placementProjectDefaultsFromRowMock, resolveCanonicalVmAllocationPlanMock } = vi.hoisted(
  () => ({
    placementProjectDefaultsFromRowMock: vi.fn(),
    resolveCanonicalVmAllocationPlanMock: vi.fn(),
  })
);
vi.mock('../../../src/services/canonical-vm-allocation', () => ({
  placementProjectDefaultsFromRow: placementProjectDefaultsFromRowMock,
  resolveCanonicalVmAllocationPlan: resolveCanonicalVmAllocationPlanMock,
}));

// getRuntimeLimits returns a small fixture — handleNodeProvisioning only reads
// `nodeHeartbeatStaleSeconds` for the createNodeRecord call.
vi.mock('../../../src/services/limits', () => ({
  getRuntimeLimits: vi.fn(() => ({ nodeHeartbeatStaleSeconds: 120 })),
}));

import { drizzle } from 'drizzle-orm/d1';

const {
  handleRunning,
  handleDiscoveryAgentStart,
  handleNodeProvisioning,
  handleNodeAgentReady,
  handleWorkspaceCreation,
} = await import('../../../src/durable-objects/trial-orchestrator/steps');

function makeProjectDb(selectResults?: unknown[][]) {
  const rows = selectResults ? [...selectResults] : null;
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn(async () => rows?.shift() ?? [projectRow()]),
        }),
      }),
    }),
  };
}

function projectRow() {
  return {
    id: 'proj_trial',
    defaultVmSize: 'medium',
    defaultProvider: 'hetzner',
    defaultLocation: 'fsn1',
    defaultWorkspaceProfile: 'lightweight',
    defaultDevcontainerConfigName: null,
    defaultAgentType: null,
  };
}

function trialAllocation() {
  return {
    placement: { workloadRole: 'workspace' },
    credential: { credentialSource: 'platform', providerName: 'hetzner' },
    quotaCredentialSource: 'platform',
    credentialAttributionUserId: 'anonymous-user',
    credentialAttributionProjectId: null,
    credentialAttributionSource: 'platform',
    effectiveProvider: 'hetzner',
    vmSize: 'medium',
    vmLocation: 'fsn1',
    providerInstanceType: 'cx22',
    providerInstanceBootDiskSizeGb: null,
    providerInstanceImage: null,
    providerInstanceArchitecture: null,
    capacityPoolSelection: null,
    capacityPlacementSnapshot: null,
  };
}

type Storage = Map<string, unknown>;

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    trialId: 'trial_steps_test',
    repoUrl: '',
    repoOwner: 'alice',
    repoName: 'repo',
    currentStep: 'discovery_agent_start',
    projectId: null,
    nodeId: null,
    autoProvisionedNode: false,
    workspaceId: null,
    chatSessionId: null,
    acpSessionId: null,
    retryCount: 0,
    createdAt: Date.now(),
    lastStepAt: Date.now(),
    nodeAgentReadyStartedAt: null,
    workspaceReadyStartedAt: null,
    completed: false,
    failureReason: null,
    ...overrides,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function makeCtx(storage: Storage = new Map()) {
  return {
    storage: {
      get: vi.fn(async (k: string) => storage.get(k)),
      put: vi.fn(async (k: string, v: unknown) => {
        storage.set(k, v);
      }),
      setAlarm: vi.fn(async () => {}),
    },
    _storage: storage,
  };
}

function makeRc(ctx: ReturnType<typeof makeCtx>, advanced: string[]) {
  const firstMock = vi.fn(async () => null);
  const bindMock = vi.fn(() => ({
    run: vi.fn(async () => {}),
    first: firstMock,
  }));
  const prepareMock = vi.fn(() => ({ bind: bindMock }));

  return {
    env: {
      DATABASE: {
        prepare: prepareMock,
      },
    } as unknown as Parameters<typeof handleRunning>[1]['env'],
    ctx: ctx as unknown as Parameters<typeof handleRunning>[1]['ctx'],
    advanceToStep: vi.fn(async (state, step: string) => {
      advanced.push(step);
      state.currentStep = step;
      state.lastStepAt = Date.now();
      await ctx.storage.put('state', state);
    }),
    getAgentReadyTimeoutMs: () => 60_000,
    getWorkspaceReadyTimeoutMs: () => 180_000,
    getWorkspaceReadyPollIntervalMs: () => 5_000,
    getNodeReadyTimeoutMs: () => 180_000,
    getHeartbeatSkewMs: () => 30_000,
    _dbFirst: firstMock,
  } as unknown as Parameters<typeof handleRunning>[1];
}

describe('handleRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks state.completed = true and persists', async () => {
    const ctx = makeCtx();
    const rc = makeRc(ctx, []);
    const state = makeState({ currentStep: 'running' });
    await handleRunning(state, rc);
    expect(state.completed).toBe(true);
    expect(ctx.storage.put).toHaveBeenCalledWith('state', state);
  });
});

describe('handleNodeProvisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(drizzle).mockReturnValue(makeProjectDb() as any);
    placementProjectDefaultsFromRowMock.mockImplementation((project) => project);
    resolveCanonicalVmAllocationPlanMock.mockResolvedValue(trialAllocation());
    assertTrialProvisioningAuthorityMock.mockResolvedValue(undefined);
    cleanupFreshProvisioningNodeMock.mockResolvedValue('placeholder-deleted');
    reserveWorkspacePlacementMock.mockResolvedValue(true);
    resolveUniqueWorkspaceDisplayNameMock.mockResolvedValue({
      displayName: 'trial-repo',
      normalizedDisplayName: 'trial-repo',
    });
    createWorkspaceOnNodeMock.mockResolvedValue(undefined);
    createNodeRecordMock.mockResolvedValue({ id: 'node_new_123' });
    provisionNodeMock.mockResolvedValue(undefined);
  });

  // Regression for the async-IP provider bug: provisionNode() returns while
  // the node is still in 'creating' status for Scaleway/GCP (VM boots, IP
  // arrives on first heartbeat). The step MUST advance to `node_agent_ready`
  // unconditionally — the heartbeat polling in that step is what waits for
  // the VM to come up. Synchronously requiring status='running' here would
  // force every async-IP trial through the retry/backoff cycle until the
  // heartbeat landed, wasting the retry budget and risking permanent failure.
  it('advances to node_agent_ready even when provisionNode leaves status=creating', async () => {
    const ctx = makeCtx();
    const advanced: string[] = [];
    const rc = makeRc(ctx, advanced) as Parameters<typeof handleNodeProvisioning>[1] & {
      _dbFirst: ReturnType<typeof vi.fn>;
    };
    rc._dbFirst.mockResolvedValue({ status: 'creating', errorMessage: null });
    const state = makeState({
      currentStep: 'node_provisioning',
      projectId: 'proj_trial',
      nodeId: null,
      autoProvisionedNode: false,
    });

    await handleNodeProvisioning(state, rc);

    expect(createNodeRecordMock).toHaveBeenCalledTimes(1);
    expect(resolveCanonicalVmAllocationPlanMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        entryPoint: 'trial-orchestrator',
        projectId: 'proj_trial',
        workloadRole: 'workspace',
        requiredCredentialSource: 'platform',
      })
    );
    expect(provisionNodeMock).toHaveBeenCalledWith(
      'node_new_123',
      expect.anything(),
      undefined,
      expect.objectContaining({
        authorityProjectId: 'proj_trial',
        assertExternalMutationAuthority: expect.any(Function),
      })
    );
    const options = provisionNodeMock.mock.calls[0]![3] as {
      assertExternalMutationAuthority: () => Promise<void>;
    };
    await options.assertExternalMutationAuthority();
    expect(assertTrialProvisioningAuthorityMock).toHaveBeenCalledWith(expect.anything(), {
      trialId: 'trial_steps_test',
      projectId: 'proj_trial',
      userId: 'system_anonymous_trials',
    });
    expect(state.nodeId).toBe('node_new_123');
    expect(state.autoProvisionedNode).toBe(true);
    expect(advanced).toEqual(['node_agent_ready']);
  });

  it('does not advance when provisioning leaves a trial node in a terminal error state', async () => {
    const ctx = makeCtx();
    const advanced: string[] = [];
    const rc = makeRc(ctx, advanced) as Parameters<typeof handleNodeProvisioning>[1] & {
      _dbFirst: ReturnType<typeof vi.fn>;
    };
    rc._dbFirst.mockResolvedValue({
      status: 'error',
      errorMessage: 'provider cleanup failed after VM create',
    });
    const state = makeState({
      currentStep: 'node_provisioning',
      projectId: 'proj_trial',
      nodeId: null,
      autoProvisionedNode: false,
    });

    await expect(handleNodeProvisioning(state, rc)).rejects.toThrow(
      'provider cleanup failed after VM create'
    );

    expect(advanced).toEqual([]);
  });
});

describe('handleWorkspaceCreation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(drizzle).mockReturnValue(
      makeProjectDb([
        [projectRow()],
        [
          {
            id: 'node_trial_auto',
            capacityPoolId: null,
            capacityPoolScope: null,
            capacityPoolRevision: null,
            capacitySourceId: null,
            capacitySourceGeneration: null,
            capacitySourceExternalRef: null,
            capacityPoolCandidateId: null,
            placementCredentialSource: null,
            placementCredentialReference: null,
            placementCredentialVersion: null,
            capacityPoolProjectId: null,
            workloadRole: null,
          },
        ],
      ]) as any
    );
    placementProjectDefaultsFromRowMock.mockImplementation((project) => project);
    resolveCanonicalVmAllocationPlanMock.mockResolvedValue(trialAllocation());
    cleanupFreshProvisioningNodeMock.mockResolvedValue('placeholder-deleted');
    reserveWorkspacePlacementMock.mockResolvedValue(false);
    resolveUniqueWorkspaceDisplayNameMock.mockResolvedValue({
      displayName: 'trial-repo',
      normalizedDisplayName: 'trial-repo',
    });
  });

  it('cleans up an auto-provisioned trial node when final admission fails', async () => {
    const ctx = makeCtx();
    const advanced: string[] = [];
    const rc = makeRc(ctx, advanced);
    const state = makeState({
      currentStep: 'workspace_creation',
      projectId: 'proj_trial',
      nodeId: 'node_trial_auto',
      autoProvisionedNode: true,
      workspaceId: null,
    });

    await handleWorkspaceCreation(state, rc);

    expect(reserveWorkspacePlacementMock).toHaveBeenCalled();
    expect(cleanupFreshProvisioningNodeMock).toHaveBeenCalledWith(rc.env, {
      nodeId: 'node_trial_auto',
      userId: 'system_anonymous_trials',
      nodeRole: 'workspace',
      reason: 'trial_workspace_final_admission_failed',
    });
    expect(createWorkspaceOnNodeMock).not.toHaveBeenCalled();
    expect(state.nodeId).toBeNull();
    expect(state.autoProvisionedNode).toBe(false);
    expect(advanced).toEqual(['node_selection']);
  });
});

describe('handleNodeAgentReady', () => {
  function setupNodeAgentReady(
    nodeId: string,
    dbRow: { last_heartbeat_at: string; agent_ready_at: string | null }
  ) {
    const ctx = makeCtx();
    const advanced: string[] = [];
    const rc = makeRc(ctx, advanced) as Parameters<typeof handleNodeAgentReady>[1] & {
      _dbFirst: ReturnType<typeof vi.fn>;
    };
    const waitStartedAt = Date.now() - 5_000;
    const state = makeState({
      currentStep: 'node_agent_ready',
      nodeId,
      nodeAgentReadyStartedAt: waitStartedAt,
    });
    rc._dbFirst.mockResolvedValue({
      status: 'running',
      health_status: 'healthy',
      ...dbRow,
    });
    return { advanced, ctx, rc, state, waitStartedAt };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not advance on an early heartbeat without a /ready signal', async () => {
    const waitStartedAt = Date.now() - 5_000;
    const { advanced, ctx, rc, state } = setupNodeAgentReady('node_early', {
      last_heartbeat_at: new Date(waitStartedAt + 1_000).toISOString(),
      agent_ready_at: null,
    });

    await handleNodeAgentReady(state, rc);

    expect(advanced).toEqual([]);
    expect(ctx.storage.setAlarm).toHaveBeenCalled();
  });

  it('advances after the VM agent sends a fresh /ready signal', async () => {
    const waitStartedAt = Date.now() - 5_000;
    const { advanced, ctx, rc, state } = setupNodeAgentReady('node_ready', {
      last_heartbeat_at: new Date(waitStartedAt + 2_000).toISOString(),
      agent_ready_at: new Date(waitStartedAt + 1_000).toISOString(),
    });

    await handleNodeAgentReady(state, rc);

    expect(advanced).toEqual(['workspace_creation']);
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
  });
});

describe('handleDiscoveryAgentStart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws a permanent error when projectId, workspaceId, or nodeId is missing', async () => {
    const ctx = makeCtx();
    const rc = makeRc(ctx, []);
    const state = makeState({ projectId: null, workspaceId: null, nodeId: null });

    let caught: Error & { permanent?: boolean } = new Error('never');
    try {
      await handleDiscoveryAgentStart(state, rc);
    } catch (err) {
      caught = err as Error & { permanent?: boolean };
    }
    expect(caught.message).toMatch(/projectId, workspaceId, and nodeId/);
    expect(caught.permanent).toBe(true);
    // startDiscoveryAgent must NOT have been called.
    expect(startDiscoveryAgentMock).not.toHaveBeenCalled();
  });

  it('is idempotent: already-booted session skips all VM calls and advances to running', async () => {
    const ctx = makeCtx();
    const advanced: string[] = [];
    const rc = makeRc(ctx, advanced);
    const state = makeState({
      projectId: 'proj_X',
      workspaceId: 'ws_X',
      nodeId: 'node_X',
      chatSessionId: 'cs_X',
      acpSessionId: 'acp_X',
      mcpToken: 'mcp_tok_X',
      agentSessionCreatedOnVm: true,
      agentStartedOnVm: true,
      acpAssignedOnVm: true,
      acpRunningOnVm: true,
    });
    await handleDiscoveryAgentStart(state, rc);
    expect(startDiscoveryAgentMock).not.toHaveBeenCalled();
    expect(advanced).toEqual(['running']);
  });
});
