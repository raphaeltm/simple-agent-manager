/**
 * Hetzner account quotas at the action layer — the 2026-09-25 production incident.
 *
 * Three human wakes of one sleeping conversation each tried cx53 (16 cores), got
 * `hetzner API error (403): shared core limit exceeded`, and failed permanently. cx43, cx33 and
 * cx23 sat in the chain `not-attempted` while about 28 shared cores were in use, so a smaller
 * server would have fit.
 *
 * Everything that decides the recovery action is real here (`.claude/rules/62`, `.claude/rules/72`):
 * - the step (`handleNodeProvisioning`),
 * - the failure handler and core-quota descent,
 * - the account-capacity classifier and its D1 cooldown write,
 * - and every provider error, built by the real `HetznerProvider.createVM` from a
 *   production-shaped response minted fresh per request.
 * Only provisioning I/O, the admission lease and the wait are stubbed. Every existing
 * account-capacity test stubbed `recordVmProviderCapacityFailure` itself, which hand-feeds the
 * decision this file exists to exercise.
 */
import { HetznerProvider, ProviderError } from '@simple-agent-manager/providers';
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

// Partial mock: `recordVmProviderCapacityFailure` (and the classifier it calls) stays REAL, so the
// account-capacity decision is made from the real error, not hand-fed.
vi.mock('../../../src/services/vm-admission-control', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/vm-admission-control')>();
  return {
    ...actual,
    resolveVmAdmissionScope: (...a: unknown[]) => resolveVmAdmissionScope(...a),
    tryAcquireVmProvisioningLease: (...a: unknown[]) => tryAcquireVmProvisioningLease(...a),
    waitForVmAdmissionCapacity: (...a: unknown[]) => waitForVmAdmissionCapacity(...a),
    releaseVmProvisioningLease: (...a: unknown[]) => releaseVmProvisioningLease(...a),
    recordVmProviderCapacitySuccess: vi.fn(),
    assertVmProvisioningLease: vi.fn(),
    renewVmProvisioningLease: vi.fn(),
    markVmProvisioningLeaseInflightNode: vi.fn().mockResolvedValue(true),
  };
});

const SCOPE = {
  provider: 'hetzner' as const,
  credentialSource: 'user' as const,
  credentialDomainKey: 'user:user-1:hetzner',
  providerDomainKey: 'hetzner:user:user-1:hetzner',
  scopeKey: 'user:user-1:workspace-vm:hetzner:user:user-1:hetzner',
};

/**
 * Run the real Hetzner create path against one production-shaped response and return what it
 * throws. A fresh `Response` is minted per request (`.claude/rules/72`); a reused one would degrade
 * any second read to "HTTP 403" with no code.
 */
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
      capacityRetryMaxAttempts: 10,
      capacityRetryBudgetMs: 300_000,
    }).createVM({
      name: 'node-quota-test',
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

const sharedCoreLimit = () =>
  hetznerCreateError(403, {
    code: 'resource_limit_exceeded',
    message: 'shared core limit exceeded',
  });

interface Offering {
  type: string;
  vcpu: number;
  location?: string;
  priority?: number;
}

/** The incident user's pool: pack strategy, fallback-chain, Hetzner cx offerings. */
const INCIDENT_CHAIN: Offering[] = [
  { type: 'cx53', vcpu: 16 },
  { type: 'cx43', vcpu: 8 },
  { type: 'cx33', vcpu: 4 },
  { type: 'cx23', vcpu: 2 },
];

function candidate(offering: Offering, index: number) {
  const location = offering.location ?? 'fsn1';
  return {
    id: `candidate-${location}-${offering.type}`,
    poolId: 'pool-user-1',
    capacitySourceId: 'source-user-1',
    capacitySourceGeneration: 1,
    capacitySourceExternalRef: null,
    provider: 'hetzner',
    location,
    workloadRole: 'workspace',
    runtime: 'vm',
    machineClass: 'shared-vm',
    machineSize: null,
    providerInstanceType: offering.type,
    providerInstanceVcpuCount: offering.vcpu,
    providerInstanceMemoryMb: offering.vcpu * 2048,
    providerInstanceDiskGb: offering.vcpu * 20,
    providerInstancePriceDisplay: null,
    providerInstancePriceCurrency: null,
    providerInstancePriceMonthlyCents: null,
    providerInstancePriceHourlyMicros: null,
    priceComparability: 'unknown',
    catalogAvailability: 'available',
    priority: offering.priority ?? 100 + index,
    candidateOrder: offering.priority ?? 100 + index,
    credentialAttributionSource: 'user',
    placementCredentialSource: 'user',
    placementCredentialReference: 'credentials:credential-user-1',
    placementCredentialVersion: 42,
    capacityPoolProjectId: null,
  };
}

function createState(offerings: Offering[] = INCIDENT_CHAIN): TaskRunnerState {
  const candidates = offerings.map(candidate);
  const primary = candidates[0];
  const poolSnapshot = {
    capacityPoolId: 'pool-user-1',
    capacityPoolScope: 'user' as const,
    capacityPoolRevision: 8,
    capacitySourceId: null,
    capacityPoolCandidateId: null,
    placementCredentialSource: null,
    placementCredentialReference: null,
    placementCredentialVersion: null,
    capacityPoolProjectId: null,
    workloadRole: 'workspace' as const,
  };
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
      vmLocation: primary?.location ?? 'fsn1',
      branch: 'main',
      preferredNodeId: null,
      userName: null,
      userEmail: null,
      githubId: null,
      taskTitle: 'wake',
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
      cloudProvider: 'hetzner',
      credentialAttributionUserId: 'user-1',
      credentialAttributionProjectId: null,
      credentialAttributionSource: 'user',
      taskMode: 'conversation',
      model: null,
      effort: null,
      permissionMode: null,
      opencodeProvider: null,
      opencodeBaseUrl: null,
      systemPromptAppend: null,
      agentProfileHint: null,
      attachments: null,
      projectScaling: null,
      // 400m CPU / 820 MB — the incident's recorded request.
      resolvedReservation: { cpuMillis: 400, memoryMb: 820, diskMb: 2048 },
      capacityPoolSelection: {
        poolId: 'pool-user-1',
        scope: 'user',
        revision: 8,
        strategy: 'pack',
        exhaustionPolicy: 'fallback-chain',
        capacityPoolProjectId: null,
        workloadRole: 'workspace',
        effectiveState: 'configured-ready',
        poolSnapshot,
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

/**
 * `failBatch` models the isolate being lost mid-discard: the D1 batch rejects, and only what the
 * DO had already written to storage survives into the restart (`persisted()`).
 */
function createContext(options: { failBatch?: boolean } = {}) {
  const runs: Array<{ sql: string; args: unknown[] }> = [];
  const batches: string[][] = [];
  let persisted: TaskRunnerState | null = null;
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
    async batch(statements: Array<{ sql: string; run: () => Promise<unknown> }>) {
      if (options.failBatch) throw new Error('isolate lost');
      batches.push(statements.map((statement) => statement.sql));
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  const rc = {
    env: { DATABASE, MAX_NODES_PER_USER: '10', COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'false' },
    ctx: {
      storage: {
        put: vi.fn(async (_key: string, value: TaskRunnerState) => {
          persisted = structuredClone(value);
        }),
        setAlarm: vi.fn(),
      },
    },
    assertRecoveryAuthority: vi.fn().mockResolvedValue(undefined),
    advanceToStep: vi.fn().mockResolvedValue(undefined),
    getProvisionPollIntervalMs: () => 1000,
    getProvisionTimeoutMs: () => 600_000,
    updateD1ExecutionStep: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskRunnerContext;
  return { rc, runs, batches, persisted: () => persisted };
}

/** Which server types the step actually asked the provider for, in order. */
function attemptedTypes(): string[] {
  return createNodeRecord.mock.calls.map(
    (call) => (call[1] as { providerInstanceType: string }).providerInstanceType
  );
}

function cooldownWrites(runs: Array<{ sql: string; args: unknown[] }>) {
  return runs.filter((run) => run.sql.includes('INSERT INTO vm_provider_capacity_state'));
}

function attempts(state: TaskRunnerState) {
  return state.stepResults.placementDiagnostics?.attempts ?? [];
}

/** Provision outcome per server type; anything unlisted succeeds. */
function provisionOutcomes(outcomes: Record<string, ProviderError>): void {
  provisionNode.mockImplementation(async (nodeId: string) => {
    const type = nodeId.split(':')[1] ?? '';
    const error = outcomes[type];
    if (error) throw error;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  createNodeRecord.mockImplementation(
    async (_env: unknown, opts: { providerInstanceType: string; vmLocation: string }) => ({
      id: `node:${opts.providerInstanceType}:${opts.vmLocation}`,
    })
  );
  resolveVmAdmissionScope.mockResolvedValue(SCOPE);
  tryAcquireVmProvisioningLease.mockResolvedValue({
    kind: 'granted',
    scopeKey: SCOPE.scopeKey,
    fencingToken: 7,
  });
  releaseVmProvisioningLease.mockResolvedValue(undefined);
  waitForVmAdmissionCapacity.mockResolvedValue({
    kind: 'waiting',
    reason: 'provider_account_capacity',
    nextRetryAt: new Date(Date.now() + 600_000).toISOString(),
    waitDeadlineAt: new Date(Date.now() + 7_200_000).toISOString(),
  });
});

describe('Hetzner shared-core quota descends the fallback chain', () => {
  it('fixture fidelity: the error is the production 403 as the real provider builds it', async () => {
    const error = await sharedCoreLimit();
    expect(error.statusCode).toBe(403);
    expect(error.providerCode).toBe('resource_limit_exceeded');
    expect(error.message).toBe('hetzner API error (403): shared core limit exceeded');
    expect(error.category).toBe('quota_exceeded');
  });

  it('descends from cx53 to the first offering that fits (the 2026-09-25 incident)', async () => {
    const quota = await sharedCoreLimit();
    provisionOutcomes({ cx53: quota, cx43: quota });
    const { rc, runs } = createContext();
    const state = createState();

    await handleNodeProvisioning(state, rc);

    // Before the fix: exactly one attempt (cx53), then a permanent failure.
    expect(attemptedTypes()).toEqual(['cx53', 'cx43', 'cx33']);
    expect(rc.advanceToStep).toHaveBeenCalledWith(state, 'node_agent_ready');
    // A smaller offering fitting means the ACCOUNT was never out of capacity: no domain
    // cooldown, no wait, and the lease is not released between attempts.
    expect(cooldownWrites(runs)).toHaveLength(0);
    expect(waitForVmAdmissionCapacity).not.toHaveBeenCalled();
    expect(releaseVmProvisioningLease).not.toHaveBeenCalled();

    const [cx53, cx43, cx33, cx23] = attempts(state);
    expect(cx53).toMatchObject({ providerInstanceType: 'cx53', outcome: 'capacity-exhausted' });
    expect(cx53?.reason).toContain(
      'shared vCPU core limit reached for this 16-vCPU offering; trying offerings that need fewer cores'
    );
    expect(cx53?.reason).toContain('hetzner API error (403): shared core limit exceeded');
    expect(cx43).toMatchObject({ providerInstanceType: 'cx43', outcome: 'capacity-exhausted' });
    expect(cx33).toMatchObject({ providerInstanceType: 'cx33', outcome: 'succeeded' });
    expect(cx23).toMatchObject({ providerInstanceType: 'cx23', outcome: 'not-attempted' });
  });

  it('discards each quota-rejected node row that never got a server', async () => {
    const quota = await sharedCoreLimit();
    provisionOutcomes({ cx53: quota });
    const { rc, runs, batches } = createContext();

    await handleNodeProvisioning(createState(), rc);

    const deletes = runs.filter((run) => run.sql.startsWith('DELETE FROM nodes'));
    // Scoped to the rejected node and this task's user.
    expect(deletes.map((run) => run.args)).toEqual([['node:cx53:fsn1', 'user-1']]);
    // Guarded: a row that did get a provider identity is never deleted here.
    expect(deletes[0]?.sql).toContain('provider_instance_id IS NULL');
    const unlinks = runs.filter((run) => run.sql.includes('auto_provisioned_node_id = NULL'));
    expect(unlinks.map((run) => run.args.slice(1))).toEqual([['task-1', 'node:cx53:fsn1']]);
    // The row delete and the task unlink land together.
    expect(batches).toHaveLength(1);
    expect(batches[0]?.[0]).toContain('DELETE FROM nodes');
    expect(batches[0]?.[1]).toContain('auto_provisioned_node_id = NULL');
  });

  it('an isolate lost mid-discard resumes its proven rejection before descending', async () => {
    const quota = await sharedCoreLimit();
    provisionOutcomes({ cx53: quota });
    const crashed = createContext({ failBatch: true });

    await expect(handleNodeProvisioning(createState(), crashed.rc)).rejects.toThrow('isolate lost');

    // Keep the rejection proof until D1 deletion/unlink and DO claim cleanup finish.
    // A restarted isolate settles this marker before ordinary missing-node validation.
    const persisted = crashed.persisted();
    expect(persisted?.stepResults).toMatchObject({
      nodeId: 'node:cx53:fsn1',
      autoProvisioned: true,
      providerRejectedNodeId: 'node:cx53:fsn1',
    });

    createNodeRecord.mockClear();
    const restarted = createContext();
    if (!persisted) throw new Error('expected persisted state');
    await handleNodeProvisioning(persisted, restarted.rc);

    // The chain resumes from the top (the rejection list is in-memory) and still lands.
    expect(attemptedTypes()).toEqual(['cx53', 'cx43']);
    expect(restarted.rc.advanceToStep).toHaveBeenCalledWith(persisted, 'node_agent_ready');
  });

  it('skips same-size offerings in other regions — the quota is account-wide', async () => {
    const quota = await sharedCoreLimit();
    provisionOutcomes({ cx53: quota });
    const { rc } = createContext();
    // Pack ranks by capacity first, so every cx53 precedes every cx43.
    const state = createState([
      { type: 'cx53', vcpu: 16, location: 'fsn1', priority: 1 },
      { type: 'cx53', vcpu: 16, location: 'hel1', priority: 2 },
      { type: 'cx43', vcpu: 8, location: 'fsn1', priority: 3 },
      { type: 'cx43', vcpu: 8, location: 'hel1', priority: 4 },
    ]);

    await handleNodeProvisioning(state, rc);

    expect(attemptedTypes()).toEqual(['cx53', 'cx43']);
    const [, hel1Cx53] = attempts(state);
    expect(hel1Cx53).toMatchObject({ location: 'hel1', outcome: 'not-attempted' });
    expect(hel1Cx53?.reason).toBe(
      "Skipped: needs 16 vCPU, and the account's shared vCPU core limit already rejected a 16-vCPU offering"
    );
  });

  it('a dedicated-core quota does not rule out shared-core offerings of the same size', async () => {
    const dedicatedQuota = await hetznerCreateError(403, {
      code: 'resource_limit_exceeded',
      message: 'dedicated core limit exceeded',
    });
    provisionOutcomes({ ccx33: dedicatedQuota });
    const { rc } = createContext();
    const state = createState([
      { type: 'ccx33', vcpu: 8, priority: 1 },
      { type: 'cx43', vcpu: 8, priority: 2 },
      { type: 'cx33', vcpu: 4, priority: 3 },
    ]);

    await handleNodeProvisioning(state, rc);

    // cx43 needs as many cores as ccx33, but draws on the shared pool the quota never named.
    expect(attemptedTypes()).toEqual(['ccx33', 'cx43']);
  });
});

describe('when no permitted offering fits under the quota', () => {
  it('parks the task on provider_account_capacity instead of failing it', async () => {
    const quota = await sharedCoreLimit();
    provisionOutcomes({ cx53: quota, cx43: quota, cx33: quota, cx23: quota });
    const { rc, runs } = createContext();

    await expect(handleNodeProvisioning(createState(), rc)).resolves.toBeUndefined();

    expect(attemptedTypes()).toEqual(['cx53', 'cx43', 'cx33', 'cx23']);
    // The cooldown is recorded once, by the real classifier, only after the smallest offering.
    const cooldown = cooldownWrites(runs);
    expect(cooldown).toHaveLength(1);
    expect(cooldown[0]?.args).toEqual(
      expect.arrayContaining([
        SCOPE.providerDomainKey,
        'quota_exceeded',
        'resource_limit_exceeded',
        403,
        'hetzner API error (403): shared core limit exceeded',
      ])
    );
    expect(waitForVmAdmissionCapacity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scopeKey: SCOPE.scopeKey }),
      'provider_account_capacity',
      expect.any(String),
      expect.objectContaining({
        providerCode: 'resource_limit_exceeded',
        providerMessage: 'hetzner API error (403): shared core limit exceeded',
      })
    );
    expect(rc.updateD1ExecutionStep).toHaveBeenCalledWith('task-1', 'waiting_for_node_capacity');
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });

  it('fails with a user-legible message once the wait deadline passes', async () => {
    const quota = await sharedCoreLimit();
    provisionOutcomes({ cx53: quota, cx43: quota, cx33: quota, cx23: quota });
    waitForVmAdmissionCapacity.mockResolvedValue({
      kind: 'expired',
      reason: 'wait_deadline_expired',
      waitDeadlineAt: new Date().toISOString(),
    });
    const { rc } = createContext();

    await expect(handleNodeProvisioning(createState(), rc)).rejects.toMatchObject({
      permanent: true,
      message:
        'Timed out waiting for cloud capacity. Your Hetzner account has reached its shared vCPU ' +
        'core limit, and no smaller server type this compute pool allows fits under it. Delete ' +
        'unused nodes to free capacity, or raise the limit in the Hetzner Console (Limits). ' +
        'Provider error: hetzner API error (403): shared core limit exceeded',
    });
  });

  it('without an admission queue, fails fast with the legible message', async () => {
    resolveVmAdmissionScope.mockResolvedValue(null);
    const quota = await sharedCoreLimit();
    provisionOutcomes({ cx53: quota, cx43: quota, cx33: quota, cx23: quota });
    const { rc, runs } = createContext();

    await expect(handleNodeProvisioning(createState(), rc)).rejects.toMatchObject({
      permanent: true,
      message: expect.stringMatching(
        /^Your Hetzner account has reached its shared vCPU core limit, .* Provider error: hetzner API error \(403\): shared core limit exceeded$/
      ),
    });
    // It still descended through every offering before giving up.
    expect(attemptedTypes()).toEqual(['cx53', 'cx43', 'cx33', 'cx23']);
    expect(cooldownWrites(runs)).toHaveLength(0);
  });
});

describe('a core quota with nothing smaller to try', () => {
  it('an offering with no known vCPU count waits instead of guessing what fits', async () => {
    const quota = await sharedCoreLimit();
    provisionOutcomes({ cx53: quota });
    const { rc, runs } = createContext();
    const state = createState();
    // An offering whose catalog row never recorded a vCPU count: which smaller offerings the
    // quota rules out is unknowable, so no descent is attempted.
    for (const pooled of state.config.capacityPoolSelection?.candidates ?? []) {
      (pooled as { providerInstanceVcpuCount: number | null }).providerInstanceVcpuCount = null;
    }

    await expect(handleNodeProvisioning(state, rc)).resolves.toBeUndefined();

    expect(attemptedTypes()).toEqual(['cx53']);
    expect(cooldownWrites(runs)).toHaveLength(1);
    expect(waitForVmAdmissionCapacity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scopeKey: SCOPE.scopeKey }),
      'provider_account_capacity',
      expect.any(String),
      expect.objectContaining({
        providerMessage: 'hetzner API error (403): shared core limit exceeded',
      })
    );
    expect(attempts(state)[0]?.reason).toBe(
      'Provider account shared vCPU core limit reached. Provider error: hetzner API error (403): shared core limit exceeded'
    );
  });

  it("under the pool's `fail` policy there is no chain, so the task waits on the account", async () => {
    const quota = await sharedCoreLimit();
    provisionOutcomes({ cx53: quota });
    const { rc, runs } = createContext();
    const state = createState();
    const selection = state.config.capacityPoolSelection;
    if (!selection) throw new Error('expected a capacity pool selection');
    selection.exhaustionPolicy = 'fail';

    await expect(handleNodeProvisioning(state, rc)).resolves.toBeUndefined();

    // `fail` means one offering; a core quota on it is an account wait, never a terminal error.
    expect(attemptedTypes()).toEqual(['cx53']);
    expect(cooldownWrites(runs)).toHaveLength(1);
    expect(waitForVmAdmissionCapacity).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'provider_account_capacity',
      expect.any(String),
      expect.objectContaining({ providerCode: 'resource_limit_exceeded' })
    );
    expect(rc.advanceToStep).not.toHaveBeenCalled();
  });
});

describe('controls', () => {
  it('a server-count quota never descends: no smaller server escapes it', async () => {
    const serverLimit = await hetznerCreateError(403, {
      code: 'resource_limit_exceeded',
      message: 'server limit reached',
    });
    provisionOutcomes({ cx53: serverLimit });
    const { rc, runs } = createContext();

    await expect(handleNodeProvisioning(createState(), rc)).resolves.toBeUndefined();

    expect(attemptedTypes()).toEqual(['cx53']);
    expect(cooldownWrites(runs)).toHaveLength(1);
    expect(waitForVmAdmissionCapacity).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'provider_account_capacity',
      expect.any(String),
      expect.objectContaining({ providerMessage: 'hetzner API error (403): server limit reached' })
    );
  });

  it('a genuine permission 403 still fails fast — no descent, no wait, no cooldown', async () => {
    const forbidden = await hetznerCreateError(403, {
      code: 'forbidden',
      message: 'insufficient permissions for this request',
    });
    expect(forbidden.category).toBe('auth_error');
    provisionOutcomes({ cx53: forbidden });
    const { rc, runs } = createContext();

    await expect(handleNodeProvisioning(createState(), rc)).rejects.toMatchObject({
      permanent: true,
      message: 'hetzner API error (403): insufficient permissions for this request',
    });
    expect(attemptedTypes()).toEqual(['cx53']);
    expect(cooldownWrites(runs)).toHaveLength(0);
    expect(waitForVmAdmissionCapacity).not.toHaveBeenCalled();
  });
});
