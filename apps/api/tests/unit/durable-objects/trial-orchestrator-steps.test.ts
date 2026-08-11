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

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Stub the trial-runner so handleDiscoveryAgentStart doesn't reach the real
// worker-side session bootstrap.
const { startDiscoveryAgentMock, emitTrialEventMock } = vi.hoisted(() => ({
  startDiscoveryAgentMock: vi.fn(),
  emitTrialEventMock: vi.fn(async () => {}),
}));
const { drizzleMock, signCallbackTokenMock } = vi.hoisted(() => ({
  drizzleMock: vi.fn(),
  signCallbackTokenMock: vi.fn(async () => 'callback-token'),
}));
vi.mock('drizzle-orm/d1', () => ({ drizzle: drizzleMock }));
vi.mock('../../../src/services/jwt', () => ({
  signCallbackToken: signCallbackTokenMock,
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

vi.mock('../../../src/services/node-agent', () => ({
  createAgentSessionOnNode: vi.fn(async () => {}),
  startAgentSessionOnNode: vi.fn(async () => {}),
  createWorkspaceOnNode: vi.fn(async () => {}),
}));

vi.mock('../../../src/services/mcp-token', () => ({
  generateMcpToken: vi.fn(() => 'mcp_tok_idempotent'),
  storeMcpToken: vi.fn(async () => {}),
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

// getRuntimeLimits returns a small fixture — handleNodeProvisioning only reads
// `nodeHeartbeatStaleSeconds` for the createNodeRecord call.
vi.mock('../../../src/services/limits', () => ({
  getRuntimeLimits: vi.fn(() => ({ nodeHeartbeatStaleSeconds: 120 })),
}));

const {
  handleRunning,
  handleDiscoveryAgentStart,
  handleNodeSelection,
  handleNodeProvisioning,
  handleNodeAgentReady,
  handleWorkspaceCreation,
} = await import('../../../src/durable-objects/trial-orchestrator/steps');

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
    _dbBind: bindMock,
  } as unknown as Parameters<typeof handleRunning>[1];
}

describe('handleRunning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createNodeRecordMock.mockResolvedValue({ id: 'node_new_123' });
    provisionNodeMock.mockResolvedValue(undefined);
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
    const rc = makeRc(ctx, advanced);
    const state = makeState({
      currentStep: 'node_provisioning',
      nodeId: null,
      autoProvisionedNode: false,
    });

    await handleNodeProvisioning(state, rc);

    expect(createNodeRecordMock).toHaveBeenCalledTimes(1);
    expect(provisionNodeMock).toHaveBeenCalledWith('node_new_123', expect.anything());
    expect(state.nodeId).toBe('node_new_123');
    expect(state.autoProvisionedNode).toBe(true);
    expect(advanced).toEqual(['node_agent_ready']);
  });

  it('persists a typed terminal provider failure from the handler boundary', async () => {
    const ctx = makeCtx();
    const rc = makeRc(ctx, []) as Parameters<typeof handleNodeProvisioning>[1] & {
      _dbFirst: ReturnType<typeof vi.fn>;
    };
    const decidedAt = new Date().toISOString();
    const state = makeState({
      currentStep: 'node_provisioning',
      nodeId: 'node_failed',
      placementExplanation: {
        schemaVersion: 2,
        outcome: 'provisioned',
        selectionPath: 'provisioning',
        selectedNodeId: 'node_failed',
        summary: 'Provisioning a new node.',
        request: {
          runtime: 'vm',
          vmSize: 'small',
          vmLocation: 'fsn1',
          maxWorkspacesPerNode: 5,
          cpuThresholdPercent: 80,
          memoryThresholdPercent: 85,
          heartbeatStaleSeconds: 120,
        },
        evaluatedNodes: [],
        provisioningAttempts: [{ vmSize: 'small', vmLocation: 'fsn1', outcome: 'started' }],
        decidedAt,
        updatedAt: decidedAt,
      },
    });
    rc._dbFirst.mockResolvedValue({ status: 'error', error_message: 'provider detail' });

    await expect(handleNodeProvisioning(state, rc)).rejects.toThrow('provider detail');
    expect(state.placementExplanation.provisioningAttempts.at(-1)).toMatchObject({
      outcome: 'failed',
      failureReason: 'provider-failed',
    });
  });
});

describe('handleNodeSelection', () => {
  it('reuses a compatible D1 candidate and persists the selected explanation', async () => {
    const requiredVersion = 'a'.repeat(40);
    const queryResults: unknown[][] = [
      [
        {
          id: '01KZR2JAP92AK3SKW951E4H21M',
          status: 'running',
          runtime: 'vm',
          vmSize: 'medium',
          vmLocation: 'hel1',
          healthStatus: 'healthy',
          lastHeartbeatAt: new Date().toISOString(),
          agentReadyAt: new Date().toISOString(),
          agentVersion: requiredVersion,
          lastMetrics: JSON.stringify({ cpuLoadAvg1: 2, memoryPercent: 10 }),
          warmSince: null,
        },
      ],
      [],
    ];
    drizzleMock.mockReturnValue({
      select: vi.fn(() => {
        const rows = queryResults.shift() ?? [];
        return { from: vi.fn(() => ({ where: vi.fn(async () => rows) })) };
      }),
    });
    const ctx = makeCtx();
    const advanced: string[] = [];
    const rc = makeRc(ctx, advanced) as Parameters<typeof handleNodeSelection>[1] & {
      _dbBind: ReturnType<typeof vi.fn>;
    };
    Object.assign(rc.env, {
      TRIAL_VM_SIZE: 'medium',
      TRIAL_VM_LOCATION: 'hel1',
      VM_AGENT_REQUIRED_VERSION: requiredVersion,
    });
    const state = makeState({ currentStep: 'node_selection', projectId: 'project-1' });

    await handleNodeSelection(state, rc);

    expect(state.nodeId).toBe('01KZR2JAP92AK3SKW951E4H21M');
    expect(state.placementExplanation).toMatchObject({
      outcome: 'reused',
      selectionPath: 'trial',
      selectedNodeId: '01KZR2JAP92AK3SKW951E4H21M',
    });
    expect(rc._dbBind).toHaveBeenCalledWith(
      expect.stringContaining('"schemaVersion":2'),
      state.trialId
    );
    expect(advanced).toEqual(['workspace_creation']);
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
    const decidedAt = new Date(waitStartedAt - 1_000).toISOString();
    state.placementExplanation = {
      schemaVersion: 2,
      outcome: 'provisioned',
      selectionPath: 'provisioning',
      selectedNodeId: null,
      summary: 'No reusable node was eligible; provisioning is required.',
      request: {
        runtime: 'vm',
        vmSize: 'small',
        vmLocation: 'fsn1',
        maxWorkspacesPerNode: 5,
        cpuThresholdPercent: 80,
        memoryThresholdPercent: 85,
        heartbeatStaleSeconds: 120,
      },
      evaluatedNodes: [],
      provisioningAttempts: [{ vmSize: 'small', vmLocation: 'fsn1', outcome: 'started' }],
      decidedAt,
      updatedAt: decidedAt,
    };

    await handleNodeAgentReady(state, rc);

    expect(advanced).toEqual(['workspace_creation']);
    expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
    expect(state.placementExplanation.provisioningAttempts).toEqual([
      { vmSize: 'small', vmLocation: 'fsn1', outcome: 'started' },
      { vmSize: 'small', vmLocation: 'fsn1', outcome: 'succeeded' },
    ]);
  });

  it('carries a successful provision explanation through the workspace D1 insert', async () => {
    const ctx = makeCtx();
    const advanced: string[] = [];
    const rc = makeRc(ctx, advanced) as Parameters<typeof handleNodeAgentReady>[1] & {
      _dbFirst: ReturnType<typeof vi.fn>;
    };
    const decidedAt = new Date(Date.now() - 10_000).toISOString();
    const state = makeState({
      currentStep: 'node_provisioning',
      projectId: 'project-1',
      defaultBranch: 'main',
      placementExplanation: {
        schemaVersion: 2,
        outcome: 'provisioned',
        selectionPath: 'provisioning',
        selectedNodeId: null,
        summary: 'No reusable node qualified; provisioning a new node.',
        request: {
          runtime: 'vm',
          vmSize: 'small',
          vmLocation: 'fsn1',
          maxWorkspacesPerNode: 5,
          cpuThresholdPercent: 80,
          memoryThresholdPercent: 85,
          heartbeatStaleSeconds: 120,
        },
        evaluatedNodes: [],
        provisioningAttempts: [],
        decidedAt,
        updatedAt: decidedAt,
      },
    });

    await handleNodeProvisioning(state, rc);
    expect(state.placementExplanation.provisioningAttempts.at(-1)?.outcome).toBe('started');

    const waitStartedAt = Date.now() - 5_000;
    state.nodeAgentReadyStartedAt = waitStartedAt;
    rc._dbFirst.mockResolvedValue({
      status: 'running',
      health_status: 'healthy',
      last_heartbeat_at: new Date(waitStartedAt + 2_000).toISOString(),
      agent_ready_at: new Date(waitStartedAt + 1_000).toISOString(),
      agent_version: null,
    });
    await handleNodeAgentReady(state, rc);
    expect(state.placementExplanation.provisioningAttempts.at(-1)?.outcome).toBe('succeeded');

    const inserted: Array<Record<string, unknown>> = [];
    drizzleMock.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(async () => []) })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(async (value: Record<string, unknown>) => {
          inserted.push(value);
        }),
      })),
    });
    await handleWorkspaceCreation(state, rc as never);

    expect(JSON.parse(inserted[0]?.placementExplanationJson as string)).toMatchObject({
      outcome: 'provisioned',
      selectedNodeId: 'node_new_123',
      provisioningAttempts: [{ outcome: 'started' }, { outcome: 'succeeded' }],
    });
    expect(advanced).toEqual(['node_agent_ready', 'workspace_creation', 'workspace_ready']);
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
