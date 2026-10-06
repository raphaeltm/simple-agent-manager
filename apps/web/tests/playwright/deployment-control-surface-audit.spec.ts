import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, seedTheme } from './audit-helpers';

const PROJECT_ID = 'proj-deploy-audit';
const ENV_ID = 'env-staging';
const ENV_FAIL_ID = 'env-production-us-east-very-long-name';
const ENV_ORPHAN_VOLUME_ID = 'env-orphan-volume';
const ENV_STOPPED_ID = 'env-stopped';
const NODE_ID = 'node-deploy-audit';
const NODE_STALE_ID = 'node-deploy-stale';

const MOCK_USER = makeMockUser({
  email: 'deploy-audit@example.com',
  name: 'Deploy Audit User',
  role: 'superadmin',
  sessionId: 'session-deploy-audit',
  userId: 'user-deploy-audit',
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Deploy Audit Project',
  repository: 'sam/deploy-audit',
  defaultBranch: 'main',
  userId: 'user-deploy-audit',
  githubInstallationId: 'inst-deploy-audit',
  defaultVmSize: 'medium',
  defaultAgentType: 'openai-codex',
  defaultProvider: 'hetzner',
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-06-18T08:00:00.000Z',
  updatedAt: '2026-06-18T10:15:00.000Z',
};

const LONG_PROFILE_NAME =
  'Deployment-Builder-Extended-Production-Release-Candidate-Profile-With-Very-Long-Name';

const MOCK_PROFILES = [
  {
    id: 'profile-deploy',
    projectId: PROJECT_ID,
    name: LONG_PROFILE_NAME,
    description: 'Builds and submits app releases',
    agentType: 'openai-codex',
    defaultModel: null,
    permissionMode: 'workspace-write',
    vmSize: 'medium',
    provider: 'hetzner',
    workspaceProfile: 'full',
    isDefault: false,
    createdAt: '2026-06-18T08:05:00.000Z',
    updatedAt: '2026-06-18T08:05:00.000Z',
  },
  {
    id: 'profile-review',
    projectId: PROJECT_ID,
    name: 'Review Only',
    description: 'Inspects release state',
    agentType: 'claude-code',
    defaultModel: null,
    permissionMode: 'read-only',
    vmSize: 'small',
    provider: 'hetzner',
    workspaceProfile: 'lightweight',
    isDefault: false,
    createdAt: '2026-06-18T08:05:00.000Z',
    updatedAt: '2026-06-18T08:05:00.000Z',
  },
];

const MOCK_NODE = {
  id: NODE_ID,
  name: 'deploy-staging-01',
  status: 'running',
  healthStatus: 'healthy',
  nodeRole: 'deployment',
  vmSize: 'medium',
  vmLocation: 'nbg1',
  ipAddress: '10.0.0.82',
  cloudProvider: 'hetzner',
  heartbeatStaleAfterSeconds: 180,
  lastHeartbeatAt: '2026-06-18T10:14:00.000Z',
  errorMessage: null,
  createdAt: '2026-06-18T08:30:00.000Z',
  updatedAt: '2026-06-18T10:14:00.000Z',
  lastMetrics: {
    cpuLoadAvg1: 0.42,
    memoryPercent: 46,
    diskPercent: 31,
  },
  deploymentEnvironments: [
    { id: ENV_ID, projectId: PROJECT_ID, name: 'staging' },
    { id: 'env-preview', projectId: PROJECT_ID, name: 'preview' },
  ],
};

const MOCK_NODE_STALE = {
  id: NODE_STALE_ID,
  name: 'deploy-production-us-east-node-with-a-really-long-hostname-identifier-012345',
  status: 'running',
  healthStatus: 'stale',
  nodeRole: 'deployment',
  vmSize: 'large',
  vmLocation: 'ash',
  ipAddress: '192.168.100.55',
  cloudProvider: 'hetzner',
  heartbeatStaleAfterSeconds: 180,
  lastHeartbeatAt: '2026-06-17T02:00:00.000Z',
  errorMessage: 'Heartbeat timeout exceeded 3600s',
  createdAt: '2026-06-16T12:00:00.000Z',
  updatedAt: '2026-06-17T02:00:00.000Z',
  lastMetrics: {
    cpuLoadAvg1: undefined,
    memoryPercent: undefined,
    diskPercent: undefined,
  },
  deploymentEnvironments: [
    {
      id: ENV_FAIL_ID,
      projectId: PROJECT_ID,
      name: 'production-us-east-very-long-environment-name-that-should-truncate-properly',
    },
  ],
};

const MOCK_ENV = {
  id: ENV_ID,
  projectId: PROJECT_ID,
  name: 'staging',
  status: 'active',
  nodeId: NODE_ID,
  provider: 'hetzner',
  location: 'nbg1',
  createdAt: '2026-06-18T08:20:00.000Z',
  updatedAt: '2026-06-18T10:13:00.000Z',
  secretsUpdatedAt: '2026-06-18T09:00:00.000Z',
  observedDeployment: {
    appliedSeq: 7,
    status: 'applied',
    errorMessage: null,
    services: { web: { image: 'registry.sam.local/deploy-audit:7' } },
    deployStatus: {
      appHealth: 'healthy',
      nodeHealth: 'healthy',
      providerManageability: 'managed',
      routeCertState: 'issued',
      diskPressure: 'normal',
      configDrift: 'none',
    },
    diskTelemetry: {
      rootDisk: { usedPercent: 31.2 },
    },
    observedAt: '2026-06-18T10:14:00.000Z',
  },
  agentPolicy: {
    agentDeployEnabled: true,
    agentDeployEnabledBy: 'user-deploy-audit',
    agentDeployEnabledAt: '2026-06-18T09:30:00.000Z',
    agentDeployDisabledAt: null,
    allowedDeployProfileIds: ['profile-deploy'],
  },
  latestRelease: {
    id: 'release-7',
    environmentId: ENV_ID,
    version: 7,
    status: 'applied',
    createdBy: `${LONG_PROFILE_NAME} / task-auto-deploy-release-7-with-extended-identifier`,
    createdAt: '2026-06-18T10:00:00.000Z',
  },
  routeHostnames: [
    'staging.deploy-audit.sammy.party',
    'staging-alt.deploy-audit-with-very-long-subdomain-identifier.sammy.party',
  ],
  node: MOCK_NODE,
};

const MOCK_ENV_PREVIEW = {
  ...MOCK_ENV,
  id: 'env-preview',
  name: 'preview',
  routeHostnames: ['preview.deploy-audit.sammy.party'],
  latestRelease: {
    ...MOCK_ENV.latestRelease,
    id: 'release-preview-2',
    environmentId: 'env-preview',
    version: 2,
  },
};

const MOCK_ENV_FAILING = {
  id: ENV_FAIL_ID,
  projectId: PROJECT_ID,
  name: 'production-us-east-very-long-environment-name-that-should-truncate-properly',
  status: 'active',
  nodeId: NODE_STALE_ID,
  provider: 'hetzner',
  location: 'ash',
  createdAt: '2026-06-16T12:00:00.000Z',
  updatedAt: '2026-06-17T02:00:00.000Z',
  secretsUpdatedAt: '2026-06-16T14:00:00.000Z',
  observedDeployment: {
    appliedSeq: 3,
    status: 'error',
    errorMessage:
      'compose pull failed: image registry.sam.local/deploy-audit:3 not found in registry — verify the image was pushed before submitting the release',
    services: null,
    deployStatus: {
      appHealth: 'unhealthy',
      nodeHealth: 'stale',
      providerManageability: 'unmanageable',
      routeCertState: 'pending',
      diskPressure: 'high',
      configDrift: 'drifted',
    },
    diskTelemetry: {
      rootDisk: { usedPercent: NaN },
    },
    observedAt: '2026-06-17T02:00:00.000Z',
  },
  agentPolicy: {
    agentDeployEnabled: true,
    agentDeployEnabledBy: 'user-deploy-audit',
    agentDeployEnabledAt: '2026-06-16T13:00:00.000Z',
    agentDeployDisabledAt: null,
    allowedDeployProfileIds: [],
  },
  latestRelease: {
    id: 'release-3',
    environmentId: ENV_FAIL_ID,
    version: 3,
    status: 'failed',
    createdBy: 'task-release-3',
    createdAt: '2026-06-17T01:50:00.000Z',
  },
  routeHostnames: [
    'production-us-east.deploy-audit-with-a-very-long-hostname.sammy.party',
    'api.deploy-audit-with-a-very-long-hostname.sammy.party',
    'cdn.deploy-audit-with-a-very-long-hostname.sammy.party',
  ],
  node: MOCK_NODE_STALE,
};

const MOCK_ENV_ORPHAN_VOLUME = {
  id: ENV_ORPHAN_VOLUME_ID,
  projectId: PROJECT_ID,
  name: 'orphan-volume-cleanup',
  status: 'error',
  nodeId: null,
  provider: 'hetzner',
  location: 'nbg1',
  createdAt: '2026-06-18T08:20:00.000Z',
  updatedAt: '2026-06-18T10:13:00.000Z',
  secretsUpdatedAt: '2026-06-18T09:00:00.000Z',
  observedDeployment: {
    appliedSeq: null,
    status: 'failed',
    errorMessage: 'Volume is still attached to a stale provider server after node cleanup failed',
    services: null,
    deployStatus: null,
    diskTelemetry: null,
    observedAt: '2026-06-18T10:13:00.000Z',
  },
  agentPolicy: {
    agentDeployEnabled: false,
    agentDeployEnabledBy: null,
    agentDeployEnabledAt: null,
    agentDeployDisabledAt: null,
    allowedDeployProfileIds: [],
  },
  latestRelease: {
    id: 'release-orphan-volume',
    environmentId: ENV_ORPHAN_VOLUME_ID,
    version: 4,
    status: 'failed',
    createdBy: 'task-release-orphan-volume',
    createdAt: '2026-06-18T09:50:00.000Z',
  },
  routeHostnames: [],
  node: null,
};

const MOCK_ENV_STOPPED = {
  id: ENV_STOPPED_ID,
  projectId: PROJECT_ID,
  name: 'stopped-with-volumes',
  status: 'stopped',
  nodeId: null,
  provider: 'hetzner',
  location: 'nbg1',
  requiresVolumes: true,
  createdAt: '2026-06-18T08:20:00.000Z',
  updatedAt: '2026-06-18T11:00:00.000Z',
  secretsUpdatedAt: '2026-06-18T09:00:00.000Z',
  // toObservedDeploymentState always returns a non-null object (all-null fields
  // when the env has been stopped and the node detached). Mirror that shape so
  // the mock matches the real API contract.
  observedDeployment: {
    appliedSeq: null,
    status: null,
    errorMessage: null,
    services: null,
    deployStatus: null,
    diskTelemetry: null,
    observedAt: null,
  },
  agentPolicy: {
    agentDeployEnabled: true,
    agentDeployEnabledBy: 'user-deploy-audit',
    agentDeployEnabledAt: '2026-06-18T09:30:00.000Z',
    agentDeployDisabledAt: null,
    allowedDeployProfileIds: ['profile-deploy'],
  },
  latestRelease: {
    id: 'release-stopped',
    environmentId: ENV_STOPPED_ID,
    version: 7,
    status: 'applied',
    createdBy: 'task-release-stopped',
    createdAt: '2026-06-18T10:00:00.000Z',
  },
  routeHostnames: [],
  node: null,
};

const MOCK_LOGS = {
  entries: [
    {
      timestamp: '2026-06-18T10:13:30.000Z',
      level: 'info',
      source: 'agent',
      message: 'Pulled release image registry.sam.local/deploy-audit:7',
    },
    {
      timestamp: '2026-06-18T10:13:58.000Z',
      level: 'info',
      source: 'docker:deploy-audit-web-1',
      message: 'nginx access log: GET / 200',
    },
    {
      timestamp: '2026-06-18T10:13:55.000Z',
      level: 'info',
      source: 'docker:deploy-audit-worker-1',
      message: 'Route certificate is active for staging.deploy-audit.sammy.party',
    },
    {
      timestamp: '2026-06-18T10:12:00.000Z',
      level: 'error',
      source: 'agent',
      message:
        'ThisIsAnExtremelyLongLogMessageWithoutAnySpacesOrBreakPointsThatShouldNotCauseHorizontalOverflowInTheLogsPanel_ErrorCode_DEPLOY_COMPOSE_PULL_TIMEOUT_REGISTRY_UNREACHABLE_0xDEADBEEF',
    },
    {
      timestamp: '2026-06-18T10:11:00.000Z',
      level: 'warn',
      source: 'agent',
      message:
        'TLS ACME HTTP-01 challenge timed out for staging.deploy-audit.sammy.party — port 80 may be unreachable from the public internet',
    },
  ],
  nextCursor: null,
};

const MOCK_CONTAINERS = {
  containers: [
    {
      id: 'container-web',
      name: 'deploy-audit-web-1',
      image: 'nginx:alpine',
      state: 'running',
      status: 'Up 10 minutes',
    },
    {
      id: 'container-worker',
      name: 'deploy-audit-worker-1',
      image: 'worker:latest',
      state: 'running',
      status: 'Up 10 minutes',
    },
  ],
};

const MOCK_RUNTIME_CONFIG = {
  environmentId: ENV_ID,
  updatedAt: '2026-06-18T10:10:00.000Z',
  envVars: [
    {
      key: 'PUBLIC_APP_DOMAIN',
      value:
        'staging.deploy-audit-with-a-very-long-hostname-that-must-wrap-without-overflow.sammy.party',
      isSecret: false,
      updatedAt: '2026-06-18T10:01:00.000Z',
    },
    {
      key: 'DATABASE_URL',
      isSecret: true,
      updatedAt: '2026-06-18T10:02:00.000Z',
    },
  ],
};

const MOCK_PUBLIC_ROUTES = [
  {
    id: 'web:8080:0',
    service: 'web',
    port: 8080,
    hostname: 'r1-web-8080-env-staging.apps.sammy.party',
    hostPort: 36120,
    routeIndex: 0,
  },
  {
    id: 'api:3000:1',
    service: 'api',
    port: 3000,
    hostname: 'r2-api-3000-env-staging.apps.sammy.party',
    hostPort: 36121,
    routeIndex: 1,
  },
  {
    id: 'docs:5173:2',
    service: 'docs-with-a-very-long-service-name-that-wraps',
    port: 5173,
    hostname: 'r3-docs-with-a-very-long-service-name-that-wraps-5173-env-staging.apps.sammy.party',
    hostPort: 36122,
    routeIndex: 2,
  },
];

function customDomain(overrides: Record<string, unknown>) {
  return {
    id: 'domain-pending',
    environmentId: ENV_ID,
    service: 'web',
    port: 8080,
    routeIndex: 0,
    hostname: 'preview.customer.example.com',
    verificationStatus: 'pending',
    verificationError: null,
    verifiedAt: null,
    verifiedCnameTarget: null,
    desiredState: 'active',
    routingStatus: 'pending_dns',
    servingStatus: 'pending_dns',
    activationRoutingRevision: null,
    deactivationRoutingRevision: null,
    deletedAt: null,
    createdBy: 'user-deploy-audit',
    createdAt: '2026-06-18T10:10:00.000Z',
    cnameTarget: 'r1-web-8080-env-staging.apps.sammy.party',
    routeTargetChanged: false,
    environmentStatus: 'active',
    desiredRoutingRevision: 3,
    observedRoutingRevision: 2,
    observedRoutingStatus: 'active',
    observedRoutingError: null,
    ...overrides,
  };
}

const MOCK_CUSTOM_DOMAINS = [
  customDomain({
    id: 'domain-pending',
  }),
  customDomain({
    id: 'domain-long',
    hostname:
      'staging-for-a-very-large-enterprise-customer-with-an-overly-specific-subdomain.customer-portal.example-services.dev',
    verificationStatus: 'failed',
    verificationError:
      'staging-for-a-very-large-enterprise-customer-with-an-overly-specific-subdomain.customer-portal.example-services.dev does not resolve to r1-web-8080-env-staging.apps.sammy.party.',
    routingStatus: 'failed',
    servingStatus: 'dns_failed',
    createdAt: '2026-06-18T10:12:00.000Z',
  }),
  customDomain({
    id: 'domain-verified',
    service: 'api',
    port: 3000,
    routeIndex: 1,
    hostname: 'api.customer.example.com',
    verificationStatus: 'verified',
    verifiedAt: '2026-06-18T10:20:00.000Z',
    verifiedCnameTarget: 'r2-api-3000-env-staging.apps.sammy.party',
    routingStatus: 'active',
    servingStatus: 'active',
    activationRoutingRevision: 2,
    createdAt: '2026-06-18T10:15:00.000Z',
    cnameTarget: 'r2-api-3000-env-staging.apps.sammy.party',
  }),
  customDomain({
    id: 'domain-missing-route',
    service: 'legacy-worker',
    port: 7000,
    routeIndex: 4,
    hostname: 'old-worker.ops.customer.example.com',
    verificationStatus: 'verified',
    verificationError: 'The legacy-worker:7000 public route is not present in the current release.',
    verifiedAt: '2026-06-17T10:20:00.000Z',
    verifiedCnameTarget: 'legacy-worker-env-staging.apps.sammy.party',
    routingStatus: 'route_missing',
    servingStatus: 'route_missing',
    activationRoutingRevision: 1,
    createdAt: '2026-06-17T10:15:00.000Z',
    cnameTarget: null,
  }),
];

const MOCK_SYSTEM_INFO = {
  cpu: { numCpu: 4, model: 'AMD EPYC', loadAvg1: 0.42, loadAvg5: 0.38, loadAvg15: 0.31 },
  memory: {
    totalBytes: 8_000_000_000,
    usedBytes: 3_600_000_000,
    availableBytes: 4_400_000_000,
    usedPercent: 45,
  },
  disk: {
    totalBytes: 120_000_000_000,
    usedBytes: 37_000_000_000,
    availableBytes: 83_000_000_000,
    usedPercent: 31,
    mountPath: '/',
  },
  network: { interface: 'eth0', rxBytes: 1234, txBytes: 5678 },
  uptime: { seconds: 3600, humanFormat: '1h' },
  docker: {
    running: true,
    version: '26.1.0',
    containers: 2,
    containerList: [
      {
        id: 'container-web',
        name: 'deploy-audit-web-1',
        image: 'nginx:alpine',
        status: 'Up 10 minutes',
        state: 'running',
        cpuPercent: 1.7,
        memUsage: '3.5MiB / 256MiB',
        memPercent: 1.4,
        createdAt: '2026-06-18T10:00:00.000Z',
      },
      {
        id: 'container-worker',
        name: 'deploy-audit-worker-1',
        image: 'worker:latest',
        status: 'Up 10 minutes',
        state: 'running',
        cpuPercent: 0.4,
        memUsage: '12MiB / 256MiB',
        memPercent: 4.7,
        createdAt: '2026-06-18T10:00:00.000Z',
      },
    ],
  },
  software: { node: '22.16.0', docker: '26.1.0' },
  agent: { version: 'audit', status: 'running' },
};

async function respond(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setupMocks(
  page: Page,
  opts?: {
    includeFailingEnv?: boolean;
    includeOrphanVolumeEnv?: boolean;
    includeStoppedEnv?: boolean;
  }
) {
  const includeFailingEnv = opts?.includeFailingEnv ?? true;
  const includeOrphanVolumeEnv = opts?.includeOrphanVolumeEnv ?? false;
  const includeStoppedEnv = opts?.includeStoppedEnv ?? false;

  await seedTheme(page, 'dark');
  await page.addInitScript(() => {
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-deploy-audit', 'true');
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === '/api/auth/get-session') return respond(route, 200, MOCK_USER);
    if (path === '/api/github/installations') return respond(route, 200, []);
    if (path === '/api/projects')
      return respond(route, 200, { projects: [MOCK_PROJECT], total: 1 });
    if (path === '/api/agents') return respond(route, 200, { agents: [] });
    if (path === '/api/credentials') return respond(route, 200, []);
    if (path === '/api/credentials/agent') return respond(route, 200, { credentials: [] });
    if (path === '/api/notifications') {
      return respond(route, 200, { notifications: [], unreadCount: 0, nextCursor: null });
    }
    if (path === '/api/trial/status') return respond(route, 200, { available: false });
    if (path === '/api/providers/catalog') return respond(route, 200, { catalogs: [] });

    if (path === `/api/projects/${PROJECT_ID}` && method === 'GET') {
      return respond(route, 200, MOCK_PROJECT);
    }
    if (path === `/api/projects/${PROJECT_ID}/agent-profiles`) {
      return respond(route, 200, { items: MOCK_PROFILES });
    }
    if (path === `/api/projects/${PROJECT_ID}/environments` && method === 'GET') {
      const envs = includeFailingEnv
        ? [MOCK_ENV, MOCK_ENV_PREVIEW, MOCK_ENV_FAILING]
        : [MOCK_ENV, MOCK_ENV_PREVIEW];
      if (includeOrphanVolumeEnv) {
        envs.push(MOCK_ENV_ORPHAN_VOLUME);
      }
      if (includeStoppedEnv) {
        envs.push(MOCK_ENV_STOPPED);
      }
      return respond(route, 200, { environments: envs });
    }

    // Stop lifecycle: tears down the stack and detaches volumes (data
    // preserved). staging shares NODE_ID with preview, so the node is kept.
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_ID}/stop` &&
      method === 'POST'
    ) {
      return respond(route, 200, {
        environment: { ...MOCK_ENV, status: 'stopped', nodeId: null, node: null },
        lifecycle: {
          stopped: true,
          alreadyStopped: false,
          nodeId: NODE_ID,
          nodeDeleted: false,
          volumesDetached: 2,
          warnings: [],
        },
      });
    }

    // Start lifecycle: re-provisions a node, reattaches volumes, and lets the
    // heartbeat reapply the latest release.
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_STOPPED_ID}/start` &&
      method === 'POST'
    ) {
      return respond(route, 200, {
        environment: { ...MOCK_ENV_STOPPED, status: 'starting' },
        lifecycle: {
          started: true,
          alreadyActive: false,
          nodeId: NODE_ID,
          provisioningStarted: true,
          volumesAttachScheduled: true,
          latestReleaseVersion: 7,
        },
      });
    }
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_STOPPED_ID}/runtime-config` &&
      method === 'GET'
    ) {
      return respond(route, 200, {
        environmentId: ENV_STOPPED_ID,
        updatedAt: null,
        envVars: [],
      });
    }
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_STOPPED_ID}/public-routes` &&
      method === 'GET'
    ) {
      return respond(route, 200, { publicRoutes: [] });
    }
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_STOPPED_ID}/custom-domains` &&
      method === 'GET'
    ) {
      return respond(route, 200, { customDomains: [] });
    }
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_ID}/runtime-config` &&
      method === 'GET'
    ) {
      return respond(route, 200, MOCK_RUNTIME_CONFIG);
    }
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_ID}/public-routes` &&
      method === 'GET'
    ) {
      return respond(route, 200, { publicRoutes: MOCK_PUBLIC_ROUTES });
    }
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_ID}/custom-domains` &&
      method === 'GET'
    ) {
      return respond(route, 200, { customDomains: MOCK_CUSTOM_DOMAINS });
    }
    if (
      path ===
        `/api/projects/${PROJECT_ID}/environments/${ENV_ID}/custom-domains/domain-pending/verify` &&
      method === 'POST'
    ) {
      return respond(route, 200, {
        ...MOCK_CUSTOM_DOMAINS[0],
        verificationStatus: 'verified',
        verifiedAt: '2026-06-18T10:30:00.000Z',
      });
    }
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_FAIL_ID}/runtime-config` &&
      method === 'GET'
    ) {
      return respond(route, 200, { environmentId: ENV_FAIL_ID, updatedAt: null, envVars: [] });
    }
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_FAIL_ID}/public-routes` &&
      method === 'GET'
    ) {
      return respond(route, 200, { publicRoutes: [] });
    }
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_FAIL_ID}/custom-domains` &&
      method === 'GET'
    ) {
      return respond(route, 200, { customDomains: [] });
    }
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_ORPHAN_VOLUME_ID}/runtime-config` &&
      method === 'GET'
    ) {
      return respond(route, 200, {
        environmentId: ENV_ORPHAN_VOLUME_ID,
        updatedAt: null,
        envVars: [],
      });
    }
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_ORPHAN_VOLUME_ID}/public-routes` &&
      method === 'GET'
    ) {
      return respond(route, 200, { publicRoutes: [] });
    }
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_ORPHAN_VOLUME_ID}/custom-domains` &&
      method === 'GET'
    ) {
      return respond(route, 200, { customDomains: [] });
    }
    if (path === `/api/projects/${PROJECT_ID}/environments/${ENV_ID}/logs`) {
      return respond(route, 200, { ...MOCK_LOGS, source: 'node', nodeId: NODE_ID });
    }
    if (path === `/api/projects/${PROJECT_ID}/environments/${ENV_ID}/containers`) {
      return respond(route, 200, { ...MOCK_CONTAINERS, nodeId: NODE_ID });
    }
    if (path === `/api/projects/${PROJECT_ID}/environments/${ENV_ID}/metrics`) {
      return respond(route, 200, {
        systemInfo: MOCK_SYSTEM_INFO,
        nodeId: NODE_ID,
        fallbackMetrics: MOCK_NODE.lastMetrics,
      });
    }
    if (path === `/api/projects/${PROJECT_ID}/environments/${ENV_FAIL_ID}/logs`) {
      return respond(route, 200, {
        entries: [],
        nextCursor: null,
        unavailableReason: 'node_stale',
      });
    }
    if (path === `/api/projects/${PROJECT_ID}/environments/${ENV_FAIL_ID}/containers`) {
      return respond(route, 200, {
        containers: [],
        nodeId: NODE_STALE_ID,
        unavailableReason: 'node_stale',
      });
    }
    if (path === `/api/projects/${PROJECT_ID}/environments/${ENV_FAIL_ID}/metrics`) {
      return respond(route, 200, {
        systemInfo: null,
        nodeId: NODE_STALE_ID,
        fallbackMetrics: MOCK_NODE_STALE.lastMetrics,
        unavailableReason: 'node_agent_unreachable',
      });
    }

    const allNodes = includeFailingEnv ? [MOCK_NODE, MOCK_NODE_STALE] : [MOCK_NODE];
    if (path === '/api/nodes') return respond(route, 200, allNodes);
    if (path === `/api/nodes/${NODE_ID}`) return respond(route, 200, MOCK_NODE);
    if (path === `/api/nodes/${NODE_STALE_ID}`) return respond(route, 200, MOCK_NODE_STALE);
    if (path === `/api/nodes/${NODE_ID}/system-info`) return respond(route, 200, MOCK_SYSTEM_INFO);
    if (path === `/api/nodes/${NODE_STALE_ID}/system-info`)
      return respond(route, 500, { error: 'Node unreachable' });
    if (path === `/api/nodes/${NODE_ID}/events`)
      return respond(route, 200, { events: [], nextCursor: null });
    if (path === `/api/nodes/${NODE_STALE_ID}/events`)
      return respond(route, 200, { events: [], nextCursor: null });
    if (path === `/api/nodes/${NODE_ID}/logs`) return respond(route, 200, MOCK_LOGS);
    if (path === `/api/nodes/${NODE_ID}/containers`) return respond(route, 200, MOCK_CONTAINERS);
    if (path === `/api/nodes/${NODE_STALE_ID}/logs`)
      return respond(route, 200, { entries: [], nextCursor: null });
    if (path === `/api/nodes/${NODE_STALE_ID}/containers`)
      return respond(route, 200, { containers: [] });
    if (path === '/api/workspaces') return respond(route, 200, []);

    return respond(route, 200, {});
  });
}

// Summary cards on the list page are <Link> anchors, not <article>.
function environmentCard(page: Page, name: string) {
  return page
    .getByRole('link')
    .filter({ has: page.getByRole('heading', { name, exact: true }) })
    .first();
}

// The failing env name is long and truncated; match on a stable substring.
function failingEnvironmentCard(page: Page) {
  return page.getByRole('link').filter({ hasText: 'production-us-east' }).first();
}

function tab(page: Page, name: string) {
  return page.getByRole('button', { name, exact: true });
}

test.describe('Deployment control surface audit — list page', () => {
  test('list page renders compact summary cards with status and release', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments`);

    await expect(page.getByRole('heading', { name: 'Deployments' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'staging', exact: true })).toBeVisible();

    const stagingCard = environmentCard(page, 'staging');
    await expect(stagingCard).toBeVisible();

    // Compact summary: service-state label + release summary "v7 · applied"
    await expect(stagingCard.getByText('Serving', { exact: true })).toBeVisible();
    await expect(stagingCard.getByText('v7 · applied')).toBeVisible();
    // Route count + node name
    await expect(stagingCard.getByText('2 routes')).toBeVisible();
    await expect(stagingCard.getByText('deploy-staging-01')).toBeVisible();

    // No Logs/Destroy/Metrics controls leak onto the card itself.
    await expect(stagingCard.getByRole('button')).toHaveCount(0);

    await screenshot(page, 'deployment-list-page');
    await assertNoOverflow(page);
  });

  test('list page surfaces failing environment summary', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments`);

    const failingCard = failingEnvironmentCard(page);
    await expect(failingCard).toBeVisible();
    await expect(failingCard.getByText('v3 · failed')).toBeVisible();
    // Stale node health badge on the card (StatusBadge capitalizes the label)
    await expect(failingCard.getByText('Stale', { exact: true })).toBeVisible();

    await screenshot(page, 'deployment-list-failing');
    await assertNoOverflow(page);
  });

  test('clicking a summary card navigates to the environment detail page', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments`);

    await environmentCard(page, 'staging').click();

    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/deployments/${ENV_ID}$`));
    await expect(page.getByRole('heading', { name: 'staging', level: 1 })).toBeVisible();
    // Tabbed navigation present
    await expect(page.getByRole('navigation', { name: 'Environment sections' })).toBeVisible();
  });
});

test.describe('Deployment control surface audit — detail page', () => {
  test('overview tab shows operational summary, status dimensions and routes', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}`);

    // Header: name, back link, release attribution, destroy
    await expect(page.getByRole('heading', { name: 'staging', level: 1 })).toBeVisible();
    // Scope to <main> — the AppShell sidebar (<aside>) also has a "Deployments" link.
    await expect(page.getByRole('main').getByRole('link', { name: 'Deployments' })).toBeVisible();
    await expect(page.getByText(/submitted by/).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Destroy Env' })).toBeVisible();

    // Operational summary
    await expect(page.getByText('Serving', { exact: true })).toBeVisible();
    await expect(page.getByText('Release v7', { exact: true })).toBeVisible();
    await expect(page.getByText('applied', { exact: true }).first()).toBeVisible();

    // Public routes (including long one) rendered as external links
    await expect(page.getByText('staging.deploy-audit.sammy.party')).toBeVisible();

    await screenshot(page, 'deployment-detail-overview');
    await assertNoOverflow(page);
  });

  test('overview NaN guard renders dash for failing env disk telemetry', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_FAIL_ID}`);

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    // Blocker line
    await expect(page.getByText(/compose pull failed/)).toBeVisible();

    // Root Disk shows '-' not 'NaN%'
    const nanCount = await page.locator('text=NaN').count();
    expect(nanCount).toBe(0);

    await screenshot(page, 'deployment-detail-overview-failing');
    await assertNoOverflow(page);
  });

  test('error environment without a node exposes stop cleanup instead of start', async ({
    page,
  }) => {
    await setupMocks(page, { includeOrphanVolumeEnv: true });
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ORPHAN_VOLUME_ID}`);

    await expect(page.getByRole('heading', { name: 'orphan-volume-cleanup' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByText('Stop deployment environment?')).toBeVisible();
    await expect(page.getByText('No deployment node is currently attached')).toBeVisible();

    await screenshot(page, 'deployment-detail-error-no-node-stop');
    await assertNoOverflow(page);
  });

  test('confirming stop posts to the stop endpoint and reports cleanup summary', async ({
    page,
  }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}`);

    await expect(page.getByRole('heading', { name: 'staging', level: 1 })).toBeVisible();

    // Active env exposes Stop (destroys the unused node) and hides Start.
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start' })).toHaveCount(0);

    // Open the confirm dialog from the header Stop button.
    await page.getByRole('button', { name: 'Stop' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Stop deployment environment?')).toBeVisible();
    // staging shares its node with preview, so the node is kept on stop.
    await expect(
      dialog.getByText('Keeps the shared deployment node running for other environments')
    ).toBeVisible();

    // The dialog confirm button shares the "Stop" label with the header button,
    // so scope the click to the dialog. Assert the POST actually fires.
    const stopRequest = page.waitForRequest(
      (req) =>
        req.method() === 'POST' &&
        req.url().includes(`/api/projects/${PROJECT_ID}/environments/${ENV_ID}/stop`)
    );
    await dialog.getByRole('button', { name: 'Stop', exact: true }).click();
    await stopRequest;

    // Success toast summarises detached volumes (node kept for sibling env).
    await expect(
      page.getByText('Environment stopped: environment stopped, 2 volumes detached')
    ).toBeVisible();

    await screenshot(page, 'deployment-detail-stop-confirmed');
    await assertNoOverflow(page);
  });

  test('stopped environment exposes start which posts to the start endpoint', async ({ page }) => {
    await setupMocks(page, { includeStoppedEnv: true });
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_STOPPED_ID}`);

    await expect(page.getByRole('heading', { name: 'stopped-with-volumes', level: 1 })).toBeVisible();

    // Stopped env exposes Start and hides Stop.
    await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0);

    const startRequest = page.waitForRequest(
      (req) =>
        req.method() === 'POST' &&
        req.url().includes(`/api/projects/${PROJECT_ID}/environments/${ENV_STOPPED_ID}/start`)
    );
    await page.getByRole('button', { name: 'Start' }).click();
    await startRequest;

    await expect(page.getByText('Environment starting on a deployment node')).toBeVisible();

    await screenshot(page, 'deployment-detail-start-requested');
    await assertNoOverflow(page);
  });

  test('logs tab auto-loads entries and exposes filter controls', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}?tab=logs`);

    await expect(page.getByText('Pulled release image')).toBeVisible({ timeout: 10000 });

    await expect(page.locator('#log-source')).toBeVisible();
    await expect(page.locator('#log-level')).toBeVisible();
    await expect(page.getByPlaceholder('Search logs...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();

    await page.locator('#log-source').selectOption('app');
    await expect(page.locator('#log-container')).toBeVisible();
    await expect(page.locator('#log-container')).toContainText('deploy-audit-web-1');

    await screenshot(page, 'deployment-detail-logs');
    await assertNoOverflow(page);
  });

  test('logs tab on failing env shows unavailable reason for stale node', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_FAIL_ID}?tab=logs`);

    await expect(page.getByText(/not reported recently/)).toBeVisible({ timeout: 10000 });

    await screenshot(page, 'deployment-detail-logs-unavailable');
    await assertNoOverflow(page);
  });

  test('long log messages do not cause horizontal overflow', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}?tab=logs`);

    await expect(page.getByText('Pulled release image')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/DEPLOY_COMPOSE_PULL_TIMEOUT/)).toBeVisible();

    await assertNoOverflow(page);
    await screenshot(page, 'deployment-detail-logs-long-message');
  });

  test('configuration tab renders variables and secrets', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}?tab=config`);

    const panel = page.locator(`#deployment-config-${ENV_ID}`);
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Configuration')).toBeVisible();

    // Plaintext Variable shows its value; secret value stays hidden.
    await expect(panel.getByText('PUBLIC_APP_DOMAIN')).toBeVisible();
    await expect(panel.locator('span').filter({ hasText: /^Variable$/ })).toBeVisible();
    await expect(panel.getByText('DATABASE_URL')).toBeVisible();
    await expect(panel.locator('span').filter({ hasText: /^Secret$/ })).toBeVisible();
    await expect(panel.getByText('Hidden after save')).toBeVisible();

    await screenshot(page, 'deployment-detail-config');
    await assertNoOverflow(page);
  });

  test('domains tab renders route selector, DNS records and failure states', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}?tab=domains`);

    await expect(page.getByText('Public routes')).toBeVisible();
    await expect(page.getByRole('button', { name: /web:8080/ })).toBeVisible();
    await expect(page.getByText('preview.customer.example.com').first()).toBeVisible();
    await expect(page.getByText('DNS mismatch')).toBeVisible();
    await expect(page.getByText('Domains with missing routes')).toBeVisible();
    await expect(page.getByText('old-worker.ops.customer.example.com').first()).toBeVisible();
    await expect(page.getByText('Add pending domain')).toBeVisible();
    await expect(page.getByText('r1-web-8080-env-staging.apps.sammy.party').first()).toBeVisible();

    await screenshot(page, 'deployment-detail-domains');
    await assertNoOverflow(page);
  });

  test('domains tab shows no-route state', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_FAIL_ID}?tab=domains`);

    await expect(page.getByText('No public routes')).toBeVisible();
    await expect(page.getByText('Submit a release with a public route')).toBeVisible();

    await screenshot(page, 'deployment-detail-domains-empty');
    await assertNoOverflow(page);
  });

  test('policy tab renders agent policy controls', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}?tab=policy`);

    await expect(page.getByText('Agent Policy', { exact: true })).toBeVisible();

    await screenshot(page, 'deployment-detail-policy');
    await assertNoOverflow(page);
  });

  test('node & metrics tab renders deployment node info', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}?tab=node`);

    await expect(page.getByText('Deployment Node', { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'deploy-staging-01' })).toBeVisible();

    await screenshot(page, 'deployment-detail-node');
    await assertNoOverflow(page);
  });

  test('destroy dialog shows deployment-specific consequences', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}`);

    await page.getByRole('button', { name: 'Destroy Env' }).click();

    await expect(page.getByText('Destroy deployment environment?')).toBeVisible();
    await expect(page.getByText('Removes all app-route DNS records')).toBeVisible();
    await expect(page.getByText('Detaches and deletes attached deployment volumes')).toBeVisible();
    await expect(page.getByText(/Keeps the shared deployment node running/)).toBeVisible();
    await expect(page.getByText('This cannot be undone.')).toBeVisible();

    await screenshot(page, 'deployment-detail-destroy-dialog');
    await assertNoOverflow(page);
  });

  test('tabs are keyboard reachable and mark the active tab', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}`);

    await expect(tab(page, 'Overview')).toHaveAttribute('aria-current', 'page');
    await tab(page, 'Configuration').click();
    await expect(tab(page, 'Configuration')).toHaveAttribute('aria-current', 'page');
    await expect(page).toHaveURL(/tab=config/);
  });
});

test.describe('Deployment node pages', () => {
  test('nodes page distinguishes deployment nodes from workspace nodes', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/nodes');

    await expect(page.getByText('deploy-staging-01')).toBeVisible();
    await expect(page.getByText('Deployment', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Deployment environments (2)').first()).toBeVisible();
    await expect(page.getByText('preview').first()).toBeVisible();
    await expect(
      page.getByText('Managed from the project deployment environment.').first()
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Workspace' })).toHaveCount(0);

    // Stale deployment node
    await expect(page.getByText(/deploy-production-us-east/).first()).toBeVisible();

    await screenshot(page, 'deployment-node-list-card');
    await assertNoOverflow(page);
  });

  test('deployment node detail suppresses workspace creation and explains management surface', async ({
    page,
  }) => {
    await setupMocks(page);
    await page.goto(`/nodes/${NODE_ID}`);

    await expect(page.getByRole('heading', { name: 'Deployment node' })).toBeVisible();
    await expect(page.getByText(/Hosted environments: staging, preview/)).toBeVisible();
    await expect(page.getByText(/environment policy/)).toBeVisible();
    await expect(page.getByText(/use.*Destroy.*on the Deployments page/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Workspace' })).toHaveCount(0);
    // Deployment-aware delete button label
    await expect(page.getByRole('button', { name: 'Delete Node Only' })).toBeVisible();

    await screenshot(page, 'deployment-node-detail');
    await assertNoOverflow(page);
  });

  test('stale deployment node detail shows error and stale status', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/nodes/${NODE_STALE_ID}`);

    await expect(page.getByRole('heading', { name: 'Deployment node' })).toBeVisible();
    await expect(page.getByText('Heartbeat timeout exceeded')).toBeVisible();

    await screenshot(page, 'deployment-node-detail-stale');
    await assertNoOverflow(page);
  });
});

// ─── Mobile viewport tests ─────────────────────────────────────────────────

test.describe('Deployment control surface — mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('deployments list page — mobile', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments`);

    await expect(page.getByRole('heading', { name: 'Deployments' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'staging', exact: true })).toBeVisible();
    await expect(
      environmentCard(page, 'staging').getByText('Serving', { exact: true })
    ).toBeVisible();

    await screenshot(page, 'deployment-mobile-list');
    await assertNoOverflow(page);
  });

  test('environment detail overview — mobile', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}`);

    await expect(page.getByRole('heading', { name: 'staging', level: 1 })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Environment sections' })).toBeVisible();

    await screenshot(page, 'deployment-mobile-detail-overview');
    await assertNoOverflow(page);
  });

  test('failing environment detail — mobile, no overflow', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_FAIL_ID}`);

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await screenshot(page, 'deployment-mobile-failing');
    await assertNoOverflow(page);
  });

  test('error environment without a node exposes stop cleanup instead of start', async ({
    page,
  }) => {
    await setupMocks(page, { includeOrphanVolumeEnv: true });
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ORPHAN_VOLUME_ID}`);

    await expect(page.getByRole('heading', { name: 'orphan-volume-cleanup' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Stop' }).click();
    await expect(page.getByText('Stop deployment environment?')).toBeVisible();
    await expect(page.getByText('No deployment node is currently attached')).toBeVisible();

    await screenshot(page, 'deployment-mobile-error-no-node-stop');
    await assertNoOverflow(page);
  });

  test('destroy dialog on mobile — no overflow', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}`);

    await page.getByRole('button', { name: 'Destroy Env' }).click();
    await expect(page.getByText('Destroy deployment environment?')).toBeVisible();

    await screenshot(page, 'deployment-mobile-destroy-dialog');
    await assertNoOverflow(page);
  });

  test('deployment node list on mobile — no overflow', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/nodes');

    await expect(page.getByText('deploy-staging-01')).toBeVisible();

    await screenshot(page, 'deployment-mobile-node-list');
    await assertNoOverflow(page);
  });

  test('logs panel with controls on mobile — no overflow', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}?tab=logs`);

    await expect(page.getByText('Pulled release image')).toBeVisible({ timeout: 10000 });

    await screenshot(page, 'deployment-mobile-logs');
    await assertNoOverflow(page);
  });

  test('configuration panel on mobile — no overflow', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}?tab=config`);

    const panel = page.locator(`#deployment-config-${ENV_ID}`);
    await expect(panel.getByText('PUBLIC_APP_DOMAIN')).toBeVisible();
    await expect(panel.getByText('Hidden after save')).toBeVisible();

    await screenshot(page, 'deployment-mobile-config-panel');
    await assertNoOverflow(page);
  });

  test('domains panel on mobile — no overflow', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}?tab=domains`);

    await expect(page.getByText('Public routes')).toBeVisible();
    await expect(page.getByText('preview.customer.example.com').first()).toBeVisible();
    await expect(page.getByText('DNS mismatch')).toBeVisible();

    await screenshot(page, 'deployment-mobile-domains');
    await assertNoOverflow(page);
  });
});
