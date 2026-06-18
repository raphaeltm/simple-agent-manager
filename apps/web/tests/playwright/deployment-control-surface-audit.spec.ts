import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, seedTheme } from './audit-helpers';

const PROJECT_ID = 'proj-deploy-audit';
const ENV_ID = 'env-staging';
const ENV_FAIL_ID = 'env-production-us-east-very-long-name';
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

const LONG_PROFILE_NAME = 'Deployment-Builder-Extended-Production-Release-Candidate-Profile-With-Very-Long-Name';

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
    errorMessage: 'compose pull failed: image registry.sam.local/deploy-audit:3 not found in registry — verify the image was pushed before submitting the release',
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
      message: 'ThisIsAnExtremelyLongLogMessageWithoutAnySpacesOrBreakPointsThatShouldNotCauseHorizontalOverflowInTheLogsPanel_ErrorCode_DEPLOY_COMPOSE_PULL_TIMEOUT_REGISTRY_UNREACHABLE_0xDEADBEEF',
    },
    {
      timestamp: '2026-06-18T10:11:00.000Z',
      level: 'warn',
      source: 'agent',
      message: 'TLS ACME HTTP-01 challenge timed out for staging.deploy-audit.sammy.party — port 80 may be unreachable from the public internet',
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

const MOCK_SYSTEM_INFO = {
  cpu: { numCpu: 4, model: 'AMD EPYC', loadAvg1: 0.42, loadAvg5: 0.38, loadAvg15: 0.31 },
  memory: { totalBytes: 8_000_000_000, usedBytes: 3_600_000_000, availableBytes: 4_400_000_000, usedPercent: 45 },
  disk: { totalBytes: 120_000_000_000, usedBytes: 37_000_000_000, availableBytes: 83_000_000_000, usedPercent: 31, mountPath: '/' },
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

async function setupMocks(page: Page, opts?: { includeFailingEnv?: boolean }) {
  const includeFailingEnv = opts?.includeFailingEnv ?? true;

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
      const envs = includeFailingEnv ? [MOCK_ENV, MOCK_ENV_FAILING] : [MOCK_ENV];
      return respond(route, 200, { environments: envs });
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
      return respond(route, 200, { entries: [], nextCursor: null, unavailableReason: 'node_stale' });
    }
    if (path === `/api/projects/${PROJECT_ID}/environments/${ENV_FAIL_ID}/containers`) {
      return respond(route, 200, { containers: [], nodeId: NODE_STALE_ID, unavailableReason: 'node_stale' });
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
    if (path === `/api/nodes/${NODE_STALE_ID}/system-info`) return respond(route, 500, { error: 'Node unreachable' });
    if (path === `/api/nodes/${NODE_ID}/events`) return respond(route, 200, { events: [], nextCursor: null });
    if (path === `/api/nodes/${NODE_STALE_ID}/events`) return respond(route, 200, { events: [], nextCursor: null });
    if (path === `/api/nodes/${NODE_ID}/logs`) return respond(route, 200, MOCK_LOGS);
    if (path === `/api/nodes/${NODE_ID}/containers`) return respond(route, 200, MOCK_CONTAINERS);
    if (path === `/api/nodes/${NODE_STALE_ID}/logs`) return respond(route, 200, { entries: [], nextCursor: null });
    if (path === `/api/nodes/${NODE_STALE_ID}/containers`) return respond(route, 200, { containers: [] });
    if (path === '/api/workspaces') return respond(route, 200, []);

    return respond(route, 200, {});
  });
}

test.describe('Deployment control surface audit', () => {
  test('project deployments page — healthy environment with attribution, summary, logs', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments`);

    await expect(page.getByRole('heading', { name: 'Deployments' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'staging' })).toBeVisible();
    const stagingCard = page.locator('article').filter({ hasText: 'staging' }).first();

    // Operational summary: Serving badge and release version
    await expect(page.getByText('Serving', { exact: true })).toBeVisible();
    await expect(page.getByText('Release v7', { exact: true })).toBeVisible();

    // Release attribution
    await expect(page.getByText(/submitted by/).first()).toBeVisible();

    // Deployment Node section
    await expect(page.getByText('Deployment Node', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Agent Policy', { exact: true }).first()).toBeVisible();

    // Deployment metrics panel with node and per-container metrics.
    await expect(stagingCard.getByText('Metrics', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(stagingCard.getByText('deploy-audit-web-1')).toBeVisible();
    await expect(stagingCard.getByText('3.5MiB / 256MiB')).toBeVisible();

    // Route hostnames (including long one)
    await expect(page.getByText('staging.deploy-audit.sammy.party')).toBeVisible();

    // Destroy button
    await expect(page.getByRole('button', { name: 'Destroy' }).first()).toBeVisible();

    // Open logs on the staging card
    await stagingCard.getByRole('button', { name: 'Logs' }).click();
    await expect(page.getByText('Pulled release image')).toBeVisible({ timeout: 10000 });
    await stagingCard.locator('#log-source').selectOption('app');
    await expect(stagingCard.locator('#log-container')).toBeVisible();
    await expect(stagingCard.locator('#log-container')).toContainText('deploy-audit-web-1');
    // UTC timestamps in logs
    await expect(page.getByText('UTC').first()).toBeVisible();

    await screenshot(page, 'deployment-control-surface-healthy');
    await assertNoOverflow(page);
  });

  test('project deployments page — failing environment with blocker, NaN guard, stale node', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments`);

    // Wait for failing env to render
    const failingCard = page.locator('article').filter({ hasText: 'production-us-east' });
    await expect(failingCard).toBeVisible();

    // Blocker/needs-attention line
    await expect(failingCard.getByText(/compose pull failed/)).toBeVisible();

    // Release v3 failed
    await expect(failingCard.getByText('Release v3', { exact: true })).toBeVisible();
    await expect(failingCard.getByText('failed').first()).toBeVisible();

    // NaN guard: Root Disk should show '-' not 'NaN%'
    await expect(failingCard.locator('div').filter({ hasText: /^Root Disk\s*-$/ }).first()).toBeVisible();
    // Verify no NaN text visible anywhere
    const nanCount = await failingCard.locator('text=NaN').count();
    expect(nanCount).toBe(0);

    // Stale node badge
    await expect(failingCard.getByText('Stale', { exact: true })).toBeVisible();

    await screenshot(page, 'deployment-control-surface-failing');
    await assertNoOverflow(page);
  });

  test('failing environment logs show unavailable reason for stale node', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments`);

    const failingCard = page.locator('article').filter({ hasText: 'production-us-east' });
    await failingCard.getByRole('button', { name: 'Logs' }).click();

    // Clear unavailable copy
    await expect(failingCard.getByText(/not reported recently/)).toBeVisible();

    await screenshot(page, 'deployment-logs-unavailable-stale');
    await assertNoOverflow(page);
  });

  test('destroy dialog on deployments page shows deployment-specific consequences', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments`);

    // Click Destroy on the first (staging) env
    await page.getByRole('button', { name: 'Destroy' }).first().click();

    // Deployment-specific confirmation copy
    await expect(page.getByText('Removes all app-route DNS records')).toBeVisible();
    await expect(page.getByText('Detaches and deletes attached deployment volumes')).toBeVisible();
    await expect(page.getByText('Destroys the deployment node')).toBeVisible();
    await expect(page.getByText('This cannot be undone.')).toBeVisible();

    await screenshot(page, 'deployment-destroy-dialog');
    await assertNoOverflow(page);
  });

  test('nodes page distinguishes deployment nodes from workspace nodes', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/nodes');

    await expect(page.getByText('deploy-staging-01')).toBeVisible();
    await expect(page.getByText('Deployment', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Deployment workloads').first()).toBeVisible();
    await expect(page.getByText('Managed from the project deployment environment.').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Create Workspace' })).toHaveCount(0);

    // Stale deployment node
    await expect(page.getByText(/deploy-production-us-east/).first()).toBeVisible();

    await screenshot(page, 'deployment-node-list-card');
    await assertNoOverflow(page);
  });

  test('deployment node detail suppresses workspace creation and explains management surface', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/nodes/${NODE_ID}`);

    await expect(page.getByRole('heading', { name: 'Deployment node' })).toBeVisible();
    await expect(page.getByText(/environment policy/)).toBeVisible();
    await expect(page.getByText(/Destroy.*action on the Deployments page/)).toBeVisible();
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

  test('log panel shows source and level filter controls', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments`);

    const stagingCard = page.locator('article').filter({ hasText: 'staging' }).first();
    await stagingCard.getByRole('button', { name: 'Logs' }).click();

    // Source filter
    await expect(page.locator('#log-source')).toBeVisible();
    // Level filter
    await expect(page.locator('#log-level')).toBeVisible();
    // Search input
    await expect(page.getByPlaceholder('Search logs...')).toBeVisible();
    await page.locator('#log-source').selectOption('app');
    await expect(page.locator('#log-container')).toBeVisible();
    await expect(page.locator('#log-container')).toContainText('deploy-audit-worker-1');
    // Copy button
    await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible();

    await screenshot(page, 'deployment-logs-controls');
    await assertNoOverflow(page);
  });

  test('long log messages do not cause horizontal overflow', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments`);

    const stagingCard = page.locator('article').filter({ hasText: 'staging' }).first();
    await stagingCard.getByRole('button', { name: 'Logs' }).click();
    // Wait for logs to load from mock API
    await expect(page.getByText('Pulled release image')).toBeVisible({ timeout: 10000 });
    // The long unbreakable log message should be visible and not overflow
    await expect(page.getByText(/DEPLOY_COMPOSE_PULL_TIMEOUT/)).toBeVisible();

    await assertNoOverflow(page);
    await screenshot(page, 'deployment-logs-long-message');
  });
});

// ─── Mobile viewport tests ─────────────────────────────────────────────────

test.describe('Deployment control surface — mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('deployments page with healthy and failing env — mobile', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments`);

    await expect(page.getByRole('heading', { name: 'Deployments' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'staging' })).toBeVisible();
    await expect(page.getByText('Serving', { exact: true })).toBeVisible();

    await screenshot(page, 'deployment-mobile-healthy');
    await assertNoOverflow(page);
  });

  test('failing environment on mobile — no overflow', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments`);

    const failingCard = page.locator('article').filter({ hasText: 'production-us-east' });
    await expect(failingCard).toBeVisible();

    await screenshot(page, 'deployment-mobile-failing');
    await assertNoOverflow(page);
  });

  test('destroy dialog on mobile — no overflow', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/deployments`);

    await page.getByRole('button', { name: 'Destroy' }).first().click();
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
    await page.goto(`/projects/${PROJECT_ID}/deployments`);

    const stagingCard = page.locator('article').filter({ hasText: 'staging' }).first();
    await stagingCard.getByRole('button', { name: 'Logs' }).click();
    await expect(page.getByText('Pulled release image')).toBeVisible({ timeout: 10000 });

    await screenshot(page, 'deployment-mobile-logs');
    await assertNoOverflow(page);
  });
});
