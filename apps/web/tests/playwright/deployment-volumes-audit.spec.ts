import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, seedTheme } from './audit-helpers';

const PROJECT_ID = 'proj-volume-audit';
const ENV_ID = 'env-volume-staging';
const NODE_ID = 'node-volume-audit';

const MOCK_USER = makeMockUser({
  email: 'volume-audit@example.com',
  name: 'Volume Audit User',
  role: 'superadmin',
  sessionId: 'session-volume-audit',
  userId: 'user-volume-audit',
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Volume Audit Project',
  repository: 'sam/volume-audit',
  defaultBranch: 'main',
  userId: 'user-volume-audit',
  githubInstallationId: 'inst-volume-audit',
  defaultVmSize: 'medium',
  defaultAgentType: 'openai-codex',
  defaultProvider: 'hetzner',
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-07-02T08:00:00.000Z',
  updatedAt: '2026-07-02T09:00:00.000Z',
};

const MOCK_NODE = {
  id: NODE_ID,
  name: 'deploy-volume-staging-01',
  status: 'running',
  healthStatus: 'healthy',
  nodeRole: 'deployment',
  vmSize: 'medium',
  vmLocation: 'nbg1',
  ipAddress: '10.0.0.42',
  cloudProvider: 'hetzner',
  heartbeatStaleAfterSeconds: 180,
  lastHeartbeatAt: '2026-07-02T09:14:00.000Z',
  errorMessage: null,
  createdAt: '2026-07-02T08:30:00.000Z',
  updatedAt: '2026-07-02T09:14:00.000Z',
  lastMetrics: {
    cpuLoadAvg1: 0.21,
    memoryPercent: 37,
    diskPercent: 24,
  },
  deploymentEnvironments: [{ id: ENV_ID, projectId: PROJECT_ID, name: 'staging' }],
};

const MOCK_ENV = {
  id: ENV_ID,
  projectId: PROJECT_ID,
  name: 'staging',
  status: 'active',
  nodeId: NODE_ID,
  provider: 'hetzner',
  location: 'nbg1',
  createdAt: '2026-07-02T08:20:00.000Z',
  updatedAt: '2026-07-02T09:13:00.000Z',
  secretsUpdatedAt: '2026-07-02T09:00:00.000Z',
  observedDeployment: {
    appliedSeq: 12,
    status: 'applied',
    errorMessage: null,
    services: { web: { image: 'registry.sam.local/volume-audit:12' } },
    deployStatus: {
      appHealth: 'healthy',
      nodeHealth: 'healthy',
      providerManageability: 'managed',
      routeCertState: 'issued',
      diskPressure: 'normal',
      configDrift: 'none',
    },
    diskTelemetry: { rootDisk: { usedPercent: 24.4 } },
    observedAt: '2026-07-02T09:14:00.000Z',
  },
  agentPolicy: {
    agentDeployEnabled: true,
    agentDeployEnabledBy: 'user-volume-audit',
    agentDeployEnabledAt: '2026-07-02T08:30:00.000Z',
    agentDeployDisabledAt: null,
    allowedDeployProfileIds: [],
  },
  latestRelease: {
    id: 'release-volume-12',
    environmentId: ENV_ID,
    version: 12,
    status: 'applied',
    createdBy: 'volume-audit-task',
    createdAt: '2026-07-02T09:00:00.000Z',
  },
  routeHostnames: ['staging.volume-audit.sammy.party'],
  node: MOCK_NODE,
};

interface MockVolume {
  id: string;
  environmentId: string;
  name: string;
  providerVolumeId: string;
  providerName: string;
  sizeGb: number;
  location: string;
  status: string;
  attachedServerId: string | null;
  linuxDevice: string | null;
  createdAt: string;
  updatedAt: string;
}

function volume(overrides: Partial<MockVolume> = {}): MockVolume {
  return {
    id: 'vol-data',
    environmentId: ENV_ID,
    name: 'data',
    providerVolumeId: 'hcloud-volume-1001',
    providerName: 'hetzner',
    sizeGb: 10,
    location: 'nbg1',
    status: 'available',
    attachedServerId: null,
    linuxDevice: null,
    createdAt: '2026-07-02T09:00:00.000Z',
    updatedAt: '2026-07-02T09:05:00.000Z',
    ...overrides,
  };
}

const NORMAL_VOLUMES: MockVolume[] = [
  volume({
    id: 'vol-data',
    name: 'data',
    providerVolumeId: 'hcloud-volume-1001',
    status: 'in-use',
    attachedServerId: 'server-0842d1a9',
    linuxDevice: '/dev/disk/by-id/scsi-0HC_Volume_1001',
  }),
  volume({
    id: 'vol-uploads',
    name: 'uploads',
    providerVolumeId: 'hcloud-volume-1002',
    sizeGb: 40,
    status: 'available',
  }),
  volume({
    id: 'vol-cache',
    name: 'cache',
    providerVolumeId: 'hcloud-volume-1003',
    sizeGb: 5,
    status: 'creating',
  }),
];

const LONG_ID =
  'hcloud-volume-' +
  Array.from({ length: 16 }, (_, index) => `unbrokenidentifiersegment${index}`).join('');

const LONG_TEXT_VOLUMES: MockVolume[] = [
  volume({
    id: 'vol-long',
    name: 'state-store-with-long-safe-compose-volume-name-for-audit',
    providerVolumeId: LONG_ID,
    providerName: 'hetzner<script>alert("volume")</script>',
    location: 'nbg1-漢字-🙂-&lt;quoted&gt;',
    status: 'in-use',
    attachedServerId: 'server-' + '0123456789abcdef'.repeat(8),
    linuxDevice:
      '/dev/disk/by-id/scsi-0HC_Volume_' + 'VERY_LONG_DEVICE_IDENTIFIER_'.repeat(8),
  }),
];

const MANY_VOLUMES: MockVolume[] = Array.from({ length: 32 }, (_, index) =>
  volume({
    id: `vol-many-${index + 1}`,
    name: `service-${String(index + 1).padStart(2, '0')}`,
    providerVolumeId: `hcloud-volume-many-${String(index + 1).padStart(2, '0')}`,
    sizeGb: (index % 4) + 1,
    status: index % 3 === 0 ? 'in-use' : 'available',
    attachedServerId: index % 3 === 0 ? `server-${index + 1}` : null,
    linuxDevice: index % 3 === 0 ? `/dev/disk/by-id/scsi-volume-${index + 1}` : null,
  })
);

async function respond(route: Route, status: number, body: unknown) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function setupMocks(
  page: Page,
  opts: { volumes?: MockVolume[]; volumeError?: boolean } = {}
) {
  await seedTheme(page, 'dark');
  await page.addInitScript(() => {
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-volume-audit', 'true');
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    if (path === '/api/auth/get-session') return respond(route, 200, MOCK_USER);
    if (path === '/api/github/installations') return respond(route, 200, []);
    if (path === '/api/projects') {
      return respond(route, 200, { projects: [MOCK_PROJECT], total: 1 });
    }
    if (path === '/api/agents') return respond(route, 200, { agents: [] });
    if (path === '/api/credentials') return respond(route, 200, []);
    if (path === '/api/credentials/agent') return respond(route, 200, { credentials: [] });
    if (path === '/api/notifications') {
      return respond(route, 200, { notifications: [], unreadCount: 0, nextCursor: null });
    }
    if (path === '/api/trial/status') return respond(route, 200, { available: false });
    if (path === '/api/providers/catalog') return respond(route, 200, { catalogs: [] });
    if (path === '/api/nodes') return respond(route, 200, [MOCK_NODE]);
    if (path === `/api/nodes/${NODE_ID}`) return respond(route, 200, MOCK_NODE);
    if (path === '/api/workspaces') return respond(route, 200, []);

    if (path === `/api/projects/${PROJECT_ID}` && method === 'GET') {
      return respond(route, 200, MOCK_PROJECT);
    }
    if (path === `/api/projects/${PROJECT_ID}/agent-profiles`) {
      return respond(route, 200, { items: [] });
    }
    if (path === `/api/projects/${PROJECT_ID}/environments` && method === 'GET') {
      return respond(route, 200, { environments: [MOCK_ENV] });
    }
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_ID}/volumes` &&
      method === 'GET'
    ) {
      if (opts.volumeError) {
        return respond(route, 500, {
          error: 'DEPLOYMENT_VOLUMES_UNAVAILABLE',
          message:
            'Provider volume listing failed for a long diagnostic message that should wrap cleanly in the alert.',
        });
      }
      return respond(route, 200, { volumes: opts.volumes ?? NORMAL_VOLUMES });
    }
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_ID}/volumes/attach` &&
      method === 'POST'
    ) {
      return respond(route, 200, { volumes: opts.volumes ?? NORMAL_VOLUMES });
    }
    if (
      path === `/api/projects/${PROJECT_ID}/environments/${ENV_ID}/volumes/detach` &&
      method === 'POST'
    ) {
      return respond(route, 200, {
        volumes: (opts.volumes ?? NORMAL_VOLUMES).map((item) => ({
          ...item,
          attachedServerId: null,
          linuxDevice: null,
          status: 'available',
        })),
      });
    }

    return respond(route, 200, {});
  });
}

function screenshotDir(): string {
  return process.cwd().endsWith('/apps/web')
    ? resolve(process.cwd(), '../../.codex/tmp/playwright-screenshots')
    : resolve(process.cwd(), '.codex/tmp/playwright-screenshots');
}

async function capture(page: Page, name: string) {
  await page.waitForTimeout(600);
  const viewport = page.viewportSize();
  const suffix = viewport ? `-${viewport.width}x${viewport.height}` : '';
  const dir = screenshotDir();
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}${suffix}.png`, fullPage: true });
}

async function gotoVolumes(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}/deployments/${ENV_ID}?tab=volumes`);
  await expect(page.getByRole('heading', { name: 'staging', level: 1 })).toBeVisible();
  await expect(page.locator(`#deployment-volumes-${ENV_ID}`)).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
}

async function assertNoOverflowAt320(page: Page) {
  const original = page.viewportSize();
  await page.setViewportSize({ width: 320, height: 667 });
  await page.waitForTimeout(300);
  await assertNoOverflow(page);
  if (original) await page.setViewportSize(original);
}

test.describe('Deployment volumes visual audit', () => {
  test('normal volume management state renders metrics, actions and provider metadata', async ({
    page,
  }) => {
    await setupMocks(page, { volumes: NORMAL_VOLUMES });
    await gotoVolumes(page);

    await expect(page.getByText('Attached').first()).toBeVisible();
    await expect(page.getByText('hcloud-volume-1001')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Attach' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Detach' })).toBeVisible();

    await capture(page, 'deployment-volumes-normal');
    await assertNoOverflow(page);
    await assertNoOverflowAt320(page);
  });

  test('long and special provider text wraps without horizontal overflow', async ({ page }) => {
    await setupMocks(page, { volumes: LONG_TEXT_VOLUMES });
    await gotoVolumes(page);

    await expect(page.getByText(/state-store-with-long-safe/)).toBeVisible();
    await expect(page.getByText(/<script>alert/).first()).toBeVisible();
    await expect(page.getByText(/漢字/)).toBeVisible();

    await capture(page, 'deployment-volumes-long-special');
    await assertNoOverflow(page);
  });

  test('empty state keeps create controls visible', async ({ page }) => {
    await setupMocks(page, { volumes: [] });
    await gotoVolumes(page);

    await expect(page.getByText('No volumes created for this environment.')).toBeVisible();
    await expect(page.getByPlaceholder('data')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add' })).toBeVisible();

    await capture(page, 'deployment-volumes-empty');
    await assertNoOverflow(page);
  });

  test('many volumes preserve scanability in a long list', async ({ page }) => {
    await setupMocks(page, { volumes: MANY_VOLUMES });
    await gotoVolumes(page);

    await expect(page.getByText('service-01')).toBeVisible();
    await expect(page.getByText('service-32')).toBeVisible();
    await expect(page.getByText('32').first()).toBeVisible();

    await capture(page, 'deployment-volumes-many');
    await assertNoOverflow(page);
  });

  test('volume listing error is readable and recoverable', async ({ page }) => {
    await setupMocks(page, { volumeError: true });
    await gotoVolumes(page);

    await expect(page.getByText(/Provider volume listing failed/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();

    await capture(page, 'deployment-volumes-error');
    await assertNoOverflow(page);
  });
});
