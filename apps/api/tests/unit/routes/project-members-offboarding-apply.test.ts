import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { projectMembersRoutes } from '../../../src/routes/projects/members';

const mocks = vi.hoisted(() => ({
  currentUserId: 'owner-user',
  requireProjectCapability: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  getUserId: () => mocks.currentUserId,
}));
vi.mock('../../../src/middleware/project-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/middleware/project-auth')>();
  return {
    ...actual,
    requireProjectCapability: mocks.requireProjectCapability,
  };
});

type QueryResult = unknown[];

function makeProject(overrides: Partial<schema.Project> = {}): schema.Project {
  return {
    id: 'proj-1',
    userId: 'owner-user',
    name: 'Shared Project',
    normalizedName: 'shared-project',
    description: null,
    installationId: 'inst-1',
    repository: 'acme/repo',
    defaultBranch: 'main',
    repoProvider: 'github',
    artifactsRepoId: null,
    githubRepoId: 42,
    githubRepoNodeId: 'R_repo',
    defaultVmSize: null,
    defaultAgentType: 'claude-code',
    defaultWorkspaceProfile: null,
    defaultDevcontainerConfigName: null,
    defaultProvider: 'hetzner',
    defaultLocation: null,
    agentDefaults: null,
    workspaceIdleTimeoutMs: null,
    nodeIdleTimeoutMs: null,
    taskExecutionTimeoutMs: null,
    maxConcurrentTasks: null,
    maxDispatchDepth: null,
    maxSubTasksPerTask: null,
    warmNodeTimeoutMs: null,
    maxWorkspacesPerNode: null,
    nodeCpuThresholdPercent: null,
    nodeMemoryThresholdPercent: null,
    status: 'active',
    lastActivityAt: null,
    activeSessionCount: 0,
    createdBy: 'owner-user',
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeMember(
  userId: string,
  role: schema.ProjectMember['role'] = 'admin'
): schema.ProjectMember {
  return {
    projectId: 'proj-1',
    userId,
    role,
    status: 'active',
    invitedBy: role === 'owner' ? null : 'owner-user',
    removedAt: null,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
  };
}

function makePlan(overrides: Partial<schema.ProjectMemberOffboardingPlan> = {}) {
  const now = Date.now();
  return {
    id: 'off_plan',
    projectId: 'proj-1',
    memberUserId: 'departing-user',
    requestedBy: 'owner-user',
    status: 'preview',
    resourceSummaryJson: '{}',
    createdAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    appliedAt: null,
    ...overrides,
  };
}

function makeTrigger(overrides: Partial<schema.TriggerRow> = {}): schema.TriggerRow {
  return {
    id: 'trigger-personal',
    projectId: 'proj-1',
    userId: 'departing-user',
    name: 'Nightly maintenance',
    description: null,
    status: 'active',
    sourceType: 'cron',
    cronExpression: '0 2 * * *',
    cronTimezone: 'UTC',
    skipIfRunning: true,
    promptTemplate: 'Check the repo',
    agentProfileId: null,
    skillId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    lastTriggeredAt: null,
    triggerCount: 0,
    nextFireAt: '2026-07-06T02:00:00.000Z',
    credentialBlockedReason: null,
    credentialBlockedAt: null,
    credentialBlockedBy: null,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeTask(overrides: Partial<schema.Task> = {}): schema.Task {
  return {
    id: 'task-queued',
    projectId: 'proj-1',
    userId: 'departing-user',
    parentTaskId: null,
    workspaceId: null,
    title: 'Queued maintenance task',
    description: null,
    status: 'queued',
    executionStep: null,
    priority: 0,
    agentProfileHint: null,
    skillId: null,
    skillHint: null,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    outputSummary: null,
    outputBranch: null,
    outputPrUrl: null,
    completionEvidence: null,
    finalizedAt: null,
    taskMode: 'task',
    dispatchDepth: 0,
    autoProvisionedNodeId: null,
    triggeredBy: 'user',
    triggerId: null,
    triggerExecutionId: null,
    agentCredentialSource: 'user',
    credentialAttributionUserId: 'departing-user',
    credentialAttributionProjectId: null,
    credentialAttributionSource: 'user',
    credentialBlockedReason: null,
    credentialBlockedAt: null,
    missionId: null,
    schedulerState: null,
    requestedVmSize: null,
    requestedVmSizeSource: null,
    provisionedVmSize: null,
    resourceRequirementsJson: null,
    resourceRequirementsSource: null,
    resolvedReservationJson: null,
    placementExplanationJson: null,
    createdBy: 'departing-user',
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeNode(overrides: Partial<schema.Node> = {}): schema.Node {
  return {
    id: 'node-live',
    userId: 'departing-user',
    name: 'workspace-node',
    status: 'active',
    vmSize: 'medium',
    vmLocation: 'nbg1',
    cloudProvider: 'hetzner',
    providerInstanceId: 'hcloud-1',
    ipAddress: '203.0.113.10',
    backendDnsRecordId: null,
    lastHeartbeatAt: '2026-07-05T00:00:00.000Z',
    agentReadyAt: '2026-07-05T00:00:00.000Z',
    healthStatus: 'healthy',
    heartbeatStaleAfterSeconds: 180,
    lastMetrics: null,
    warmSince: null,
    credentialSource: 'user',
    credentialAttributionUserId: 'departing-user',
    credentialAttributionProjectId: null,
    credentialAttributionSource: 'user',
    offboardingStatus: null,
    offboardingBlockedReason: null,
    offboardingBlockedAt: null,
    nodeRole: 'workspace',
    nodeMode: 'shared',
    errorMessage: null,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function makeDeploymentEnvironment(
  overrides: Partial<schema.DeploymentEnvironmentRow> = {}
): schema.DeploymentEnvironmentRow {
  return {
    id: 'deploy-env-1',
    projectId: 'proj-1',
    name: 'Production',
    status: 'active',
    nodeId: 'deploy-node',
    requiresVolumes: true,
    provider: 'hetzner',
    location: 'nbg1',
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    createdByUserId: 'departing-user',
    createdByAgentProfileId: null,
    createdByTaskId: null,
    createdByWorkspaceId: null,
    creationSource: 'user',
    secretsUpdatedAt: null,
    configUpdatedAt: null,
    observedAppliedSeq: null,
    observedStatus: null,
    observedErrorMessage: null,
    observedServicesJson: null,
    observedDeployStatusJson: null,
    observedDiskTelemetryJson: null,
    observedAt: null,
    agentDeployEnabled: true,
    offboardingStatus: null,
    agentDeployEnabledBy: null,
    agentDeployEnabledAt: null,
    agentDeployDisabledAt: null,
    allowedDeployProfileIdsJson: null,
    ...overrides,
  };
}

function makeAttachment(overrides: Partial<schema.CCAttachmentRow> = {}): schema.CCAttachmentRow {
  return {
    id: 'attach-departing-compute',
    configurationId: 'config-departing-compute',
    consumerKind: 'compute',
    consumerTarget: 'hetzner',
    userId: 'departing-user',
    projectId: 'proj-1',
    isActive: true,
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

function triggerDetails(hasCoverage = false) {
  return {
    status: 'active',
    sourceType: 'cron',
    agentTarget: 'claude-code',
    computeTarget: 'hetzner',
    remainingProjectCoverage: {
      agent: hasCoverage
        ? { attachmentId: 'attach-agent-owner', configurationId: 'config-agent-owner' }
        : null,
      compute: hasCoverage
        ? { attachmentId: 'attach-compute-owner', configurationId: 'config-compute-owner' }
        : null,
    },
  };
}

function taskDetails(status = 'queued') {
  return {
    status,
    taskMode: 'task',
    triggeredBy: 'user',
    rootTaskId: 'task-queued',
  };
}

function nodeDetails() {
  return {
    status: 'active',
    nodeRole: 'workspace',
    cloudProvider: 'hetzner',
    workspaceId: 'workspace-1',
    remainingProjectCoverage: null,
  };
}

function deploymentDetails() {
  return {
    status: 'active',
    nodeId: 'deploy-node',
    nodeStatus: 'active',
    requiresVolumes: true,
    remainingProjectCoverage: null,
  };
}

function attachmentDetails() {
  return {
    consumerKind: 'compute',
    consumerTarget: 'hetzner',
    attachmentUserId: 'departing-user',
    configurationOwnerId: 'departing-user',
    credentialOwnerId: 'departing-user',
    remainingProjectCoverage: null,
  };
}

function storedAction(input: {
  resourceKind: schema.ProjectMemberOffboardingResourceAction['resourceKind'];
  resourceId: string;
  recommendedAction: schema.ProjectMemberOffboardingResourceAction['recommendedAction'];
  details: Record<string, unknown>;
  credentialSourceBefore?: string;
  attributionUserIdBefore?: string | null;
  attributionProjectIdBefore?: string | null;
}) {
  return {
    resourceKind: input.resourceKind,
    resourceId: input.resourceId,
    credentialSourceBefore: input.credentialSourceBefore ?? 'user',
    attributionUserIdBefore: input.attributionUserIdBefore ?? 'departing-user',
    attributionProjectIdBefore: input.attributionProjectIdBefore ?? null,
    recommendedAction: input.recommendedAction,
    detailsJson: JSON.stringify(input.details),
  };
}

describe('project member offboarding apply', () => {
  let app: Hono<{ Bindings: Env }>;
  let selectResults: QueryResult[];
  let updatedRows: Array<{ table: unknown; values: Record<string, unknown> }>;
  let updateReturningRows: unknown[][];
  let transactionCalls: number;

  const env = {
    DATABASE: {} as D1Database,
    DEFAULT_TASK_AGENT_TYPE: 'claude-code',
  } as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUserId = 'owner-user';
    mocks.requireProjectCapability.mockResolvedValue(makeProject());
    selectResults = [];
    updatedRows = [];
    updateReturningRows = [];
    transactionCalls = 0;

    const makeSelectBuilder = () => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.leftJoin = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(() => Promise.resolve(selectResults.shift() ?? []));
      chain.orderBy = vi.fn(() => Promise.resolve(selectResults.shift() ?? []));
      chain.then = (
        resolve: (value: QueryResult) => unknown,
        reject: (reason?: unknown) => unknown
      ) => Promise.resolve(selectResults.shift() ?? []).then(resolve, reject);
      return chain;
    };

    const mockDb = {
      select: vi.fn(() => makeSelectBuilder()),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updatedRows.push({ table, values });
          const updateChain = {
            where: vi.fn(() => updateChain),
            returning: vi.fn(() => Promise.resolve(updateReturningRows.shift() ?? [{ id: 'updated' }])),
            then: (resolve: () => unknown) => Promise.resolve(undefined).then(resolve),
          };
          return updateChain;
        }),
      })),
      transaction: vi.fn(async (callback: (tx: typeof mockDb) => Promise<unknown>) => {
        transactionCalls += 1;
        return callback(mockDb);
      }),
    };
    (drizzle as unknown as ReturnType<typeof vi.fn>).mockReturnValue(mockDb);

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/projects', projectMembersRoutes);
  });

  async function apply(actions: Array<{ resourceKind: string; resourceId: string; action: string }>) {
    return app.request(
      '/api/projects/proj-1/members/departing-user/offboarding-apply',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: 'off_plan', actions, finalMemberStatus: 'removed' }),
      },
      env
    );
  }

  it('applies break-and-flag actions, disables triggers, cancels queued tasks, and removes the member', async () => {
    selectResults = [
      [makeMember('owner-user', 'owner'), makeMember('departing-user', 'admin')],
      [makePlan()],
      [
        storedAction({
          resourceKind: 'trigger',
          resourceId: 'trigger-personal',
          recommendedAction: 'break_and_flag',
          attributionProjectIdBefore: 'proj-1',
          details: triggerDetails(),
        }),
        storedAction({
          resourceKind: 'task_tree',
          resourceId: 'task-queued',
          recommendedAction: 'break_and_flag',
          details: taskDetails(),
        }),
      ],
      [],
      [makeTrigger()],
      [makeTask()],
      [],
      [],
      [],
    ];
    updateReturningRows = [[{ id: 'trigger-personal' }], [{ id: 'task-queued' }], [{ userId: 'departing-user' }]];

    const response = await apply([
      { resourceKind: 'trigger', resourceId: 'trigger-personal', action: 'break_and_flag' },
      { resourceKind: 'task_tree', resourceId: 'task-queued', action: 'break_and_flag' },
    ]);
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      projectId: 'proj-1',
      memberUserId: 'departing-user',
      status: 'removed',
      resourceResults: [
        { resourceKind: 'trigger', resourceId: 'trigger-personal', status: 'applied' },
        { resourceKind: 'task_tree', resourceId: 'task-queued', status: 'applied' },
      ],
    });
    expect(mocks.requireProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'owner-user',
      'member:manage'
    );
    expect(transactionCalls).toBe(0);
    expect(updatedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: schema.triggers,
          values: expect.objectContaining({
            status: 'disabled',
            nextFireAt: null,
            credentialBlockedReason: 'member_removed',
            credentialBlockedBy: 'owner-user',
          }),
        }),
        expect.objectContaining({
          table: schema.tasks,
          values: expect.objectContaining({
            status: 'failed',
            credentialBlockedReason: 'member_removed_credentials_unavailable',
          }),
        }),
        expect.objectContaining({
          table: schema.projectMembers,
          values: expect.objectContaining({ status: 'removed', removedAt: body.appliedAt }),
        }),
        expect.objectContaining({
          table: schema.projectMemberOffboardingPlans,
          values: expect.objectContaining({ status: 'applied', appliedAt: body.appliedAt }),
        }),
      ])
    );
    const auditUpdates = updatedRows.filter(
      (row) => row.table === schema.projectMemberOffboardingResourceActions
    );
    expect(auditUpdates).toEqual([
      expect.objectContaining({
        values: expect.objectContaining({ selectedAction: 'break_and_flag', status: 'applied' }),
      }),
      expect.objectContaining({
        values: expect.objectContaining({ selectedAction: 'break_and_flag', status: 'applied' }),
      }),
    ]);
  });

  it('keeps a trigger active when reattaching to existing project credential coverage', async () => {
    selectResults = [
      [makeMember('owner-user', 'owner'), makeMember('departing-user', 'admin')],
      [makePlan()],
      [
        storedAction({
          resourceKind: 'trigger',
          resourceId: 'trigger-personal',
          recommendedAction: 'reattach_to_project',
          attributionProjectIdBefore: 'proj-1',
          details: triggerDetails(true),
        }),
      ],
      [
        {
          attachmentId: 'attach-agent-owner',
          consumerKind: 'agent',
          consumerTarget: 'claude-code',
          configurationId: 'config-agent-owner',
          configurationOwnerId: 'owner-user',
          credentialOwnerId: 'owner-user',
        },
        {
          attachmentId: 'attach-compute-owner',
          consumerKind: 'compute',
          consumerTarget: 'hetzner',
          configurationId: 'config-compute-owner',
          configurationOwnerId: 'owner-user',
          credentialOwnerId: 'owner-user',
        },
      ],
      [makeTrigger()],
      [],
      [],
      [],
      [],
    ];
    updateReturningRows = [[{ userId: 'departing-user' }]];

    const response = await apply([
      { resourceKind: 'trigger', resourceId: 'trigger-personal', action: 'reattach_to_project' },
    ]);
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.resourceResults).toEqual([
      expect.objectContaining({
        resourceKind: 'trigger',
        action: 'reattach_to_project',
        blocksRemoval: false,
      }),
    ]);
    expect(updatedRows.some((row) => row.table === schema.triggers)).toBe(false);
    expect(updatedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: schema.projectMembers,
          values: expect.objectContaining({ status: 'removed' }),
        }),
      ])
    );
  });

  it('defers removal for a node with unavailable teardown credentials and returns blockers', async () => {
    const node = makeNode();
    selectResults = [
      [makeMember('owner-user', 'owner'), makeMember('departing-user', 'admin')],
      [makePlan()],
      [
        storedAction({
          resourceKind: 'node',
          resourceId: 'node-live',
          recommendedAction: 'break_and_flag',
          details: nodeDetails(),
        }),
      ],
      [],
      [],
      [],
      [{ workspaceId: 'workspace-1', workspaceName: 'Main workspace', node }],
      [],
      [],
    ];

    const response = await apply([
      { resourceKind: 'node', resourceId: 'node-live', action: 'defer_removal' },
    ]);
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      status: 'active',
      resourceResults: [
        {
          resourceKind: 'node',
          resourceId: 'node-live',
          action: 'defer_removal',
          status: 'skipped',
          blocksRemoval: true,
        },
      ],
    });
    expect(updatedRows.some((row) => row.table === schema.projectMembers)).toBe(false);
  });

  it('breaks deployment environments and disables departing project attachments', async () => {
    const deploymentNode = makeNode({ id: 'deploy-node', nodeRole: 'deployment' });
    selectResults = [
      [makeMember('owner-user', 'owner'), makeMember('departing-user', 'admin')],
      [makePlan()],
      [
        storedAction({
          resourceKind: 'deployment_environment',
          resourceId: 'deploy-env-1',
          recommendedAction: 'break_and_flag',
          details: deploymentDetails(),
        }),
        storedAction({
          resourceKind: 'project_attachment',
          resourceId: 'attach-departing-compute',
          recommendedAction: 'break_and_flag',
          credentialSourceBefore: 'project',
          attributionProjectIdBefore: 'proj-1',
          details: attachmentDetails(),
        }),
      ],
      [],
      [],
      [],
      [],
      [{ environment: makeDeploymentEnvironment(), node: deploymentNode }],
      [
        {
          attachment: makeAttachment(),
          configurationName: 'Departing compute',
          configurationOwnerId: 'departing-user',
          credentialOwnerId: 'departing-user',
        },
      ],
    ];
    updateReturningRows = [
      [{ id: 'deploy-env-1' }],
      [{ id: 'deploy-node' }],
      [{ id: 'attach-departing-compute' }],
    ];

    const response = await apply([
      {
        resourceKind: 'deployment_environment',
        resourceId: 'deploy-env-1',
        action: 'break_and_flag',
      },
      {
        resourceKind: 'project_attachment',
        resourceId: 'attach-departing-compute',
        action: 'break_and_flag',
      },
    ]);
    const body = await response.json();

    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      status: 'active',
      resourceResults: [
        {
          resourceKind: 'deployment_environment',
          resourceId: 'deploy-env-1',
          action: 'break_and_flag',
          status: 'applied',
          blocksRemoval: true,
        },
        {
          resourceKind: 'project_attachment',
          resourceId: 'attach-departing-compute',
          action: 'break_and_flag',
          status: 'applied',
          blocksRemoval: false,
        },
      ],
    });
    expect(updatedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: schema.deploymentEnvironments,
          values: expect.objectContaining({ offboardingStatus: 'blocked' }),
        }),
        expect.objectContaining({
          table: schema.nodes,
          values: expect.objectContaining({
            offboardingStatus: 'blocked',
            offboardingBlockedReason: 'member_removed_credentials_unavailable',
          }),
        }),
        expect.objectContaining({
          table: schema.ccAttachments,
          values: expect.objectContaining({ isActive: false }),
        }),
      ])
    );
    expect(updatedRows.some((row) => row.table === schema.projectMembers)).toBe(false);
    expect(
      updatedRows.filter((row) => row.table === schema.projectMemberOffboardingResourceActions)
    ).toEqual([
      expect.objectContaining({
        values: expect.objectContaining({ selectedAction: 'break_and_flag', status: 'applied' }),
      }),
      expect.objectContaining({
        values: expect.objectContaining({ selectedAction: 'break_and_flag', status: 'applied' }),
      }),
    ]);
  });

  it('rejects expired plans', async () => {
    selectResults = [
      [makeMember('owner-user', 'owner'), makeMember('departing-user', 'admin')],
      [makePlan({ expiresAt: '2026-07-04T00:00:00.000Z' })],
    ];

    const response = await apply([]);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'expired_plan' });
    expect(transactionCalls).toBe(0);
  });

  it('rejects stale plans when resource state changed after preview', async () => {
    selectResults = [
      [makeMember('owner-user', 'owner'), makeMember('departing-user', 'admin')],
      [makePlan()],
      [
        storedAction({
          resourceKind: 'trigger',
          resourceId: 'trigger-personal',
          recommendedAction: 'break_and_flag',
          attributionProjectIdBefore: 'proj-1',
          details: triggerDetails(),
        }),
      ],
      [],
      [],
      [],
      [],
      [],
      [],
    ];

    const response = await apply([
      { resourceKind: 'trigger', resourceId: 'trigger-personal', action: 'break_and_flag' },
    ]);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'stale_plan' });
    expect(transactionCalls).toBe(0);
  });

  it('rejects applying removal to the sole owner before ownership transfer', async () => {
    selectResults = [[makeMember('departing-user', 'owner')]];

    const response = await apply([]);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'last_owner_requires_transfer' });
    expect(transactionCalls).toBe(0);
  });

  it('rejects unresolved live resources when an action is missing', async () => {
    selectResults = [
      [makeMember('owner-user', 'owner'), makeMember('departing-user', 'admin')],
      [makePlan()],
      [
        storedAction({
          resourceKind: 'trigger',
          resourceId: 'trigger-personal',
          recommendedAction: 'break_and_flag',
          attributionProjectIdBefore: 'proj-1',
          details: triggerDetails(),
        }),
      ],
      [],
      [makeTrigger()],
      [],
      [],
      [],
      [],
    ];

    const response = await apply([]);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'unresolved_credential_attribution',
    });
    expect(transactionCalls).toBe(0);
  });

  it('records selected action and status on audit rows for deferred resources', async () => {
    const node = makeNode();
    selectResults = [
      [makeMember('owner-user', 'owner'), makeMember('departing-user', 'admin')],
      [makePlan()],
      [
        storedAction({
          resourceKind: 'node',
          resourceId: 'node-live',
          recommendedAction: 'break_and_flag',
          details: nodeDetails(),
        }),
      ],
      [],
      [],
      [],
      [{ workspaceId: 'workspace-1', workspaceName: 'Main workspace', node }],
      [],
      [],
    ];

    const response = await apply([
      { resourceKind: 'node', resourceId: 'node-live', action: 'defer_removal' },
    ]);

    expect(response.status).toBe(200);
    expect(updatedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: schema.projectMemberOffboardingResourceActions,
          values: expect.objectContaining({ selectedAction: 'defer_removal', status: 'skipped' }),
        }),
      ])
    );
  });

  it('keeps project-scoped write predicates in the apply service', async () => {
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile('src/services/project-offboarding-apply.ts', 'utf8')
    );

    expect(source).toContain('eq(schema.triggers.projectId, input.projectId)');
    expect(source).toContain('eq(schema.tasks.projectId, input.projectId)');
    expect(source).toContain('eq(schema.ccAttachments.projectId, input.projectId)');
    expect(source).toContain('eq(schema.projectMembers.projectId, input.project.id)');
    expect(source).toContain('eq(schema.deploymentEnvironments.projectId, input.projectId)');
  });
});
