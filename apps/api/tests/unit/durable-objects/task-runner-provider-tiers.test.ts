/**
 * Cross-provider fallback by the pool's provider order (idea 01M6NXTF2RQ5QXHM7YZ4ZF0XBK, PR 3b).
 *
 * The step (`handleNodeProvisioning`), the tiered exhaustion plan, the failure handler, the tier
 * switch and the account-capacity classifier with its D1 cooldown write are all real. Every
 * provider error is produced by the real `GcpProvider` / `HetznerProvider` create path from a
 * production-shaped response (`.claude/rules/62`, `.claude/rules/72`). Only provisioning I/O and
 * the admission lease primitives are stubbed, with one scope per provider so the test can see
 * which credential domain each call ran in.
 */
import { GcpProvider, HetznerProvider, ProviderError } from '@simple-agent-manager/providers';
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

// The compute-quota gate's two lookups. Its own decision logic, and the capacity-aware source
// choice between them, stay real.
const resolveCredentialSource = vi.fn();
const checkQuotaForUser = vi.fn();
vi.mock('../../../src/services/provider-credentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/provider-credentials')>()),
  resolveCredentialSource: (...a: unknown[]) => resolveCredentialSource(...a),
}));
vi.mock('../../../src/services/compute-quotas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/compute-quotas')>()),
  checkQuotaForUser: (...a: unknown[]) => checkQuotaForUser(...a),
}));

const resolveVmAdmissionScope = vi.fn();
const tryAcquireVmProvisioningLease = vi.fn();
const waitForVmAdmissionCapacity = vi.fn();
const releaseVmProvisioningLease = vi.fn();
const recordVmProviderCapacitySuccess = vi.fn();

// Partial mock: `recordVmProviderCapacityFailure` stays REAL, so cooldowns come from real errors.
vi.mock('../../../src/services/vm-admission-control', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/vm-admission-control')>();
  return {
    ...actual,
    resolveVmAdmissionScope: (...a: unknown[]) => resolveVmAdmissionScope(...a),
    tryAcquireVmProvisioningLease: (...a: unknown[]) => tryAcquireVmProvisioningLease(...a),
    waitForVmAdmissionCapacity: (...a: unknown[]) => waitForVmAdmissionCapacity(...a),
    releaseVmProvisioningLease: (...a: unknown[]) => releaseVmProvisioningLease(...a),
    recordVmProviderCapacitySuccess: (...a: unknown[]) => recordVmProviderCapacitySuccess(...a),
    assertVmProvisioningLease: vi.fn(),
    renewVmProvisioningLease: vi.fn(),
    markVmProvisioningLeaseInflightNode: vi.fn().mockResolvedValue(true),
  };
});

function scopeFor(provider: string) {
  const credentialDomainKey = `user:user-1:${provider}`;
  const providerDomainKey = `${provider}:${credentialDomainKey}`;
  return {
    provider,
    credentialSource: 'user' as const,
    credentialDomainKey,
    providerDomainKey,
    scopeKey: `user:user-1:workspace-vm:${providerDomainKey}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Real provider errors
// ---------------------------------------------------------------------------------------------

const GCP_ZONE = 'us-central1-a';

/** Run the real `GcpProvider.createVM` against a stubbed Compute API and return its error. */
async function gcpCreateError(
  outcome:
    | { kind: 'http'; status: number; body: unknown }
    | { kind: 'operation'; errors: Array<{ code: string; message: string }> }
): Promise<ProviderError> {
  const originalFetch = globalThis.fetch;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/global/firewalls') && method === 'POST') {
      return json(
        { error: { code: 409, message: 'already exists', status: 'ALREADY_EXISTS' } },
        409
      );
    }
    if (url.endsWith(`/zones/${GCP_ZONE}/instances`) && method === 'POST') {
      if (outcome.kind === 'http') return json(outcome.body, outcome.status);
      return json({ name: 'operation-insert-1', status: 'PENDING' });
    }
    if (url.includes('/operations/operation-insert-1') && outcome.kind === 'operation') {
      return json({
        name: 'operation-insert-1',
        status: 'DONE',
        error: { errors: outcome.errors },
      });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  }) as typeof fetch;
  try {
    const err = await new GcpProvider('test-project', async () => 'token', GCP_ZONE)
      .createVM({ name: 'node-x', size: 'large', location: GCP_ZONE, userData: '#cloud-config' })
      .then(
        () => null,
        (e: unknown) => e
      );
    if (!(err instanceof ProviderError)) throw new Error('expected a ProviderError from createVM');
    return err;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const gcpStockout = () =>
  gcpCreateError({
    kind: 'operation',
    errors: [
      {
        code: 'ZONE_RESOURCE_POOL_EXHAUSTED',
        message: `The zone 'projects/test-project/zones/${GCP_ZONE}' does not have enough resources available to fulfill the request.  Try a different zone, or try again later.`,
      },
    ],
  });

const gcpQuota = () =>
  gcpCreateError({
    kind: 'operation',
    errors: [
      {
        code: 'QUOTA_EXCEEDED',
        message: "Quota 'CPUS' exceeded.  Limit: 8.0 in region us-central1.",
      },
    ],
  });

const gcpPermissionDenied = () =>
  gcpCreateError({
    kind: 'http',
    status: 403,
    body: {
      error: {
        code: 403,
        message: "Required 'compute.instances.create' permission for 'projects/test-project'",
        status: 'PERMISSION_DENIED',
      },
    },
  });

const gcpUnavailable = () =>
  gcpCreateError({
    kind: 'http',
    status: 503,
    body: {
      error: { code: 503, message: 'The service is currently unavailable.', status: 'UNAVAILABLE' },
    },
  });

/** Run the real Hetzner create path against one production-shaped response. */
async function hetznerCreateError(
  status: number,
  body: { code?: string; message: string }
): Promise<ProviderError> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ error: body }), { status }))
    ) as unknown as typeof globalThis.fetch;
  try {
    await new HetznerProvider('token', 'fsn1', 0, false, 0, 0, {
      capacityRetryMaxAttempts: 1,
      capacityRetryBudgetMs: 0,
    }).createVM({
      name: 'node-tier-test',
      location: 'fsn1',
      userData: '#cloud-config',
      native: { instanceType: 'cx53' },
    });
  } catch (err) {
    if (err instanceof ProviderError) return err;
    throw err;
  } finally {
    globalThis.fetch = originalFetch;
  }
  throw new Error('expected createVM to reject');
}

const hetznerSharedCoreLimit = () =>
  hetznerCreateError(403, {
    code: 'resource_limit_exceeded',
    message: 'shared core limit exceeded',
  });

const hetznerPlacement = () =>
  hetznerCreateError(412, { code: 'placement_error', message: 'error during placement' });

// ---------------------------------------------------------------------------------------------
// Pool fixture
// ---------------------------------------------------------------------------------------------

interface Offering {
  source: string;
  provider: string;
  type: string;
  location: string;
  vcpu: number;
  rank: number | null;
  /** Whose credential the source bills; defaults to the user's own. */
  attribution?: 'user' | 'platform';
}

const GCP_A: Offering = {
  source: 'source-gcp',
  provider: 'gcp',
  type: 'e2-standard-4',
  location: 'us-central1-a',
  vcpu: 4,
  rank: 1,
};
const GCP_B: Offering = { ...GCP_A, type: 'n2d-standard-4', location: 'us-central1-b' };
const HETZNER_A: Offering = {
  source: 'source-hetzner',
  provider: 'hetzner',
  type: 'cx43',
  location: 'fsn1',
  vcpu: 8,
  rank: 2,
};
const HETZNER_B: Offering = { ...HETZNER_A, type: 'cx33', vcpu: 4 };
const VULTR: Offering = {
  source: 'source-vultr',
  provider: 'vultr',
  type: 'vc2-4c-8gb',
  location: 'ewr',
  vcpu: 4,
  rank: 2,
};

function candidate(offering: Offering, index: number) {
  return {
    id: `candidate-${offering.source}-${offering.type}`,
    poolId: 'pool-user-1',
    capacitySourceId: offering.source,
    capacitySourceGeneration: 1,
    capacitySourceExternalRef: null,
    provider: offering.provider,
    location: offering.location,
    workloadRole: 'workspace',
    runtime: 'vm',
    machineClass: 'shared-vm',
    machineSize: null,
    providerInstanceType: offering.type,
    providerInstanceVcpuCount: offering.vcpu,
    providerInstanceMemoryMb: offering.vcpu * 4096,
    providerInstanceDiskGb: 80,
    providerInstancePriceDisplay: null,
    providerInstancePriceCurrency: null,
    providerInstancePriceMonthlyCents: null,
    providerInstancePriceHourlyMicros: null,
    priceComparability: 'unknown',
    catalogAvailability: 'available',
    priority: 100 + index,
    candidateOrder: 100 + index,
    credentialAttributionSource: offering.attribution ?? 'user',
    placementCredentialSource: offering.attribution ?? 'user',
    placementCredentialReference: `credentials:${offering.source}`,
    placementCredentialVersion: 42,
    capacityPoolProjectId: null,
    sourceRank: offering.rank,
  };
}

function createState(
  offerings: Offering[],
  policy: 'fail' | 'queue' | 'fallback-chain' = 'fallback-chain'
): TaskRunnerState {
  const candidates = offerings.map(candidate);
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
      vmSize: 'medium',
      vmLocation: candidates[0]?.location ?? GCP_ZONE,
      branch: 'main',
      preferredNodeId: null,
      userName: null,
      userEmail: null,
      githubId: null,
      taskTitle: 'tiers',
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
      cloudProvider: candidates[0]?.provider ?? 'gcp',
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
      resolvedReservation: { cpuMillis: 400, memoryMb: 820, diskMb: 2048 },
      capacityPoolSelection: {
        poolId: 'pool-user-1',
        scope: 'user',
        revision: 3,
        strategy: 'balanced',
        exhaustionPolicy: policy,
        capacityPoolProjectId: null,
        workloadRole: 'workspace',
        effectiveState: 'configured-ready',
        poolSnapshot: {
          capacityPoolId: 'pool-user-1',
          capacityPoolScope: 'user',
          capacityPoolRevision: 3,
          capacitySourceId: null,
          capacityPoolCandidateId: null,
          placementCredentialSource: null,
          placementCredentialReference: null,
          placementCredentialVersion: null,
          capacityPoolProjectId: null,
          workloadRole: 'workspace',
        },
        candidates,
      },
      vmSizeSource: 'task',
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

function createContext(options: { quotaEnforced?: boolean } = {}) {
  const runs: Array<{ sql: string; args: unknown[] }> = [];
  const DATABASE = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      return {
        sql,
        bind(...args: unknown[]) {
          bound = args;
          return this;
        },
        first() {
          if (
            sql.includes('SELECT id FROM tasks WHERE id = ? AND project_id = ? AND user_id = ?')
          ) {
            return Promise.resolve({ id: bound[0] });
          }
          if (sql.includes('SELECT COUNT(*) as c FROM nodes')) return Promise.resolve({ c: 0 });
          if (sql.includes('SELECT status, error_message FROM nodes')) {
            return Promise.resolve({ status: 'running', error_message: null });
          }
          return Promise.resolve(null);
        },
        all: () => Promise.resolve({ results: [] }),
        run() {
          runs.push({ sql, args: bound });
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        },
      };
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  const rc = {
    env: {
      DATABASE,
      MAX_NODES_PER_USER: '10',
      COMPUTE_QUOTA_ENFORCEMENT_ENABLED: options.quotaEnforced ? 'true' : 'false',
    },
    ctx: { storage: { put: vi.fn().mockResolvedValue(undefined), setAlarm: vi.fn() } },
    assertRecoveryAuthority: vi.fn().mockResolvedValue(undefined),
    advanceToStep: vi.fn().mockResolvedValue(undefined),
    getProvisionPollIntervalMs: () => 1000,
    getProvisionTimeoutMs: () => 600_000,
    updateD1ExecutionStep: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskRunnerContext;
  return { rc, runs };
}

/** `provider type` the step asked for, in order. */
function attempted(): string[] {
  return createNodeRecord.mock.calls.map((call) => {
    const opts = call[1] as { cloudProvider: string; providerInstanceType: string };
    return `${opts.cloudProvider} ${opts.providerInstanceType}`;
  });
}

function provisionOutcomes(outcomes: Record<string, ProviderError>): void {
  provisionNode.mockImplementation(async (nodeId: string) => {
    const error = outcomes[nodeId.split(':')[1] ?? ''];
    if (error) throw error;
  });
}

function leaseScopes(): string[] {
  return tryAcquireVmProvisioningLease.mock.calls.map(
    (call) => (call[1] as { provider: string }).provider
  );
}

function releases(): Array<[string, string]> {
  return releaseVmProvisioningLease.mock.calls.map(
    (call) => [String(call[1]), String(call[4])] as [string, string]
  );
}

function diagnostics(state: TaskRunnerState) {
  return state.stepResults.placementDiagnostics?.attempts ?? [];
}

beforeEach(() => {
  vi.clearAllMocks();
  createNodeRecord.mockImplementation(
    async (_env: unknown, opts: { providerInstanceType: string; vmLocation: string }) => ({
      id: `node:${opts.providerInstanceType}:${opts.vmLocation}`,
    })
  );
  provisionNode.mockResolvedValue(undefined);
  resolveVmAdmissionScope.mockImplementation(
    async (_env: unknown, input: { targetProvider: string }) => scopeFor(input.targetProvider)
  );
  tryAcquireVmProvisioningLease.mockImplementation(
    async (_env: unknown, identity: { scopeKey: string }) => ({
      kind: 'granted',
      scopeKey: identity.scopeKey,
      fencingToken: 7,
    })
  );
  releaseVmProvisioningLease.mockResolvedValue(true);
  resolveCredentialSource.mockResolvedValue({ credentialSource: 'user' });
  checkQuotaForUser.mockResolvedValue({ allowed: true, used: 0, limit: 100 });
  waitForVmAdmissionCapacity.mockResolvedValue({
    kind: 'waiting',
    reason: 'provider_transient_capacity',
    nextRetryAt: new Date(Date.now() + 600_000).toISOString(),
    waitDeadlineAt: new Date(Date.now() + 7_200_000).toISOString(),
  });
});

// ---------------------------------------------------------------------------------------------

describe('provider tiers: falling back to the next-ranked provider', () => {
  it('a GCP stockout on every GCP offering falls back to Hetzner, in the Hetzner domain', async () => {
    const stockout = await gcpStockout();
    expect(stockout.category).toBe('transient_capacity');
    provisionOutcomes({ 'e2-standard-4': stockout, 'n2d-standard-4': stockout });
    const { rc } = createContext();
    const state = createState([GCP_A, GCP_B, HETZNER_A, HETZNER_B]);

    await handleNodeProvisioning(state, rc);

    expect(attempted()).toEqual(['gcp e2-standard-4', 'gcp n2d-standard-4', 'hetzner cx43']);
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
    // The GCP lease is given back before the Hetzner one is taken.
    expect(leaseScopes()).toEqual(['gcp', 'hetzner']);
    expect(releases()).toEqual([[scopeFor('gcp').scopeKey, 'provider_tier_fallback']]);
    expect(state.admissionScopeKey).toBe(scopeFor('hetzner').scopeKey);
    // Success is credited to the domain that actually allocated.
    expect(recordVmProviderCapacitySuccess).toHaveBeenCalledTimes(1);
    expect(recordVmProviderCapacitySuccess.mock.calls[0]?.[1]).toMatchObject({
      provider: 'hetzner',
    });
    expect(state.config.cloudProvider).toBe('hetzner');
    expect(state.stepResults.capacityPlacementSnapshot?.capacitySourceId).toBe('source-hetzner');
    expect(diagnostics(state).map((d) => [d.provider, d.providerInstanceType, d.outcome])).toEqual([
      ['gcp', 'e2-standard-4', 'capacity-exhausted'],
      ['gcp', 'n2d-standard-4', 'capacity-exhausted'],
      ['hetzner', 'cx43', 'succeeded'],
      ['hetzner', 'cx33', 'not-attempted'],
    ]);
  });

  it('a GCP quota refusal skips the rest of GCP (same project quota) and moves to Hetzner', async () => {
    const quota = await gcpQuota();
    expect(quota.category).toBe('quota_exceeded');
    provisionOutcomes({ 'e2-standard-4': quota });
    const { rc } = createContext();
    const state = createState([GCP_A, GCP_B, HETZNER_A]);

    await handleNodeProvisioning(state, rc);

    expect(attempted()).toEqual(['gcp e2-standard-4', 'hetzner cx43']);
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });

  it('a Hetzner account limit in the first tier records its cooldown and moves to the next tier', async () => {
    const limit = await hetznerSharedCoreLimit();
    provisionOutcomes({ cx43: limit });
    const { rc, runs } = createContext();
    const state = createState([
      { ...HETZNER_A, rank: 1 },
      { ...GCP_A, rank: 2 },
    ]);

    await handleNodeProvisioning(state, rc);

    expect(attempted()).toEqual(['hetzner cx43', 'gcp e2-standard-4']);
    const cooldowns = runs.filter((run) =>
      run.sql.includes('INSERT INTO vm_provider_capacity_state')
    );
    expect(cooldowns).toHaveLength(1);
    expect(cooldowns[0]?.args[0]).toBe(scopeFor('hetzner').providerDomainKey);
    // Moving tier is not a wait: the task never parks on the Hetzner cooldown.
    expect(waitForVmAdmissionCapacity).not.toHaveBeenCalled();
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });

  it('a core quota on one source does not rule out the same server type on another source', async () => {
    const limit = await hetznerSharedCoreLimit();
    const accountA: Offering = {
      ...HETZNER_A,
      source: 'source-hetzner-a',
      type: 'cx53',
      vcpu: 16,
      rank: 1,
    };
    const accountB: Offering = { ...accountA, source: 'source-hetzner-b', rank: 2 };
    provisionNode.mockImplementationOnce(async () => {
      throw limit;
    });
    const { rc } = createContext();
    const state = createState([accountA, accountB]);

    await handleNodeProvisioning(state, rc);

    // Account B's quota is its own; its cx53 is still tried.
    expect(attempted()).toEqual(['hetzner cx53', 'hetzner cx53']);
    expect(state.stepResults.capacityPlacementSnapshot?.capacitySourceId).toBe('source-hetzner-b');
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
  });
});

describe('provider tiers: what never crosses providers (controls)', () => {
  it.each([
    ['a GCP permission denial', gcpPermissionDenied, 'auth_error'],
    ['an ambiguous GCP 503', gcpUnavailable, 'unknown'],
  ])('%s fails fast and never tries Hetzner', async (_label, makeError, category) => {
    const error = await makeError();
    expect(error.category).toBe(category);
    provisionOutcomes({ 'e2-standard-4': error });
    const { rc } = createContext();

    await expect(
      handleNodeProvisioning(createState([GCP_A, GCP_B, HETZNER_A]), rc)
    ).rejects.toMatchObject({ message: error.message, permanent: true });
    expect(attempted()).toEqual(['gcp e2-standard-4']);
    expect(leaseScopes()).toEqual(['gcp']);
  });

  it('without a provider order the chain stays on the first source, as before', async () => {
    const stockout = await gcpStockout();
    provisionOutcomes({ 'e2-standard-4': stockout, 'n2d-standard-4': stockout });
    const { rc } = createContext();
    const unordered = [GCP_A, GCP_B, HETZNER_A].map((offering) => ({ ...offering, rank: null }));

    await expect(handleNodeProvisioning(createState(unordered), rc)).rejects.toMatchObject({
      message: expect.stringContaining('(tried e2-standard-4, n2d-standard-4)'),
      permanent: true,
    });
    expect(attempted()).toEqual(['gcp e2-standard-4', 'gcp n2d-standard-4']);
    expect(leaseScopes()).toEqual(['gcp']);
  });

  it('same-rank sources do not fall back to each other', async () => {
    const stockout = await gcpStockout();
    const placement = await hetznerPlacement();
    expect(placement.category).toBe('transient_capacity');
    provisionOutcomes({ 'e2-standard-4': stockout, cx43: placement });
    const { rc } = createContext();

    await expect(
      handleNodeProvisioning(createState([GCP_A, HETZNER_A, VULTR]), rc)
    ).rejects.toMatchObject({
      message: expect.stringContaining('(tried gcp e2-standard-4, hetzner cx43)'),
      permanent: true,
    });
    // Vultr shares Hetzner's rank, so it is never a fallback for it.
    expect(attempted()).toEqual(['gcp e2-standard-4', 'hetzner cx43']);
  });
});

describe('provider tiers: exhaustion policies', () => {
  it('`fail` tries the first offering of each tier', async () => {
    const stockout = await gcpStockout();
    provisionOutcomes({ 'e2-standard-4': stockout });
    const { rc } = createContext();

    await handleNodeProvisioning(createState([GCP_A, GCP_B, HETZNER_A, HETZNER_B], 'fail'), rc);

    expect(attempted()).toEqual(['gcp e2-standard-4', 'hetzner cx43']);
  });

  it('`queue` waits on the most preferred provider only after every tier is exhausted', async () => {
    const stockout = await gcpStockout();
    const placement = await hetznerPlacement();
    provisionOutcomes({ 'e2-standard-4': stockout, cx43: placement });
    const { rc } = createContext();

    await handleNodeProvisioning(createState([GCP_A, HETZNER_A], 'queue'), rc);

    expect(attempted()).toEqual(['gcp e2-standard-4', 'hetzner cx43']);
    expect(waitForVmAdmissionCapacity).toHaveBeenCalledTimes(1);
    expect(waitForVmAdmissionCapacity.mock.calls[0]?.[1]).toMatchObject({ provider: 'gcp' });
    expect(waitForVmAdmissionCapacity.mock.calls[0]?.[2]).toBe('provider_transient_capacity');
    expect(rc.ctx.storage.setAlarm).toHaveBeenCalled();
  });
});

describe('provider tiers: a large catalog cannot hold the chain on one provider', () => {
  it('`fallback-chain` tries the default 8 best GCP offerings, then moves to Hetzner', async () => {
    const stockout = await gcpStockout();
    // Twelve GCP offerings, as a live catalog spanning many zones gives one machine type.
    const gcpOfferings = Array.from({ length: 12 }, (_, n) => ({
      ...GCP_A,
      type: `e2-standard-4-z${n}`,
    }));
    provisionOutcomes(Object.fromEntries(gcpOfferings.map((o) => [o.type, stockout])));
    const { rc } = createContext();
    const state = createState([...gcpOfferings, HETZNER_A]);

    // The cap comes from the real admin-setting resolver: nothing overrides it here.
    await handleNodeProvisioning(state, rc);

    expect(attempted()).toEqual([
      ...gcpOfferings.slice(0, 8).map((o) => `gcp ${o.type}`),
      'hetzner cx43',
    ]);
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
    // Placement diagnostics list what the plan will try: eight GCP offerings and Hetzner.
    expect(diagnostics(state)).toHaveLength(9);
  });
});

describe('provider tiers: `fail` with every tier exhausted', () => {
  it('fails with every provider named and never queues', async () => {
    const stockout = await gcpStockout();
    const placement = await hetznerPlacement();
    provisionOutcomes({ 'e2-standard-4': stockout, cx43: placement });
    const { rc } = createContext();

    await expect(
      handleNodeProvisioning(createState([GCP_A, GCP_B, HETZNER_A, HETZNER_B], 'fail'), rc)
    ).rejects.toMatchObject({
      message: expect.stringContaining('(tried gcp e2-standard-4, hetzner cx43)'),
      permanent: true,
    });
    expect(attempted()).toEqual(['gcp e2-standard-4', 'hetzner cx43']);
    expect(waitForVmAdmissionCapacity).not.toHaveBeenCalled();
    expect(rc.ctx.storage.setAlarm).not.toHaveBeenCalled();
  });
});

const cooldownLease = (provider: string) => {
  const retryAt = new Date(Date.now() + 600_000).toISOString();
  tryAcquireVmProvisioningLease.mockImplementation(
    async (_env: unknown, identity: { scopeKey: string; provider: string }) =>
      identity.provider === provider
        ? {
            kind: 'waiting',
            reason: 'provider_account_capacity',
            nextRetryAt: retryAt,
            waitDeadlineAt: retryAt,
          }
        : { kind: 'granted', scopeKey: identity.scopeKey, fencingToken: 7 }
  );
  return retryAt;
};

describe('provider tiers: the most preferred tier is skippable too', () => {
  it('a cooling-down first provider is skipped, not waited on, when a later tier exists', async () => {
    cooldownLease('hetzner');
    const { rc } = createContext();
    const state = createState([
      { ...HETZNER_A, rank: 1 },
      { ...GCP_A, rank: 2 },
    ]);

    await handleNodeProvisioning(state, rc);

    expect(attempted()).toEqual(['gcp e2-standard-4']);
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
    expect(rc.ctx.storage.setAlarm).not.toHaveBeenCalled();
    expect(leaseScopes()).toEqual(['hetzner', 'gcp']);
    expect(diagnostics(state)[0]).toMatchObject({
      provider: 'hetzner',
      outcome: 'not-attempted',
      reason: expect.stringContaining('cooling down'),
    });
  });

  it('control: with no later tier, a cooling-down provider still parks the task', async () => {
    const retryAt = cooldownLease('hetzner');
    const { rc } = createContext();

    await handleNodeProvisioning(createState([{ ...HETZNER_A, rank: 1 }]), rc);

    expect(attempted()).toEqual([]);
    expect(rc.ctx.storage.setAlarm).toHaveBeenCalledWith(Date.parse(retryAt));
  });

  it('spent platform quota on the first tier falls back to the user’s own credential', async () => {
    resolveCredentialSource.mockImplementation(
      async (_db: unknown, _userId: string, provider: string) => ({
        credentialSource: provider === 'gcp' ? 'platform' : 'user',
      })
    );
    checkQuotaForUser.mockResolvedValue({ allowed: false, used: 100, limit: 100 });
    const { rc } = createContext({ quotaEnforced: true });
    const state = createState([{ ...GCP_A, attribution: 'platform' }, HETZNER_A]);

    await handleNodeProvisioning(state, rc);

    expect(attempted()).toEqual(['hetzner cx43']);
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
    // Only the platform tier is charged to the platform quota.
    expect(checkQuotaForUser).toHaveBeenCalledTimes(1);
    expect(diagnostics(state)[0]?.reason).toContain('Monthly compute quota exceeded');
  });

  it('control: with no later tier, spent platform quota still fails the task', async () => {
    resolveCredentialSource.mockResolvedValue({ credentialSource: 'platform' });
    checkQuotaForUser.mockResolvedValue({ allowed: false, used: 100, limit: 100 });
    const { rc } = createContext({ quotaEnforced: true });

    await expect(
      handleNodeProvisioning(createState([{ ...GCP_A, attribution: 'platform' }]), rc)
    ).rejects.toMatchObject({
      message: expect.stringContaining('Monthly compute quota exceeded'),
      permanent: true,
    });
    expect(attempted()).toEqual([]);
  });

  it('a first-tier credential that cannot be resolved is skipped', async () => {
    resolveVmAdmissionScope.mockImplementation(
      async (_env: unknown, input: { targetProvider: string }) =>
        input.targetProvider === 'gcp' ? null : scopeFor(input.targetProvider)
    );
    const { rc } = createContext();
    const state = createState([GCP_A, HETZNER_A]);

    await handleNodeProvisioning(state, rc);

    expect(attempted()).toEqual(['hetzner cx43']);
    expect(diagnostics(state)[0]?.reason).toContain('no gcp credential could be resolved');
  });
});

describe('provider tiers: compute quota on a later tier', () => {
  it('a later tier on platform credentials is skipped when the platform quota is spent', async () => {
    const stockout = await gcpStockout();
    provisionOutcomes({ 'e2-standard-4': stockout });
    resolveCredentialSource.mockImplementation(
      async (_db: unknown, _userId: string, provider: string) => ({
        credentialSource: provider === 'hetzner' ? 'platform' : 'user',
      })
    );
    checkQuotaForUser.mockResolvedValue({ allowed: false, used: 100, limit: 100 });
    const { rc } = createContext({ quotaEnforced: true });
    const state = createState([GCP_A, { ...HETZNER_A, attribution: 'platform' }]);

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({ permanent: true });

    // Falling back cannot be used to provision past the platform quota.
    expect(attempted()).toEqual(['gcp e2-standard-4']);
    expect(checkQuotaForUser).toHaveBeenCalledTimes(1);
    expect(diagnostics(state)[1]?.reason).toContain('Monthly compute quota exceeded');
  });

  it('control: the same later tier is used while the platform quota allows it', async () => {
    const stockout = await gcpStockout();
    provisionOutcomes({ 'e2-standard-4': stockout });
    resolveCredentialSource.mockImplementation(
      async (_db: unknown, _userId: string, provider: string) => ({
        credentialSource: provider === 'hetzner' ? 'platform' : 'user',
      })
    );
    const { rc } = createContext({ quotaEnforced: true });
    const state = createState([GCP_A, { ...HETZNER_A, attribution: 'platform' }]);

    await handleNodeProvisioning(state, rc);

    expect(attempted()).toEqual(['gcp e2-standard-4', 'hetzner cx43']);
    expect(checkQuotaForUser).toHaveBeenCalledTimes(1);
  });
});

describe('provider tiers: entering a tier', () => {
  it('skips a tier whose provider is cooling down, without parking on it', async () => {
    const stockout = await gcpStockout();
    provisionOutcomes({ 'e2-standard-4': stockout });
    const retryAt = new Date(Date.now() + 600_000).toISOString();
    tryAcquireVmProvisioningLease.mockImplementation(
      async (_env: unknown, identity: { scopeKey: string; provider: string }) =>
        identity.provider === 'hetzner'
          ? {
              kind: 'waiting',
              reason: 'provider_account_capacity',
              nextRetryAt: retryAt,
              waitDeadlineAt: retryAt,
            }
          : { kind: 'granted', scopeKey: identity.scopeKey, fencingToken: 7 }
    );
    const { rc } = createContext();
    const state = createState([GCP_A, HETZNER_A]);

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({
      message: expect.stringContaining('Last provider error: GCP operation failed'),
      permanent: true,
    });
    expect(attempted()).toEqual(['gcp e2-standard-4']);
    expect(rc.ctx.storage.setAlarm).not.toHaveBeenCalled();
    expect(diagnostics(state)[1]).toMatchObject({
      provider: 'hetzner',
      outcome: 'not-attempted',
      reason: expect.stringContaining('cooling down'),
    });
  });

  it('skips a tier whose credential cannot be resolved', async () => {
    const stockout = await gcpStockout();
    provisionOutcomes({ 'e2-standard-4': stockout });
    resolveVmAdmissionScope.mockImplementation(
      async (_env: unknown, input: { targetProvider: string }) =>
        input.targetProvider === 'hetzner' ? null : scopeFor(input.targetProvider)
    );
    const { rc } = createContext();
    const state = createState([GCP_A, HETZNER_A]);

    await expect(handleNodeProvisioning(state, rc)).rejects.toMatchObject({ permanent: true });
    expect(attempted()).toEqual(['gcp e2-standard-4']);
    expect(diagnostics(state)[1]?.reason).toContain('no hetzner credential could be resolved');
  });

  it('parks when another task holds the next tier’s lease, as the first tier would', async () => {
    const stockout = await gcpStockout();
    provisionOutcomes({ 'e2-standard-4': stockout });
    const retryAt = new Date(Date.now() + 30_000).toISOString();
    tryAcquireVmProvisioningLease.mockImplementation(
      async (_env: unknown, identity: { scopeKey: string; provider: string }) =>
        identity.provider === 'hetzner'
          ? {
              kind: 'waiting',
              reason: 'compatible_node_provisioning',
              nextRetryAt: retryAt,
              waitDeadlineAt: new Date(Date.now() + 7_200_000).toISOString(),
            }
          : { kind: 'granted', scopeKey: identity.scopeKey, fencingToken: 7 }
    );
    const { rc } = createContext();

    await handleNodeProvisioning(createState([GCP_A, HETZNER_A]), rc);

    expect(attempted()).toEqual(['gcp e2-standard-4']);
    expect(rc.ctx.storage.setAlarm).toHaveBeenCalledWith(Date.parse(retryAt));
  });

  it('on restart, gives back a lease a later tier held before acquiring the first tier’s', async () => {
    const { rc } = createContext();
    const state = createState([GCP_A, HETZNER_A]);
    state.admissionScopeKey = scopeFor('hetzner').scopeKey;
    state.admissionLeaseToken = 9;

    await handleNodeProvisioning(state, rc);

    expect(releaseVmProvisioningLease.mock.calls[0]?.slice(1)).toEqual([
      scopeFor('hetzner').scopeKey,
      'task-1',
      9,
      'provider_tier_restart',
    ]);
    expect(leaseScopes()).toEqual(['gcp']);
    expect(attempted()).toEqual(['gcp e2-standard-4']);
  });
});
