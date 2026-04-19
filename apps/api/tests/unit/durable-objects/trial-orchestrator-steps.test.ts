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
vi.mock('../../../src/services/trial/trial-runner', () => ({
  emitTrialEvent: emitTrialEventMock,
  emitTrialEventForProject: vi.fn(async () => {}),
  startDiscoveryAgent: startDiscoveryAgentMock,
}));

vi.mock('../../../src/services/trial/trial-store', () => ({
  readTrial: vi.fn(async () => null),
  readTrialByProject: vi.fn(async () => null),
  writeTrial: vi.fn(async () => {}),
}));

vi.mock('../../../src/services/project-data', () => ({
  linkSessionToWorkspace: vi.fn(async () => {}),
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

const { handleRunning, handleDiscoveryAgentStart, handleNodeProvisioning } = await import(
  '../../../src/durable-objects/trial-orchestrator/steps'
);

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
    },
    _storage: storage,
  };
}

function makeRc(ctx: ReturnType<typeof makeCtx>, advanced: string[]) {
  return {
    env: {
      DATABASE: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({ run: vi.fn(async () => {}) })),
        })),
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
});

describe('handleDiscoveryAgentStart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws a permanent error when projectId or workspaceId is missing', async () => {
    const ctx = makeCtx();
    const rc = makeRc(ctx, []);
    const state = makeState({ projectId: null, workspaceId: null });

    let caught: Error & { permanent?: boolean } = new Error('never');
    try {
      await handleDiscoveryAgentStart(state, rc);
    } catch (err) {
      caught = err as Error & { permanent?: boolean };
    }
    expect(caught.message).toMatch(/projectId and workspaceId/);
    expect(caught.permanent).toBe(true);
    // startDiscoveryAgent must NOT have been called.
    expect(startDiscoveryAgentMock).not.toHaveBeenCalled();
  });

  it('is idempotent: already-linked session skips startDiscoveryAgent and advances to running', async () => {
    const ctx = makeCtx();
    const advanced: string[] = [];
    const rc = makeRc(ctx, advanced);
    const state = makeState({
      projectId: 'proj_X',
      workspaceId: 'ws_X',
      chatSessionId: 'cs_X',
      acpSessionId: 'acp_X',
    });
    await handleDiscoveryAgentStart(state, rc);
    expect(startDiscoveryAgentMock).not.toHaveBeenCalled();
    expect(advanced).toEqual(['running']);
  });
});
