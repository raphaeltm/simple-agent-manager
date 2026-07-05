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
    createdAt: '2026-07-05T00:00:00.000Z',
    updatedAt: '2026-07-05T00:00:00.000Z',
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
    id: 'task-running',
    projectId: 'proj-1',
    userId: 'departing-user',
    parentTaskId: null,
    workspaceId: null,
    title: 'Investigate prod issue',
    description: null,
    status: 'running',
    executionStep: null,
    priority: 0,
    agentProfileHint: null,
    skillId: null,
    skillHint: null,
    startedAt: '2026-07-05T00:00:00.000Z',
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

describe('project member offboarding preview', () => {
  let app: Hono<{ Bindings: Env }>;
  let selectResults: QueryResult[];
  let insertedRows: Array<{ table: unknown; values: unknown }>;
  let updatedRows: Array<{ table: unknown; values: Record<string, unknown> }>;

  const env = {
    DATABASE: {} as D1Database,
    DEFAULT_TASK_AGENT_TYPE: 'claude-code',
  } as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.currentUserId = 'owner-user';
    mocks.requireProjectCapability.mockResolvedValue(makeProject());
    selectResults = [];
    insertedRows = [];
    updatedRows = [];

    const makeSelectBuilder = () => {
      const chain: Record<string, unknown> = {};
      chain.from = vi.fn(() => chain);
      chain.innerJoin = vi.fn(() => chain);
      chain.leftJoin = vi.fn(() => chain);
      chain.where = vi.fn(() => chain);
      chain.limit = vi.fn(() => Promise.resolve(selectResults.shift() ?? []));
      chain.orderBy = vi.fn(() => Promise.resolve(selectResults.shift() ?? []));
      chain.then = (resolve: (value: QueryResult) => unknown, reject: (reason?: unknown) => unknown) =>
        Promise.resolve(selectResults.shift() ?? []).then(resolve, reject);
      return chain;
    };

    const mockDb = {
      select: vi.fn(() => makeSelectBuilder()),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => {
          updatedRows.push({ table, values });
          const updateChain = {
            where: vi.fn(() => updateChain),
            then: (resolve: () => unknown) => Promise.resolve(undefined).then(resolve),
          };
          return updateChain;
        }),
      })),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((values: unknown) => {
          insertedRows.push({ table, values });
          return Promise.resolve(undefined);
        }),
      })),
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

  it('requires ownership transfer before previewing the sole owner', async () => {
    selectResults = [[makeMember('owner-user', 'owner')]];

    const response = await app.request(
      '/api/projects/proj-1/members/owner-user/offboarding-preview',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: 'last_owner_requires_transfer',
    });
    expect(mocks.requireProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'proj-1',
      'owner-user',
      'project:delete'
    );
    expect(insertedRows).toHaveLength(0);
  });

  it('persists a preview plan for live personal-backed resources without leaking secrets', async () => {
    const node = makeNode();
    selectResults = [
      [makeMember('owner-user', 'owner'), makeMember('departing-user', 'admin')],
      [
        {
          attachmentId: 'attach-remaining-agent',
          consumerKind: 'agent',
          consumerTarget: 'claude-code',
          configurationId: 'config-remaining-agent',
          configurationOwnerId: 'owner-user',
          credentialOwnerId: 'owner-user',
        },
      ],
      [makeTrigger()],
      [makeTask()],
      [{ workspaceId: 'workspace-1', workspaceName: 'Main workspace', node }],
      [],
      [
        {
          attachment: {
            id: 'attach-departing-compute',
            configurationId: 'config-departing-compute',
            consumerKind: 'compute',
            consumerTarget: 'hetzner',
            userId: 'departing-user',
            projectId: 'proj-1',
            isActive: true,
            createdAt: '2026-07-05T00:00:00.000Z',
            updatedAt: '2026-07-05T00:00:00.000Z',
          },
          configurationName: 'Departing Hetzner',
          configurationOwnerId: 'departing-user',
          credentialOwnerId: 'departing-user',
          encryptedToken: 'must-not-leak',
        },
      ],
    ];

    const response = await app.request(
      '/api/projects/proj-1/members/departing-user/offboarding-preview',
      { method: 'POST' },
      env
    );

    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({
      projectId: 'proj-1',
      memberUserId: 'departing-user',
      canApply: false,
      requiresHumanDecision: true,
      summary: {
        breakAndFlag: 4,
        reattachAvailable: 0,
        blockingTeardown: 2,
      },
    });
    expect(body.offboardingPlanId).toMatch(/^off_/);
    expect(body.resources.map((resource: { resourceKind: string }) => resource.resourceKind)).toEqual([
      'trigger',
      'task_tree',
      'node',
      'project_attachment',
    ]);
    expect(
      body.resources.every(
        (resource: { recommendedAction: string }) => resource.recommendedAction === 'break_and_flag'
      )
    ).toBe(true);
    expect(JSON.stringify(body)).not.toContain('must-not-leak');

    expect(updatedRows).toContainEqual({
      table: schema.projectMemberOffboardingPlans,
      values: { status: 'expired' },
    });
    expect(insertedRows[0]).toMatchObject({
      table: schema.projectMemberOffboardingPlans,
      values: expect.objectContaining({
        id: body.offboardingPlanId,
        projectId: 'proj-1',
        memberUserId: 'departing-user',
        requestedBy: 'owner-user',
        status: 'preview',
      }),
    });
    expect(insertedRows[1]).toMatchObject({
      table: schema.projectMemberOffboardingResourceActions,
      values: expect.arrayContaining([
        expect.objectContaining({
          planId: body.offboardingPlanId,
          resourceKind: 'trigger',
          resourceId: 'trigger-personal',
          recommendedAction: 'break_and_flag',
        }),
      ]),
    });
  });

  it('offers project reattachment only when remaining active project coverage exists', async () => {
    selectResults = [
      [makeMember('owner-user', 'owner'), makeMember('departing-user', 'admin')],
      [
        {
          attachmentId: 'attach-remaining-agent',
          consumerKind: 'agent',
          consumerTarget: 'claude-code',
          configurationId: 'config-remaining-agent',
          configurationOwnerId: 'owner-user',
          credentialOwnerId: 'owner-user',
        },
        {
          attachmentId: 'attach-remaining-compute',
          consumerKind: 'compute',
          consumerTarget: 'hetzner',
          configurationId: 'config-remaining-compute',
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

    const response = await app.request(
      '/api/projects/proj-1/members/departing-user/offboarding-preview',
      { method: 'POST' },
      env
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.summary).toMatchObject({ breakAndFlag: 0, reattachAvailable: 1 });
    expect(body.resources[0]).toMatchObject({
      resourceKind: 'trigger',
      recommendedAction: 'reattach_to_project',
      availableActions: ['reattach_to_project', 'break_and_flag', 'defer_removal'],
    });
  });
});
