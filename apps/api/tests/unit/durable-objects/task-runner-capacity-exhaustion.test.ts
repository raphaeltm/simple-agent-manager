/**
 * Capacity-exhaustion behaviour of the real `node_provisioning` step.
 *
 * Renamed from task-runner-size-fallback.test.ts. The legacy VM-size descent
 * this file used to assert (large -> medium -> small on transient capacity) is
 * GONE: it silently provisioned smaller hardware than the caller's resolved
 * requirements asked for whenever the size happened to be default-derived.
 * The tests that asserted the descent were removed rather than relaxed; the
 * invariants worth keeping ("an explicit size never downgrades", "a non-capacity
 * provider error fails fast") were kept and are now stronger, because NOTHING
 * downgrades a size any more.
 *
 * What replaces the descent is the effective pool's own `exhaustionPolicy`,
 * exercised below through `handleNodeProvisioning` itself.
 */
import { ProviderError } from '@simple-agent-manager/providers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleNodeProvisioning } from '../../../src/durable-objects/task-runner/node-steps';
import type {
  TaskRunnerContext,
  TaskRunnerState,
} from '../../../src/durable-objects/task-runner/types';

// Mock the dynamically-imported service modules. node-steps imports these via
// `await import(...)` inside handleNodeProvisioning, so the mocks apply to the
// dynamic import too.
const createNodeRecord = vi.fn();
const provisionNode = vi.fn();
vi.mock('../../../src/services/nodes', () => ({
  createNodeRecord: (...args: unknown[]) => createNodeRecord(...args),
  provisionNode: (...args: unknown[]) => provisionNode(...args),
}));

const getRuntimeLimits = vi.fn(() => ({ nodeHeartbeatStaleSeconds: 180 }));
vi.mock('../../../src/services/limits', () => ({
  getRuntimeLimits: (...args: unknown[]) => getRuntimeLimits(...args),
}));

const resolveCredentialSource = vi.fn();
vi.mock('../../../src/services/provider-credentials', () => ({
  resolveCredentialSource: (...args: unknown[]) => resolveCredentialSource(...args),
}));

const checkQuotaForUser = vi.fn();
vi.mock('../../../src/services/compute-quotas', () => ({
  checkQuotaForUser: (...args: unknown[]) => checkQuotaForUser(...args),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({}),
}));

function capacityError(size: string): ProviderError {
  return new ProviderError('hetzner', 503, `No ${size} capacity`, {
    providerCode: 'resource_unavailable',
    category: 'transient_capacity',
  });
}

/**
 * The 2026-09-09 production incident, at provider fidelity.
 *
 * `providerFetch` builds every HTTP ProviderError as
 * `new ProviderError(name, status, message, { providerCode })` — with NO `category`, so it
 * defaults to 'unknown'. Every pre-existing test in this file uses `capacityError()`, which
 * hand-feeds `category: 'transient_capacity'`; that is why the whole fallback-chain suite was
 * green while the chain was dead in production (`.claude/rules/62`). This factory must never
 * set `category`.
 *
 * Message and status are copied verbatim from prod `platform_errors`
 * (`statusCode: 412`, "hetzner API error (412): error during placement").
 */
function placementError(): ProviderError {
  return new ProviderError('hetzner', 412, 'hetzner API error (412): error during placement', {
    providerCode: 'placement_error',
  });
}

/** The same 412, with no structured code at all — the shape prod logs actually prove. */
function placementErrorWithoutCode(): ProviderError {
  return new ProviderError('hetzner', 412, 'hetzner API error (412): error during placement');
}

/**
 * Discriminating control: a genuinely non-capacity provider failure, built the same way
 * `providerFetch` builds it. Must still fail fast without touching the alternative.
 */
function authError(): ProviderError {
  return new ProviderError('hetzner', 401, 'hetzner API error (401): invalid token', {
    providerCode: 'unauthorized',
  });
}

/** Sentinel returned by a `firstResolver` to defer to the default SELECT handling. */
const FALLTHROUGH = Symbol('fallthrough');

interface DbMockOptions {
  nodeCount?: number;
  /** Status returned by the post-provision verification SELECT, keyed by node id. */
  nodeStatusById?: Record<string, { status: string; error_message: string | null }>;
  /**
   * Optional override for `.first()` results. Return a row (or null) to handle a
   * query, or FALLTHROUGH to use the default COUNT/status handling. Lets the
   * crash-recovery tests express only their differing SELECT branches without
   * re-declaring the whole prepare/bind/first/run mock.
   */
  firstResolver?: (sql: string, bound: unknown[]) => unknown;
}

function createDbMock(opts: DbMockOptions) {
  const runCalls: Array<{ sql: string; args: unknown[] }> = [];
  const DATABASE = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      return {
        bind(...args: unknown[]) {
          bound = args;
          return this;
        },
        first() {
          if (opts.firstResolver) {
            const resolved = opts.firstResolver(sql, bound);
            if (resolved !== FALLTHROUGH) return Promise.resolve(resolved);
          }
          if (sql.includes('SELECT COUNT(*) as c FROM nodes')) {
            return Promise.resolve({ c: opts.nodeCount ?? 0 });
          }
          if (sql.includes('SELECT status, error_message FROM nodes')) {
            const id = String(bound[0]);
            return Promise.resolve(
              opts.nodeStatusById?.[id] ?? { status: 'running', error_message: null }
            );
          }
          return Promise.resolve(null);
        },
        all() {
          return Promise.resolve({ results: [] });
        },
        run() {
          runCalls.push({ sql, args: bound });
          return Promise.resolve({ success: true });
        },
      };
    },
  };
  return { DATABASE, runCalls };
}

/** Locate the UPDATE that persists the provisioned (downgraded) size, if any. */
function findDowngradeWrite(runCalls: Array<{ sql: string; args: unknown[] }>) {
  return runCalls.find((c) => c.sql.includes('UPDATE tasks SET provisioned_vm_size = ?'));
}

function createContext(
  database: ReturnType<typeof createDbMock>['DATABASE'],
  envOverrides: Record<string, string> = {}
): TaskRunnerContext {
  return {
    env: {
      DATABASE: database,
      MAX_NODES_PER_USER: '10',
      COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false',
      ...envOverrides,
    },
    ctx: {
      storage: {
        put: vi.fn().mockResolvedValue(undefined),
        setAlarm: vi.fn(),
      },
    },
    assertRecoveryAuthority: vi.fn().mockResolvedValue(undefined),
    advanceToStep: vi.fn().mockResolvedValue(undefined),
    getProvisionPollIntervalMs: vi.fn(() => 1000),
    getProvisionTimeoutMs: vi.fn(() => 600_000),
    updateD1ExecutionStep: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskRunnerContext;
}

function createState(
  overrides: {
    vmSize?: 'small' | 'medium' | 'large';
    vmSizeSource?: string;
    capacityPoolSelection?: TaskRunnerState['config']['capacityPoolSelection'];
  } = {}
): TaskRunnerState {
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
      vmSize: overrides.vmSize ?? 'large',
      vmLocation: 'fsn1',
      branch: 'main',
      preferredNodeId: null,
      userName: null,
      userEmail: null,
      githubId: null,
      taskTitle: 'capacity test',
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
      cloudProvider: null,
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
      capacityPoolSelection: overrides.capacityPoolSelection ?? null,
      vmSizeSource: (overrides.vmSizeSource ??
        'project') as TaskRunnerState['config']['vmSizeSource'],
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
  };
}

function capacityPoolSelection(): NonNullable<TaskRunnerState['config']['capacityPoolSelection']> {
  const snapshot = {
    capacityPoolId: 'pool-user-1',
    capacityPoolScope: 'user' as const,
    capacityPoolRevision: 2,
    capacitySourceId: 'source-user-1',
    capacityPoolCandidateId: 'candidate-user-large',
    placementCredentialSource: 'user' as const,
    placementCredentialReference: 'credentials:credential-user-1',
    placementCredentialVersion: 42,
    capacityPoolProjectId: null,
    workloadRole: 'workspace' as const,
    providerInstanceType: 'vc2-6c-16gb',
    providerInstanceVcpuCount: 6,
    providerInstanceMemoryMb: 16 * 1024,
    providerInstanceDiskGb: 320,
    providerInstancePriceDisplay: '~$80/mo',
    providerInstancePriceCurrency: 'USD',
    providerInstancePriceMonthlyCents: 8000,
    providerInstancePriceHourlyMicros: 109589,
    placementExplanationJson: JSON.stringify({ candidate: 'candidate-user-large' }),
  };
  return {
    poolId: 'pool-user-1',
    scope: 'user',
    revision: 2,
    strategy: 'pack',
    exhaustionPolicy: 'fail',
    capacityPoolProjectId: null,
    workloadRole: 'workspace',
    poolSnapshot: { ...snapshot, capacitySourceId: null, capacityPoolCandidateId: null },
    candidates: [
      {
        id: 'candidate-user-large',
        poolId: 'pool-user-1',
        capacitySourceId: 'source-user-1',
        provider: 'vultr',
        location: 'ewr',
        workloadRole: 'workspace',
        runtime: 'vm',
        machineClass: 'shared-vm',
        machineSize: 'large',
        providerInstanceType: 'vc2-6c-16gb',
        providerInstanceVcpuCount: 6,
        providerInstanceMemoryMb: 16 * 1024,
        providerInstanceDiskGb: 320,
        providerInstancePriceDisplay: '~$80/mo',
        providerInstancePriceCurrency: 'USD',
        providerInstancePriceMonthlyCents: 8000,
        providerInstancePriceHourlyMicros: 109589,
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getRuntimeLimits.mockReturnValue({ nodeHeartbeatStaleSeconds: 180 });
  createNodeRecord.mockImplementation(async (_env: unknown, opts: { vmSize: string }) => ({
    id: `node-${opts.vmSize}`,
  }));
});

describe('TaskRunner capacity exhaustion', () => {
  it('does not provision through legacy fallback when the selected pool has no candidates', async () => {
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({
      capacityPoolSelection: {
        ...capacityPoolSelection(),
        candidates: [],
      },
    });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message:
        'No active compute pool offerings in the selected user pool satisfy the requested resources.',
      permanent: true,
    });

    expect(createNodeRecord).not.toHaveBeenCalled();
    expect(provisionNode).not.toHaveBeenCalled();
  });

  it('rechecks source authority after alarm entry and before creating a node record', async () => {
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'medium', vmSizeSource: 'project' });
    const revoked = Object.assign(new Error('Session recovery authority was revoked'), {
      permanent: true,
    });
    vi.mocked(rc.assertRecoveryAuthority).mockRejectedValueOnce(revoked);

    await expect(handleNodeProvisioning(state, rc)).rejects.toBe(revoked);

    expect(createNodeRecord).not.toHaveBeenCalled();
    expect(provisionNode).not.toHaveBeenCalled();
  });

  it('rechecks authority between the node record and paid provider provisioning', async () => {
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'medium', vmSizeSource: 'project' });
    const revoked = Object.assign(new Error('Session recovery authority was revoked'), {
      permanent: true,
    });
    vi.mocked(rc.assertRecoveryAuthority)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(revoked);

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: 'Session recovery authority was revoked',
      permanent: true,
    });

    expect(createNodeRecord).toHaveBeenCalledOnce();
    expect(provisionNode).not.toHaveBeenCalled();
    expect(state.stepResults).toMatchObject({
      nodeId: 'node-medium',
      autoProvisioned: true,
    });
  });

  it('does NOT record a downgrade when the first (requested) size succeeds', async () => {
    provisionNode.mockResolvedValue(undefined);
    const { DATABASE, runCalls } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'large', vmSizeSource: 'project' });

    await handleNodeProvisioning(state, rc);

    expect(provisionNode).toHaveBeenCalledTimes(1);
    expect(state.stepResults.provisionedVmSize).toBe('large');
    expect(state.config.vmSize).toBe('large');
    expect(findDowngradeWrite(runCalls)).toBeUndefined();
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });

  it('auto-provisions with the selected capacity-pool candidate target and task snapshot', async () => {
    const { DATABASE, runCalls } = createDbMock({});
    const rc = createContext(DATABASE);
    const selection = capacityPoolSelection();
    const state = createState({
      vmSize: 'small',
      vmSizeSource: 'project',
      capacityPoolSelection: selection,
    });

    await handleNodeProvisioning(state, rc);

    expect(createNodeRecord).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        vmSize: 'large',
        vmLocation: 'ewr',
        cloudProvider: 'vultr',
        providerInstanceType: 'vc2-6c-16gb',
        credentialAttributionSource: 'user',
        capacityPlacementSnapshot: expect.objectContaining({
          capacityPoolId: 'pool-user-1',
          capacitySourceId: 'source-user-1',
          capacityPoolCandidateId: 'candidate-user-large',
          providerInstanceType: 'vc2-6c-16gb',
        }),
      })
    );
    expect(state.config.vmSize).toBe('large');
    expect(state.config.vmLocation).toBe('ewr');
    expect(state.config.cloudProvider).toBe('vultr');
    expect(state.config.providerInstanceType).toBe('vc2-6c-16gb');
    expect(state.stepResults.capacityPlacementSnapshot).toMatchObject({
      capacityPoolId: 'pool-user-1',
      capacitySourceId: 'source-user-1',
      capacityPoolCandidateId: 'candidate-user-large',
      providerInstanceType: 'vc2-6c-16gb',
    });
    expect(
      runCalls.find(
        (call) =>
          call.sql.includes('auto_provisioned_node_id') &&
          call.sql.includes('capacity_pool_candidate_id')
      )?.args
    ).toContain('candidate-user-large');
  });

  it('never downgrades an explicit size — fails with a clear message', async () => {
    provisionNode.mockImplementation(async () => {
      throw capacityError('large');
    });
    const { DATABASE, runCalls } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'large', vmSizeSource: 'task' });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: 'No capacity available for large.',
      permanent: true,
    });
    // Only the requested size attempted — no descent.
    expect(provisionNode).toHaveBeenCalledTimes(1);
    expect(findDowngradeWrite(runCalls)).toBeUndefined();
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });

  it.each(['trigger', 'agent-profile'])(
    'never downgrades a %s-sourced size — fails with a clear message',
    async (source) => {
      provisionNode.mockImplementation(async () => {
        throw capacityError('large');
      });
      const { DATABASE, runCalls } = createDbMock({});
      const rc = createContext(DATABASE);
      const state = createState({ vmSize: 'large', vmSizeSource: source });

      await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
        message: 'No capacity available for large.',
        permanent: true,
      });
      expect(provisionNode).toHaveBeenCalledTimes(1);
      expect(findDowngradeWrite(runCalls)).toBeUndefined();
      expect(rc.advanceToStep).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      label: 'non-capacity',
      error: new ProviderError('hetzner', 400, 'Bad VM config', {
        providerCode: 'invalid_input',
        category: 'invalid_config',
      }),
      message: 'Bad VM config',
    },
    {
      // quota_exceeded is NOT transient capacity — descent must not happen.
      label: 'quota-exhausted',
      error: new ProviderError('hetzner', 429, 'Server limit exceeded', {
        providerCode: 'server_limit_exceeded',
        category: 'quota_exceeded',
      }),
      message: 'Server limit exceeded',
    },
  ])('fails fast on a $label provider error without descending', async ({ error, message }) => {
    provisionNode.mockImplementation(async () => {
      throw error;
    });
    const { DATABASE, runCalls } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'large', vmSizeSource: 'project' });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message,
      permanent: true,
    });
    expect(provisionNode).toHaveBeenCalledTimes(1);
    expect(findDowngradeWrite(runCalls)).toBeUndefined();
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });

  it.each(['project', 'platform'])(
    'no longer descends a %s-default-derived size on transient capacity',
    async (source) => {
      // This is the removed legacy behaviour, asserted from the other side: a
      // default-derived size used to descend the large->medium->small ladder.
      // It now makes exactly one attempt, like every other size source.
      provisionNode.mockImplementation(async () => {
        throw capacityError('large');
      });
      const { DATABASE, runCalls } = createDbMock({});
      const rc = createContext(DATABASE);
      const state = createState({ vmSize: 'large', vmSizeSource: source });

      await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
        message: 'No capacity available for large.',
        permanent: true,
      });
      expect(provisionNode).toHaveBeenCalledTimes(1);
      expect(createNodeRecord).toHaveBeenCalledTimes(1);
      // Nothing smaller than the request was ever created.
      expect(createNodeRecord).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ vmSize: 'medium' })
      );
      expect(findDowngradeWrite(runCalls)).toBeUndefined();
    }
  );

  it('recovers an already-provisioned node after a crash instead of creating a duplicate', async () => {
    // Simulate a prior attempt that provisioned node-medium (a downgrade from
    // the requested large) but crashed before persisting nodeId to DO storage.
    // The task row still records the node via auto_provisioned_node_id.
    const { DATABASE, runCalls } = createDbMock({
      firstResolver(sql) {
        if (sql.includes('SELECT auto_provisioned_node_id FROM tasks')) {
          return { auto_provisioned_node_id: 'node-medium' };
        }
        if (sql.includes('vm_size AS vmSize')) {
          return {
            id: 'node-medium',
            status: 'running',
            vmSize: 'medium',
            capacityPoolId: null,
            capacityPoolScope: null,
            capacityPoolRevision: null,
            capacitySourceId: null,
            capacityPoolCandidateId: null,
            placementCredentialSource: null,
            placementCredentialReference: null,
            placementCredentialVersion: null,
            capacityPoolProjectId: null,
            workloadRole: null,
            placementExplanationJson: null,
          };
        }
        if (sql.includes('SELECT id, status, error_message FROM nodes')) {
          return { id: 'node-medium', status: 'running', error_message: null };
        }
        return FALLTHROUGH;
      },
    });
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'large', vmSizeSource: 'project' });

    await handleNodeProvisioning(state, rc);

    // No duplicate node created — the existing one was adopted.
    expect(createNodeRecord).not.toHaveBeenCalled();
    expect(provisionNode).not.toHaveBeenCalled();
    expect(state.stepResults.nodeId).toBe('node-medium');
    expect(state.stepResults.autoProvisioned).toBe(true);
    expect(state.stepResults.provisionedVmSize).toBe('medium');
    expect(state.config.vmSize).toBe('medium');
    // The hydrated state must be persisted to DO storage so a subsequent crash
    // resumes from the adopted node rather than re-running recovery.
    expect(rc.ctx.storage.put).toHaveBeenCalledWith('state', state);
    // The downgrade is re-recorded in case the crash pre-empted the original write.
    expect(findDowngradeWrite(runCalls)?.args[0]).toBe('medium');
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });

  it('does not adopt a capacity-deleted node row on recovery and (re)provisions', async () => {
    // auto_provisioned_node_id points to a node that was deleted after a capacity
    // failure — the row is gone, so recovery must fall through to fresh provisioning.
    provisionNode.mockResolvedValue(undefined);
    const { DATABASE } = createDbMock({
      firstResolver(sql) {
        if (sql.includes('SELECT auto_provisioned_node_id FROM tasks')) {
          return { auto_provisioned_node_id: 'node-deleted' };
        }
        if (sql.includes('vm_size AS vmSize')) {
          return null; // deleted row
        }
        return FALLTHROUGH;
      },
    });
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'large', vmSizeSource: 'project' });

    await handleNodeProvisioning(state, rc);

    expect(createNodeRecord).toHaveBeenCalledTimes(1);
    expect(provisionNode).toHaveBeenCalledTimes(1);
    expect(state.stepResults.nodeId).toBe('node-large');
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });

  it('fails fast on quota exhaustion before any node is created', async () => {
    resolveCredentialSource.mockResolvedValue({ credentialSource: 'platform' });
    checkQuotaForUser.mockResolvedValue({ allowed: false, used: 100, limit: 100 });
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE, { COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'true' });
    const state = createState({ vmSize: 'large', vmSizeSource: 'project' });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      permanent: true,
    });
    expect(createNodeRecord).not.toHaveBeenCalled();
    expect(provisionNode).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Exhaustion policy: the behaviour that replaced the legacy VM-size descent.
// ---------------------------------------------------------------------------

type PoolSelection = NonNullable<TaskRunnerState['config']['capacityPoolSelection']>;
type PoolCandidate = PoolSelection['candidates'][number];

/** A sibling offering in the SAME pool and the SAME capacity source. */
function siblingCandidate(overrides: Partial<PoolCandidate> & { id: string }): PoolCandidate {
  const base = capacityPoolSelection().candidates[0] as PoolCandidate;
  const merged = { ...base, ...overrides } as PoolCandidate;
  return {
    ...merged,
    snapshot: {
      ...(base.snapshot as NonNullable<PoolCandidate['snapshot']>),
      capacityPoolCandidateId: merged.id,
      capacitySourceId: merged.capacitySourceId,
      providerInstanceType: merged.providerInstanceType,
    },
  } as PoolCandidate;
}

function poolWith(
  exhaustionPolicy: 'fail' | 'queue' | 'fallback-chain',
  candidates: PoolCandidate[]
): PoolSelection {
  return { ...capacityPoolSelection(), exhaustionPolicy, candidates } as PoolSelection;
}

const PRIMARY = 'vc2-6c-16gb';
const ALTERNATE = 'vc2-8c-32gb';

/**
 * A second offering identical to the primary on every ranking signal (capacity,
 * price, priority) and differing only in `candidateOrder` and instance type.
 * That keeps this suite about the EXHAUSTION POLICY: whichever strategy the pool
 * carries, the primary ranks first, so a second provider call can only mean a
 * fallback actually happened.
 */
function alternateCandidate(): PoolCandidate {
  return siblingCandidate({
    id: 'candidate-user-alternate',
    providerInstanceType: ALTERNATE,
    candidateOrder: 1,
  });
}

/** Provider instance types actually handed to createNodeRecord, in order. */
function attemptedInstanceTypes(): Array<string | null | undefined> {
  return createNodeRecord.mock.calls.map(
    (call) => (call[1] as { providerInstanceType?: string | null }).providerInstanceType
  );
}

describe('TaskRunner capacity exhaustion policy', () => {
  beforeEach(() => {
    // `vi.clearAllMocks()` clears CALLS but not implementations, so a
    // `resolveCredentialSource` stub set by an earlier test in this file leaks
    // in and diverts these cases down the admission-lease path instead of the
    // provisioning loop. Pin it explicitly: no credential source means no
    // admission scope, which isolates exhaustion policy from lease behaviour
    // (the queue policy, which REQUIRES an admission scope, is covered in
    // task-runner-exhaustion-queue.test.ts).
    resolveCredentialSource.mockReset();
    provisionNode.mockReset();
    provisionNode.mockImplementation(async () => {
      throw capacityError('primary');
    });
  });

  it('fail: stops after the first offering even when the pool has alternatives', async () => {
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({
      capacityPoolSelection: poolWith('fail', [
        capacityPoolSelection().candidates[0] as PoolCandidate,
        alternateCandidate(),
      ]),
    });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: `No capacity available for ${PRIMARY}.`,
      permanent: true,
    });
    expect(provisionNode).toHaveBeenCalledTimes(1);
    expect(attemptedInstanceTypes()).toEqual([PRIMARY]);
    expect(rc.ctx.storage.setAlarm).not.toHaveBeenCalled();
  });

  it("fallback-chain: tries the pool's other permitted offering before failing", async () => {
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({
      capacityPoolSelection: poolWith('fallback-chain', [
        capacityPoolSelection().candidates[0] as PoolCandidate,
        alternateCandidate(),
      ]),
    });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: `No capacity for any permitted offering in this compute pool (tried ${PRIMARY}, ${ALTERNATE}).`,
      permanent: true,
    });
    expect(provisionNode).toHaveBeenCalledTimes(2);
    // Each attempt provisions its OWN offering, not a repeat of the first.
    expect(attemptedInstanceTypes()).toEqual([PRIMARY, ALTERNATE]);
  });

  it('fallback-chain: succeeds on the alternative and advances', async () => {
    provisionNode.mockImplementationOnce(async () => {
      throw capacityError('primary');
    });
    provisionNode.mockImplementationOnce(async () => undefined);
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({
      capacityPoolSelection: poolWith('fallback-chain', [
        capacityPoolSelection().candidates[0] as PoolCandidate,
        alternateCandidate(),
      ]),
    });

    await handleNodeProvisioning(state, rc);

    expect(attemptedInstanceTypes()).toEqual([PRIMARY, ALTERNATE]);
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
    // The run's recorded placement follows the offering actually provisioned.
    expect(state.config.providerInstanceType).toBe(ALTERNATE);
    expect(state.stepResults.capacityPlacementSnapshot?.capacityPoolCandidateId).toBe(
      'candidate-user-alternate'
    );
  });

  // ---------------------------------------------------------------------------------------
  // 2026-09-09 incident: Hetzner 412 "error during placement".
  //
  // Prod tasks 01M232PGCM4Q25TRJPNB3NX01A / 01M232Q6H5GTYAFGPZYK1DYRV3 /
  // 01M232QYT0S7WZGSH0KEH95ZPF each recorded
  //   attempts: [cx53 failed, cx43 not-attempted, cx33 not-attempted, cx23 not-attempted]
  // because `placement_error` classified as `invalid_config`, so `handleNodeProvisioning`
  // took its "any non-capacity provider failure fails fast" branch on the first offering.
  // All three tests below FAIL against pre-fix code.
  // ---------------------------------------------------------------------------------------

  it('fallback-chain: descends past a Hetzner 412 placement failure (incident regression)', async () => {
    provisionNode.mockImplementation(async () => {
      throw placementError();
    });
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({
      capacityPoolSelection: poolWith('fallback-chain', [
        capacityPoolSelection().candidates[0] as PoolCandidate,
        alternateCandidate(),
      ]),
    });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: `No capacity for any permitted offering in this compute pool (tried ${PRIMARY}, ${ALTERNATE}).`,
      permanent: true,
    });
    expect(attemptedInstanceTypes()).toEqual([PRIMARY, ALTERNATE]);
  });

  it('fallback-chain: descends on a 412 that carries no structured provider code', async () => {
    provisionNode.mockImplementation(async () => {
      throw placementErrorWithoutCode();
    });
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({
      capacityPoolSelection: poolWith('fallback-chain', [
        capacityPoolSelection().candidates[0] as PoolCandidate,
        alternateCandidate(),
      ]),
    });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({ permanent: true });
    expect(attemptedInstanceTypes()).toEqual([PRIMARY, ALTERNATE]);
  });

  it('fallback-chain: recovers on the alternative offering after a 412 (the user-visible fix)', async () => {
    provisionNode.mockImplementationOnce(async () => {
      throw placementError();
    });
    provisionNode.mockImplementationOnce(async () => undefined);
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({
      capacityPoolSelection: poolWith('fallback-chain', [
        capacityPoolSelection().candidates[0] as PoolCandidate,
        alternateCandidate(),
      ]),
    });

    await handleNodeProvisioning(state, rc);

    expect(attemptedInstanceTypes()).toEqual([PRIMARY, ALTERNATE]);
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
    expect(state.config.providerInstanceType).toBe(ALTERNATE);
  });

  // Consumer #4 of `isTransientCapacityError` (`node-provisioning-step.ts:592`). The diagnostic
  // outcome is what production's `tasks.placement_explanation_json` recorded during the incident
  // ("failed" / "Provider allocation failed"), and it is the artifact an operator reads to work
  // out why a run stopped. It must now say the offering ran out of capacity.
  it('records a 412 as capacity-exhausted in placement diagnostics, not a generic failure', async () => {
    provisionNode.mockImplementation(async () => {
      throw placementError();
    });
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({
      capacityPoolSelection: poolWith('fallback-chain', [
        capacityPoolSelection().candidates[0] as PoolCandidate,
        alternateCandidate(),
      ]),
    });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({ permanent: true });

    const attempts = state.stepResults.placementDiagnostics?.attempts ?? [];
    expect(attempts.map((a) => a.outcome)).toEqual(['capacity-exhausted', 'capacity-exhausted']);
    expect(attempts.map((a) => a.reason)).toEqual([
      'Provider offering has no available capacity',
      'Provider offering has no available capacity',
    ]);
  });

  it('records a non-capacity failure as a generic failure (discriminating control)', async () => {
    provisionNode.mockImplementation(async () => {
      throw authError();
    });
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({
      capacityPoolSelection: poolWith('fallback-chain', [
        capacityPoolSelection().candidates[0] as PoolCandidate,
        alternateCandidate(),
      ]),
    });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({ permanent: true });

    const attempts = state.stepResults.placementDiagnostics?.attempts ?? [];
    expect(attempts[0]?.outcome).toBe('failed');
    expect(attempts[0]?.reason).toBe('Provider allocation failed');
  });

  it('fallback-chain: a non-capacity provider failure still fails fast (discriminating control)', async () => {
    // Stays green before AND after the fix. Without it, "the chain descended" would also be
    // satisfied by a change that made EVERY provider error descend.
    provisionNode.mockImplementation(async () => {
      throw authError();
    });
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({
      capacityPoolSelection: poolWith('fallback-chain', [
        capacityPoolSelection().candidates[0] as PoolCandidate,
        alternateCandidate(),
      ]),
    });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: 'hetzner API error (401): invalid token',
      permanent: true,
    });
    expect(provisionNode).toHaveBeenCalledTimes(1);
    expect(attemptedInstanceTypes()).toEqual([PRIMARY]);
  });

  it('fallback-chain: refuses an alternative from a different capacity source credential', async () => {
    // Cross-credential-domain borrowing would run outside the admission lease
    // this task holds and would bill a source the caller was not authorized for.
    const foreign = siblingCandidate({
      id: 'candidate-foreign-source',
      capacitySourceId: 'source-other',
      providerInstanceType: ALTERNATE,
      candidateOrder: 1,
    });
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({
      capacityPoolSelection: poolWith('fallback-chain', [
        capacityPoolSelection().candidates[0] as PoolCandidate,
        foreign,
      ]),
    });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: `No capacity available for ${PRIMARY}.`,
      permanent: true,
    });
    expect(provisionNode).toHaveBeenCalledTimes(1);
    expect(attemptedInstanceTypes()).toEqual([PRIMARY]);
  });

  it('fallback-chain: refuses an alternative from a different pool', async () => {
    const otherPool = siblingCandidate({
      id: 'candidate-other-pool',
      poolId: 'pool-other',
      providerInstanceType: ALTERNATE,
      candidateOrder: 1,
    });
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({
      capacityPoolSelection: poolWith('fallback-chain', [
        capacityPoolSelection().candidates[0] as PoolCandidate,
        otherPool,
      ]),
    });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: `No capacity available for ${PRIMARY}.`,
      permanent: true,
    });
    expect(attemptedInstanceTypes()).toEqual([PRIMARY]);
  });

  it('fallback-chain: refuses an alternative billed to a different credential attribution', async () => {
    const otherAttribution = siblingCandidate({
      id: 'candidate-other-attribution',
      credentialAttributionSource: 'project',
      providerInstanceType: ALTERNATE,
      candidateOrder: 1,
    });
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({
      capacityPoolSelection: poolWith('fallback-chain', [
        capacityPoolSelection().candidates[0] as PoolCandidate,
        otherAttribution,
      ]),
    });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: `No capacity available for ${PRIMARY}.`,
      permanent: true,
    });
    expect(attemptedInstanceTypes()).toEqual([PRIMARY]);
  });

  it('an unpooled legacy run makes exactly one attempt and never substitutes', async () => {
    const { DATABASE } = createDbMock({});
    const rc = createContext(DATABASE);
    const state = createState({ vmSize: 'large', vmSizeSource: 'project' });

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: 'No capacity available for large.',
      permanent: true,
    });
    expect(provisionNode).toHaveBeenCalledTimes(1);
  });
});
