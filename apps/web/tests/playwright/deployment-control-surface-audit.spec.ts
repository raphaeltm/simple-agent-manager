import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, seedTheme } from './audit-helpers';

const PROJECT_ID = 'proj-deploy-audit';
const ENV_ID = 'env-staging';
const NODE_ID = 'node-deploy-audit';

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

const MOCK_PROFILES = [
  {
    id: 'profile-deploy',
    projectId: PROJECT_ID,
    name: 'Deployment Builder',
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
    createdBy: 'task-release-7',
    createdAt: '2026-06-18T10:00:00.000Z',
  },
  routeHostnames: ['staging.deploy-audit.sammy.party'],
  node: MOCK_NODE,
};

const MOCK_LOGS = {
  entries: [
    {
      timestamp: '2026-06-18T10:13:30.000Z',
      level: 'info',
      source: 'deployment-agent',
      message: 'Pulled release image registry.sam.local/deploy-audit:7',
    },
    {
      timestamp: '2026-06-18T10:13:55.000Z',
      level: 'info',
      source: 'caddy',
      message: 'Route certificate is active for staging.deploy-audit.sammy.party',
    },
  ],
  nextCursor: null,
};

const MOCK_SYSTEM_INFO = {
  cpu: { numCpu: 4, model: 'AMD EPYC', loadAvg1: 0.42, loadAvg5: 0.38, loadAvg15: 0.31 },
  memory: { totalBytes: 8_000_000_000, usedBytes: 3_600_000_000, usedPercent: 45 },
  disk: { totalBytes: 120_000_000_000, usedBytes: 37_000_000_000, usedPercent: 31 },
  docker: { running: true, version: '26.1.0', containers: [] },
  software: { node: '22.16.0', docker: '26.1.0' },
  agent: { version: 'audit', status: 'running' },
};

async function respond(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setupMocks(page: Page) {
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
    if (path === '/api/projects') return respond(route, 200, { projects: [MOCK_PROJECT], total: 1 });
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
      return respond(route, 200, { environments: [MOCK_ENV] });
    }
    if (path === `/api/projects/${PROJECT_ID}/environments/${ENV_ID}/logs`) {
      return respond(route, 200, { ...MOCK_LOGS, source: 'node', nodeId: NODE_ID });
    }

    if (path === '/api/nodes') return respond(route, 200, [MOCK_NODE]);
    if (path === `/api/nodes/${NODE_ID}`) return respond(route, 200, MOCK_NODE);
    if (path === `/api/nodes/${NODE_ID}/system-info`) return respond(route, 200, MOCK_SYSTEM_INFO);
    if (path === `/api/nodes/${NODE_ID}/events`) return respond(route, 200, { events: [], nextCursor: null });
    if (path === `/api/nodes/${NODE_ID}/logs`) return respond(route, 200, MOCK_LOGS);
    if (path === '/api/workspaces') return respond(route, 200, []);

    return respond(route, 200, {});
  });
}

test.describe('Deployment control surface audit', () => {
  test('project deployments page exposes status, policy, logs, and teardown', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments`);

    await expect(page.getByRole('heading', { name: 'Deployments' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'staging' })).toBeVisible();
    await expect(page.getByText('Deployment Node', { exact: true })).toBeVisible();
    await expect(page.getByText('Agent Policy', { exact: true })).toBeVisible();
    await expect(page.locator('label').filter({ hasText: 'Deployment Builder' })).toBeVisible();
    await expect(page.getByText('staging.deploy-audit.sammy.party')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Destroy' })).toBeVisible();

    await page.getByRole('button', { name: 'Logs' }).click();
    await expect(page.getByText('Pulled release image')).toBeVisible();

    await screenshot(page, 'deployment-control-surface-page');
    await assertNoOverflow(page);
  });

  test('nodes page distinguishes deployment nodes from workspace nodes', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/nodes');

    await expect(page.getByText('deploy-staging-01')).toBeVisible();
    await expect(page.getByText('Deployment', { exact: true })).toBeVisible();
    await expect(page.getByText('Deployment workloads')).toBeVisible();
    await expect(page.getByText('Managed from the project deployment environment.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Workspace' })).toHaveCount(0);

    await screenshot(page, 'deployment-node-list-card');
    await assertNoOverflow(page);
  });

  test('deployment node detail suppresses workspace creation and explains management surface', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/nodes/${NODE_ID}`);

    await expect(page.getByRole('heading', { name: 'Deployment node' })).toBeVisible();
    await expect(page.getByText(/environment policy and teardown are managed/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Workspace' })).toHaveCount(0);

    await screenshot(page, 'deployment-node-detail');
    await assertNoOverflow(page);
  });
});
