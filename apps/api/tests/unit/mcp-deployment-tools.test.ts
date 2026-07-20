import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import type { McpTokenData } from '../../src/services/mcp-token';

const mockDrizzle = vi.fn();
const mockGetNodeLogsFromNode = vi.fn();

vi.mock('drizzle-orm/d1', () => ({
  drizzle: (...args: unknown[]) => mockDrizzle(...args),
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    and: (...conditions: unknown[]) => ({ __testOp: 'and', conditions }),
    count: () => ({ __testCount: true }),
    desc: (column: unknown) => ({ __testOrder: 'desc', column }),
    eq: (column: unknown, value: unknown) => ({ __testOp: 'eq', column, value }),
    gt: (column: unknown, value: unknown) => ({ __testOp: 'gt', column, value }),
    inArray: (column: unknown, values: unknown[]) => ({
      __testOp: 'inArray',
      column,
      values,
    }),
  };
});

vi.mock('../../src/services/node-agent', () => ({
  getNodeLogsFromNode: (...args: unknown[]) => mockGetNodeLogsFromNode(...args),
}));

vi.mock('../../src/services/node-agent-diagnostics', () => ({
  getNodeLogsFromNode: (...args: unknown[]) => mockGetNodeLogsFromNode(...args),
  getNodeSystemInfoFromNode: vi.fn(),
  listNodeContainersFromNode: vi.fn(),
}));

const schema = await import('../../src/db/schema');
const {
  handleCreateDeploymentEnvironment,
  handleListDeploymentEnvironmentConfig,
  handleListDeploymentEnvironments,
  handleListDeploymentRoutes,
  handlePreviewDeploymentRoutes,
  handleReadDeploymentLogs,
  handleSetDeploymentEnvironmentConfig,
} = await import('../../src/routes/mcp/deployment-tools');

type Row = Record<string, unknown>;

interface TestDbState {
  agentProfiles: Row[];
  deploymentCustomDomains: Row[];
  deploymentEnvironmentConfigVars: Row[];
  deploymentEnvironments: Row[];
  deploymentReleases: Row[];
  nodes: Row[];
  tasks: Row[];
}

interface TestCondition {
  __testOp?: string;
  column?: unknown;
  conditions?: unknown[];
  value?: unknown;
  values?: unknown[];
}

const ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function tokenData(overrides: Partial<McpTokenData> = {}): McpTokenData {
  return {
    taskId: 'task-1',
    projectId: 'proj-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    createdAt: '2026-06-22T00:00:00Z',
    ...overrides,
  };
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    BASE_DOMAIN: 'sammy.party',
    DATABASE: {},
    ENCRYPTION_KEY,
    ...overrides,
  } as Env;
}

function deploymentEnvironment(overrides: Row = {}): Row {
  return {
    id: 'env-1',
    projectId: 'proj-1',
    name: 'staging',
    status: 'active',
    nodeId: null,
    provider: 'docker',
    location: 'local',
    configUpdatedAt: null,
    createdAt: '2026-06-22T00:00:00Z',
    createdByAgentProfileId: null,
    createdByTaskId: null,
    createdByUserId: null,
    createdByWorkspaceId: null,
    creationSource: 'user',
    updatedAt: '2026-06-22T00:00:00Z',
    observedAppliedSeq: null,
    observedStatus: null,
    observedErrorMessage: null,
    observedServicesJson: null,
    observedDeployStatusJson: null,
    observedDiskTelemetryJson: null,
    observedAt: null,
    agentDeployEnabled: true,
    agentDeployEnabledBy: 'user-1',
    agentDeployEnabledAt: '2026-06-22T00:00:00Z',
    agentDeployDisabledAt: null,
    allowedDeployProfileIdsJson: null,
    ...overrides,
  };
}

function createDbState(overrides: Partial<TestDbState> = {}): TestDbState {
  return {
    agentProfiles: [{ id: 'profile-allowed', projectId: 'proj-1' }],
    deploymentCustomDomains: [],
    deploymentEnvironmentConfigVars: [],
    deploymentEnvironments: [deploymentEnvironment()],
    deploymentReleases: [],
    nodes: [],
    tasks: [{ id: 'task-1', agentProfileHint: null }],
    ...overrides,
  };
}

function getColumnName(column: unknown): string | null {
  const candidate = column as { config?: { name?: unknown }; name?: unknown } | null;
  if (typeof candidate?.name === 'string') return candidate.name;
  if (typeof candidate?.config?.name === 'string') return candidate.config.name;
  return null;
}

function fieldForColumn(column: unknown): string | null {
  const knownColumns = new Map<unknown, string>([
    [schema.deploymentEnvironmentConfigVars.envKey, 'envKey'],
    [schema.deploymentEnvironmentConfigVars.environmentId, 'environmentId'],
    [schema.deploymentEnvironmentConfigVars.id, 'id'],
    [schema.deploymentCustomDomains.createdAt, 'createdAt'],
    [schema.deploymentCustomDomains.environmentId, 'environmentId'],
    [schema.deploymentCustomDomains.hostname, 'hostname'],
    [schema.deploymentCustomDomains.id, 'id'],
    [schema.deploymentCustomDomains.port, 'port'],
    [schema.deploymentCustomDomains.routeIndex, 'routeIndex'],
    [schema.deploymentCustomDomains.service, 'service'],
    [schema.deploymentCustomDomains.verificationError, 'verificationError'],
    [schema.deploymentCustomDomains.verificationStatus, 'verificationStatus'],
    [schema.deploymentCustomDomains.verifiedAt, 'verifiedAt'],
    [schema.deploymentCustomDomains.verifiedCnameTarget, 'verifiedCnameTarget'],
    [schema.deploymentCustomDomains.desiredState, 'desiredState'],
    [schema.deploymentCustomDomains.routingStatus, 'routingStatus'],
    [schema.deploymentCustomDomains.activationRoutingRevision, 'activationRoutingRevision'],
    [schema.deploymentCustomDomains.deactivationRoutingRevision, 'deactivationRoutingRevision'],
    [schema.deploymentCustomDomains.deletedAt, 'deletedAt'],
    [schema.agentProfiles.id, 'id'],
    [schema.agentProfiles.projectId, 'projectId'],
    [schema.deploymentEnvironments.agentDeployDisabledAt, 'agentDeployDisabledAt'],
    [schema.deploymentEnvironments.agentDeployEnabled, 'agentDeployEnabled'],
    [schema.deploymentEnvironments.agentDeployEnabledAt, 'agentDeployEnabledAt'],
    [schema.deploymentEnvironments.agentDeployEnabledBy, 'agentDeployEnabledBy'],
    [schema.deploymentEnvironments.allowedDeployProfileIdsJson, 'allowedDeployProfileIdsJson'],
    [schema.deploymentEnvironments.configUpdatedAt, 'configUpdatedAt'],
    [schema.deploymentEnvironments.createdAt, 'createdAt'],
    [schema.deploymentEnvironments.createdByAgentProfileId, 'createdByAgentProfileId'],
    [schema.deploymentEnvironments.createdByTaskId, 'createdByTaskId'],
    [schema.deploymentEnvironments.createdByUserId, 'createdByUserId'],
    [schema.deploymentEnvironments.createdByWorkspaceId, 'createdByWorkspaceId'],
    [schema.deploymentEnvironments.creationSource, 'creationSource'],
    [schema.deploymentEnvironments.id, 'id'],
    [schema.deploymentEnvironments.name, 'name'],
    [schema.deploymentEnvironments.projectId, 'projectId'],
    [schema.deploymentEnvironments.status, 'status'],
    [schema.deploymentReleases.createdAt, 'createdAt'],
    [schema.deploymentReleases.environmentId, 'environmentId'],
    [schema.deploymentReleases.id, 'id'],
    [schema.deploymentReleases.manifest, 'manifest'],
    [schema.deploymentReleases.source, 'source'],
    [schema.deploymentReleases.status, 'status'],
    [schema.deploymentReleases.version, 'version'],
    [schema.nodes.id, 'id'],
    [schema.nodes.status, 'status'],
    [schema.nodes.userId, 'userId'],
    [schema.tasks.agentProfileHint, 'agentProfileHint'],
    [schema.tasks.id, 'id'],
  ]);
  const known = knownColumns.get(column);
  if (known) return known;

  const name = getColumnName(column);
  if (!name) return null;
  return (
    (
      {
        agent_deploy_disabled_at: 'agentDeployDisabledAt',
        agent_deploy_enabled: 'agentDeployEnabled',
        agent_deploy_enabled_at: 'agentDeployEnabledAt',
        agent_deploy_enabled_by: 'agentDeployEnabledBy',
        agent_profile_hint: 'agentProfileHint',
        allowed_deploy_profile_ids_json: 'allowedDeployProfileIdsJson',
        config_updated_at: 'configUpdatedAt',
        created_at: 'createdAt',
        created_by_agent_profile_id: 'createdByAgentProfileId',
        created_by_task_id: 'createdByTaskId',
        created_by_user_id: 'createdByUserId',
        created_by_workspace_id: 'createdByWorkspaceId',
        creation_source: 'creationSource',
        env_key: 'envKey',
        environment_id: 'environmentId',
        hostname: 'hostname',
        id: 'id',
        manifest: 'manifest',
        name: 'name',
        port: 'port',
        project_id: 'projectId',
        route_index: 'routeIndex',
        service: 'service',
        source: 'source',
        status: 'status',
        user_id: 'userId',
        verification_error: 'verificationError',
        verification_status: 'verificationStatus',
        verified_at: 'verifiedAt',
        version: 'version',
      } as Record<string, string>
    )[name] ?? null
  );
}

function rowsForTable(state: TestDbState, table: unknown): Row[] {
  if (table === schema.agentProfiles) return state.agentProfiles;
  if (table === schema.deploymentCustomDomains) return state.deploymentCustomDomains;
  if (table === schema.deploymentEnvironments) return state.deploymentEnvironments;
  if (table === schema.deploymentEnvironmentConfigVars) {
    return state.deploymentEnvironmentConfigVars;
  }
  if (table === schema.deploymentReleases) return state.deploymentReleases;
  if (table === schema.nodes) return state.nodes;
  if (table === schema.tasks) return state.tasks;
  return [];
}

function matchesCondition(row: Row, condition: unknown): boolean {
  if (!condition) return true;
  const testCondition = condition as TestCondition;
  if (testCondition.__testOp === 'and') {
    return (testCondition.conditions ?? []).every((item) => matchesCondition(row, item));
  }
  if (testCondition.__testOp === 'eq') {
    const field = fieldForColumn(testCondition.column);
    return field ? row[field] === testCondition.value : true;
  }
  if (testCondition.__testOp === 'gt') {
    const field = fieldForColumn(testCondition.column);
    return field ? Number(row[field]) > Number(testCondition.value) : true;
  }
  if (testCondition.__testOp === 'inArray') {
    const field = fieldForColumn(testCondition.column);
    return field ? (testCondition.values ?? []).includes(row[field]) : true;
  }
  return true;
}

function projectRows(selection: Record<string, unknown> | undefined, rows: Row[]): Row[] {
  if (!selection) return rows.map((row) => ({ ...row }));
  if (Object.values(selection).some((value) => (value as { __testCount?: boolean }).__testCount)) {
    return [{ count: rows.length }];
  }
  return rows.map((row) => {
    const projected: Row = {};
    for (const [key, column] of Object.entries(selection)) {
      const field = fieldForColumn(column);
      projected[key] = field ? row[field] : undefined;
    }
    return projected;
  });
}

function createSelectBuilder(
  state: TestDbState,
  table: unknown,
  selection?: Record<string, unknown>
) {
  let condition: unknown = null;
  let order: unknown[] = [];

  function execute(): Row[] {
    const rows = rowsForTable(state, table).filter((row) => matchesCondition(row, condition));
    const ordered = [...rows];
    for (const item of order.slice().reverse()) {
      const orderItem = item as { __testOrder?: string; column?: unknown };
      const column = orderItem.__testOrder ? orderItem.column : item;
      const field = fieldForColumn(column);
      if (!field) continue;
      ordered.sort((left, right) =>
        String(left[field] ?? '').localeCompare(String(right[field] ?? ''))
      );
      if (orderItem.__testOrder === 'desc') ordered.reverse();
    }
    return projectRows(selection, ordered);
  }

  const builder = {
    limit: (count: number) => Promise.resolve(execute().slice(0, count)),
    orderBy: (...items: unknown[]) => {
      order = items;
      return builder;
    },
    then: (resolve: (rows: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(execute()).then(resolve, reject),
    where: (nextCondition: unknown) => {
      condition = nextCondition;
      return builder;
    },
  };
  return builder;
}

function createFakeDb(state: TestDbState) {
  return {
    insert: (table: unknown) => ({
      values: async (values: Row) => {
        rowsForTable(state, table).push({ ...values });
      },
    }),
    select: (selection?: Record<string, unknown>) => ({
      from: (table: unknown) => createSelectBuilder(state, table, selection),
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: async (condition: unknown) => {
          for (const row of rowsForTable(state, table)) {
            if (matchesCondition(row, condition)) {
              Object.assign(row, values);
            }
          }
        },
      }),
    }),
  };
}

function installDb(state: TestDbState) {
  const db = createFakeDb(state);
  mockDrizzle.mockReturnValue(db);
  return db;
}

function parseToolPayload(response: { result?: unknown }) {
  const result = response.result as { content?: Array<{ text?: string }> } | undefined;
  const text = result?.content?.[0]?.text;
  if (!text) throw new Error(`missing MCP text response: ${JSON.stringify(response)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

describe('deployment MCP tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetNodeLogsFromNode.mockResolvedValue({
      entries: [],
      hasMore: false,
      nextCursor: null,
    });
  });

  it('creates an agent-owned deployment environment restricted to the creator profile', async () => {
    const state = createDbState({
      deploymentEnvironments: [],
      tasks: [{ id: 'task-1', agentProfileHint: 'profile-allowed' }],
    });
    installDb(state);

    const createResponse = await handleCreateDeploymentEnvironment(
      'req-create',
      { name: 'preview-a' },
      tokenData(),
      env()
    );
    const createPayload = parseToolPayload(createResponse);

    expect(createResponse.error).toBeUndefined();
    expect(createPayload.creatorProfileId).toBe('profile-allowed');
    expect(createPayload.environment).toMatchObject({
      agentDeployEnabled: true,
      allowedDeployProfileIdsJson: '["profile-allowed"]',
      createdByAgentProfileId: 'profile-allowed',
      createdByTaskId: 'task-1',
      createdByUserId: 'user-1',
      createdByWorkspaceId: 'ws-1',
      creationSource: 'agent-mcp',
      name: 'preview-a',
      projectId: 'proj-1',
      status: 'active',
    });

    const created = state.deploymentEnvironments[0];
    expect(created).toMatchObject({
      agentDeployEnabled: true,
      allowedDeployProfileIdsJson: '["profile-allowed"]',
      createdByAgentProfileId: 'profile-allowed',
      createdByTaskId: 'task-1',
      createdByUserId: 'user-1',
      creationSource: 'agent-mcp',
    });

    const creatorListResponse = await handleListDeploymentEnvironments(
      'req-list-creator',
      {},
      tokenData(),
      env()
    );
    const creatorListPayload = parseToolPayload(creatorListResponse);
    expect(creatorListPayload.environments).toEqual([
      expect.objectContaining({ name: 'preview-a' }),
    ]);

    state.tasks = [{ id: 'task-2', agentProfileHint: 'profile-other' }];
    const otherListResponse = await handleListDeploymentEnvironments(
      'req-list-other',
      {},
      tokenData({ taskId: 'task-2' }),
      env()
    );
    const otherListPayload = parseToolPayload(otherListResponse);
    expect(otherListPayload.environments).toEqual([]);
  });

  it('denies deployment environment creation without a task/profile context', async () => {
    installDb(
      createDbState({
        deploymentEnvironments: [],
        tasks: [{ id: 'task-1', agentProfileHint: null }],
      })
    );

    const noTaskResponse = await handleCreateDeploymentEnvironment(
      'req-no-task',
      { name: 'preview-a' },
      tokenData({ taskId: undefined }),
      env()
    );
    expect(noTaskResponse.error?.message).toContain('requires an MCP token with a task context');

    const noProfileResponse = await handleCreateDeploymentEnvironment(
      'req-no-profile',
      { name: 'preview-a' },
      tokenData(),
      env()
    );
    expect(noProfileResponse.error?.message).toContain('resolved agent profile');
  });

  it('preserves duplicate deployment environment name conflict behavior', async () => {
    installDb(
      createDbState({
        deploymentEnvironments: [deploymentEnvironment({ name: 'preview-a' })],
        tasks: [{ id: 'task-1', agentProfileHint: 'profile-allowed' }],
      })
    );

    const response = await handleCreateDeploymentEnvironment(
      'req-duplicate',
      { name: 'preview-a' },
      tokenData(),
      env()
    );

    expect(response.error?.message).toBe('Environment "preview-a" already exists in this project');
  });

  it('requires owner-created reserved production environment names', async () => {
    installDb(
      createDbState({
        deploymentEnvironments: [],
        tasks: [{ id: 'task-1', agentProfileHint: 'profile-allowed' }],
      })
    );

    const response = await handleCreateDeploymentEnvironment(
      'req-reserved',
      { name: 'production' },
      tokenData(),
      env()
    );

    expect(response.error?.message).toContain('reserved deployment environment names');
  });

  it('uses configured reserved deployment environment names for MCP creation', async () => {
    const state = createDbState({
      deploymentEnvironments: [],
      tasks: [{ id: 'task-1', agentProfileHint: 'profile-allowed' }],
    });
    installDb(state);

    const productionResponse = await handleCreateDeploymentEnvironment(
      'req-production',
      { name: 'production' },
      tokenData(),
      env({ AGENT_DEPLOYMENT_RESERVED_ENVIRONMENT_NAMES: 'live' })
    );
    expect(productionResponse.error).toBeUndefined();

    const liveResponse = await handleCreateDeploymentEnvironment(
      'req-live',
      { name: 'live' },
      tokenData(),
      env({ AGENT_DEPLOYMENT_RESERVED_ENVIRONMENT_NAMES: 'live' })
    );
    expect(liveResponse.error?.message).toContain('reserved deployment environment names');
  });

  it('lists active deployment environments allowed for the current agent profile', async () => {
    installDb(
      createDbState({
        deploymentEnvironments: [
          deploymentEnvironment({
            createdAt: '2026-06-22T00:00:00Z',
            id: 'env-open',
            name: 'open',
          }),
          deploymentEnvironment({
            agentDeployEnabled: false,
            id: 'env-disabled',
            name: 'disabled',
          }),
          deploymentEnvironment({
            allowedDeployProfileIdsJson: '["profile-other"]',
            id: 'env-profile-denied',
            name: 'profile-denied',
          }),
          deploymentEnvironment({
            allowedDeployProfileIdsJson: '["profile-allowed"]',
            id: 'env-profile-allowed',
            name: 'profile-allowed',
          }),
          deploymentEnvironment({ id: 'env-inactive', name: 'inactive', status: 'deleted' }),
        ],
        tasks: [{ id: 'task-1', agentProfileHint: 'profile-allowed' }],
      })
    );

    const response = await handleListDeploymentEnvironments('req-1', {}, tokenData(), env());
    const payload = parseToolPayload(response);

    expect(response.error).toBeUndefined();
    expect(payload.environments).toEqual([
      expect.objectContaining({ id: 'env-open', name: 'open' }),
      expect.objectContaining({
        access: expect.objectContaining({
          allowedProfileRestricted: true,
          taskAgentProfileId: 'profile-allowed',
        }),
        id: 'env-profile-allowed',
        name: 'profile-allowed',
      }),
    ]);
  });

  it('reads logs from an accessible deployment node with supported filters', async () => {
    installDb(
      createDbState({
        deploymentEnvironments: [
          deploymentEnvironment({ id: 'env-logs', name: 'staging', nodeId: 'node-1' }),
        ],
        nodes: [{ id: 'node-1', status: 'running', userId: 'user-1' }],
      })
    );
    mockGetNodeLogsFromNode.mockResolvedValue({
      entries: [{ level: 'info', message: 'ready', source: 'docker:web-1' }],
      hasMore: false,
      nextCursor: null,
    });

    const response = await handleReadDeploymentLogs(
      'req-1',
      { container: 'web-1', environment: ' staging ', limit: 80, source: 'docker' },
      tokenData(),
      env()
    );
    const payload = parseToolPayload(response);

    expect(response.error).toBeUndefined();
    expect(mockGetNodeLogsFromNode).toHaveBeenCalledWith(
      'node-1',
      expect.anything(),
      'user-1',
      'source=docker&container=web-1&limit=80'
    );
    expect(payload).toMatchObject({
      logs: {
        entries: [expect.objectContaining({ message: 'ready', source: 'docker:web-1' })],
        hasMore: false,
      },
      nodeId: 'node-1',
    });
  });

  it('denies log access before contacting a deployment node when agent policy blocks access', async () => {
    installDb(
      createDbState({
        deploymentEnvironments: [
          deploymentEnvironment({
            agentDeployEnabled: false,
            id: 'env-denied',
            name: 'staging',
            nodeId: 'node-1',
          }),
        ],
        nodes: [{ id: 'node-1', status: 'running', userId: 'user-1' }],
      })
    );

    const response = await handleReadDeploymentLogs(
      'req-1',
      { environment: 'staging', source: 'docker' },
      tokenData(),
      env()
    );

    expect(response.error?.message).toContain('Agent deployment is disabled');
    expect(mockGetNodeLogsFromNode).not.toHaveBeenCalled();
  });

  it('previews public URLs and internal mode host routes for submitted compose', async () => {
    installDb(
      createDbState({
        deploymentEnvironments: [deploymentEnvironment({ id: 'env-preview', name: 'staging' })],
      })
    );

    const response = await handlePreviewDeploymentRoutes(
      'req-1',
      {
        environment: 'staging',
        composeYaml: `services:
  api:
    image: example/api
    ports:
      - mode: ingress
        target: 8000
        published: "8000"
        protocol: tcp
  db:
    image: postgres
    ports:
      - mode: host
        target: 5432
        published: "5432"
        protocol: tcp
  redis:
    image: redis
    ports:
      - mode: host
        target: 6379
        published: "6379"
        protocol: tcp
`,
      },
      tokenData(),
      env({ DEPLOYMENT_ROUTE_PORT_BASE: '36000', DEPLOYMENT_ROUTE_PORT_SPAN: '10' })
    );
    const payload = parseToolPayload(response);

    expect(response.error).toBeUndefined();
    expect(payload.routes).toMatchObject({
      publicRoutes: [
        expect.objectContaining({
          hostname: 'r1-api-8000-env-preview.apps.sammy.party',
          service: 'api',
          containerPort: 8000,
          url: 'https://r1-api-8000-env-preview.apps.sammy.party',
        }),
      ],
      internalRoutes: [
        { service: 'db', containerPort: 5432, mode: 'private' },
        { service: 'redis', containerPort: 6379, mode: 'private' },
      ],
    });
  });

  it('lists latest release routes without returning the stored compose manifest', async () => {
    const composeManifest = {
      reference: 'v1',
      composeYaml: `services:
  frontend:
    image: example/frontend
    ports:
      - mode: ingress
        target: 3000
        published: "3000"
        protocol: tcp
  db:
    image: postgres
    ports:
      - mode: host
        target: 5432
        published: "5432"
        protocol: tcp
`,
    };
    installDb(
      createDbState({
        deploymentCustomDomains: [
          {
            createdAt: '2026-06-26T01:00:00Z',
            environmentId: 'env-routes',
            hostname: 'app.example.com',
            id: 'domain-verified',
            port: 3000,
            routeIndex: 0,
            service: 'frontend',
            verificationError: null,
            verificationStatus: 'verified',
            verifiedAt: '2026-06-26T01:05:00Z',
            verifiedCnameTarget: 'r1-frontend-3000-env-routes.apps.sammy.party',
            desiredState: 'active',
            routingStatus: 'active',
            activationRoutingRevision: 1,
            deactivationRoutingRevision: null,
            deletedAt: null,
          },
          {
            createdAt: '2026-06-26T01:10:00Z',
            environmentId: 'env-routes',
            hostname: 'pending.example.com',
            id: 'domain-pending',
            port: 3000,
            routeIndex: 0,
            service: 'frontend',
            verificationError: null,
            verificationStatus: 'pending',
            verifiedAt: null,
            verifiedCnameTarget: null,
            desiredState: 'active',
            routingStatus: 'pending_dns',
            activationRoutingRevision: null,
            deactivationRoutingRevision: null,
            deletedAt: null,
          },
          {
            createdAt: '2026-06-26T01:20:00Z',
            environmentId: 'env-routes',
            hostname: 'old.example.com',
            id: 'domain-stale',
            port: 8080,
            routeIndex: 1,
            service: 'old-api',
            verificationError: null,
            verificationStatus: 'verified',
            verifiedAt: '2026-06-26T01:25:00Z',
            verifiedCnameTarget: 'r2-old-api-8080-env-routes.apps.sammy.party',
            desiredState: 'active',
            routingStatus: 'route_missing',
            activationRoutingRevision: 1,
            deactivationRoutingRevision: null,
            deletedAt: null,
          },
        ],
        deploymentEnvironments: [deploymentEnvironment({ id: 'env-routes', name: 'staging' })],
        deploymentReleases: [
          {
            createdAt: '2026-06-25T00:00:00Z',
            environmentId: 'env-routes',
            id: 'release-old',
            manifest: JSON.stringify({ ...composeManifest, composeYaml: 'services: {}' }),
            source: 'compose-publish',
            status: 'created',
            version: 1,
          },
          {
            createdAt: '2026-06-26T00:00:00Z',
            environmentId: 'env-routes',
            id: 'release-new',
            manifest: JSON.stringify(composeManifest),
            source: 'compose-publish',
            status: 'applied',
            version: 2,
          },
        ],
      })
    );

    const response = await handleListDeploymentRoutes(
      'req-1',
      { environment: 'staging' },
      tokenData(),
      env()
    );
    const payload = parseToolPayload(response);

    expect(response.error).toBeUndefined();
    expect(payload.latestRelease).toEqual({
      createdAt: '2026-06-26T00:00:00Z',
      id: 'release-new',
      source: 'compose-publish',
      status: 'applied',
      version: 2,
    });
    const routes = payload.routes as {
      publicRoutes: Array<{ customDomains: unknown[] }>;
      customDomains: unknown[];
    };

    expect(routes).toMatchObject({
      publicRoutes: [
        expect.objectContaining({
          hostname: 'r1-frontend-3000-env-routes.apps.sammy.party',
          service: 'frontend',
          containerPort: 3000,
        }),
      ],
      internalRoutes: [{ service: 'db', containerPort: 5432, mode: 'private' }],
    });
    expect(routes.publicRoutes[0]?.customDomains).toEqual([
      expect.objectContaining({
        cnameTarget: 'r1-frontend-3000-env-routes.apps.sammy.party',
        containerPort: 3000,
        hostname: 'app.example.com',
        id: 'domain-verified',
        routeAvailable: true,
        service: 'frontend',
        url: 'https://app.example.com',
        verificationStatus: 'verified',
        willBeIncludedInRouteConfig: true,
      }),
      expect.objectContaining({
        cnameTarget: 'r1-frontend-3000-env-routes.apps.sammy.party',
        containerPort: 3000,
        hostname: 'pending.example.com',
        id: 'domain-pending',
        routeAvailable: true,
        service: 'frontend',
        url: 'https://pending.example.com',
        verificationStatus: 'pending',
        willBeIncludedInRouteConfig: false,
      }),
    ]);
    expect(routes.customDomains).toEqual([
      expect.objectContaining({
        cnameTarget: 'r1-frontend-3000-env-routes.apps.sammy.party',
        hostname: 'app.example.com',
        routeAvailable: true,
        url: 'https://app.example.com',
        verificationStatus: 'verified',
        willBeIncludedInRouteConfig: true,
      }),
      expect.objectContaining({
        cnameTarget: 'r1-frontend-3000-env-routes.apps.sammy.party',
        hostname: 'pending.example.com',
        routeAvailable: true,
        verificationStatus: 'pending',
        willBeIncludedInRouteConfig: false,
      }),
      expect.objectContaining({
        cnameTarget: null,
        hostname: 'old.example.com',
        routeAvailable: false,
        service: 'old-api',
        verificationStatus: 'verified',
        willBeIncludedInRouteConfig: false,
      }),
    ]);
    expect(JSON.stringify(payload)).not.toContain('composeYaml');
  });

  it('sets variables and secrets and never returns decrypted secret values', async () => {
    const state = createDbState({
      deploymentEnvironments: [deploymentEnvironment({ id: 'env-config', name: 'staging' })],
    });
    installDb(state);
    const secretValue = 'postgres://user:super-secret-password@db/app';

    const variableResponse = await handleSetDeploymentEnvironmentConfig(
      'req-1',
      {
        environment: 'staging',
        isSecret: false,
        key: 'PUBLIC_APP_DOMAIN',
        value: 'staging.example.com',
      },
      tokenData(),
      env()
    );
    expect(variableResponse.error).toBeUndefined();

    const secretResponse = await handleSetDeploymentEnvironmentConfig(
      'req-2',
      {
        environment: 'staging',
        isSecret: true,
        key: 'DATABASE_URL',
        value: secretValue,
      },
      tokenData(),
      env()
    );
    expect(secretResponse.error).toBeUndefined();
    expect(JSON.stringify(secretResponse)).not.toContain('super-secret-password');

    const secretRow = state.deploymentEnvironmentConfigVars.find(
      (row) => row.envKey === 'DATABASE_URL'
    );
    expect(secretRow).toMatchObject({ isSecret: true });
    expect(secretRow?.storedValue).not.toBe(secretValue);
    expect(secretRow?.valueIv).toEqual(expect.any(String));

    const listResponse = await handleListDeploymentEnvironmentConfig(
      'req-3',
      { environment: 'staging' },
      tokenData(),
      env()
    );
    const payload = parseToolPayload(listResponse);

    expect(JSON.stringify(payload)).not.toContain('super-secret-password');
    expect(payload.config).toMatchObject({
      secretCount: 1,
      variableCount: 1,
      envVars: expect.arrayContaining([
        expect.objectContaining({
          isSecret: false,
          key: 'PUBLIC_APP_DOMAIN',
          value: 'staging.example.com',
        }),
        expect.objectContaining({
          hasValue: true,
          isSecret: true,
          key: 'DATABASE_URL',
          value: null,
        }),
      ]),
    });
  });
});
