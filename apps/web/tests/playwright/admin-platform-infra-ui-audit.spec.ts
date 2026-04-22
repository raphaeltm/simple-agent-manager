import { expect, type Page, type Route, test } from '@playwright/test';

const MOCK_AUTH = {
  user: {
    id: 'user-admin-1',
    email: 'admin@example.com',
    name: 'Admin User',
    image: null,
    role: 'admin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-admin-1',
    userId: 'user-admin-1',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

interface PlatformNodeOverrides {
  id: string;
  name: string;
  status?: string;
  healthStatus?: string;
  ownerUserId?: string;
  vmSize?: string;
  vmLocation?: string;
  cloudProvider?: string | null;
  credentialSource?: string | null;
  lastHeartbeatAt?: string | null;
  errorMessage?: string | null;
  createdAt?: string;
  workspaceCount?: number;
  activeWorkspaceCount?: number;
  trial?: {
    id: string;
    status: string;
    repoOwner: string;
    repoName: string;
    claimedByUserId: string | null;
  } | null;
  association?: {
    nodeId: string;
    userId: string;
    userEmail: string;
    userName: string | null;
    reason: 'trial' | 'support' | 'migration' | 'other';
    associatedBy: string;
    createdAt: string;
    updatedAt: string;
  } | null;
}

function makeNode(overrides: PlatformNodeOverrides) {
  return {
    id: overrides.id,
    ownerUserId: overrides.ownerUserId ?? 'user-owner-1',
    name: overrides.name,
    status: overrides.status ?? 'ready',
    healthStatus: overrides.healthStatus ?? 'healthy',
    cloudProvider: overrides.cloudProvider ?? 'hetzner',
    vmSize: overrides.vmSize ?? 'cx22',
    vmLocation: overrides.vmLocation ?? 'nbg1',
    credentialSource: overrides.credentialSource ?? 'platform',
    lastHeartbeatAt: overrides.lastHeartbeatAt ?? '2026-04-22T08:00:00Z',
    errorMessage: overrides.errorMessage ?? null,
    createdAt: overrides.createdAt ?? '2026-04-22T07:00:00Z',
    workspaceCount: overrides.workspaceCount ?? 1,
    activeWorkspaceCount: overrides.activeWorkspaceCount ?? 1,
    trial: overrides.trial ?? null,
    association: overrides.association ?? null,
  };
}

const USER_OPTIONS = [
  { id: 'user-1', email: 'trial-user@example.com', name: 'Trial User' },
  { id: 'user-2', email: 'support-user@example.com', name: 'Support User' },
  { id: 'user-3', email: 'unicode+ops@example.com', name: 'Ops Ω' },
];

const NORMAL_NODES = [
  makeNode({
    id: 'node-1',
    name: 'trial-node-alpha',
    trial: {
      id: 'trial-1',
      status: 'active',
      repoOwner: 'octo-org',
      repoName: 'trial-repo',
      claimedByUserId: null,
    },
    association: {
      nodeId: 'node-1',
      userId: 'user-1',
      userEmail: 'trial-user@example.com',
      userName: 'Trial User',
      reason: 'trial',
      associatedBy: 'user-admin-1',
      createdAt: '2026-04-22T07:15:00Z',
      updatedAt: '2026-04-22T07:30:00Z',
    },
  }),
  makeNode({
    id: 'node-2',
    name: 'migration-node-beta',
    status: 'running',
    workspaceCount: 3,
    activeWorkspaceCount: 2,
    association: null,
  }),
  makeNode({
    id: 'node-3',
    name: 'support-node-gamma',
    status: 'degraded',
    healthStatus: 'degraded',
    errorMessage: 'Disk pressure warning on /var/lib/docker',
    association: {
      nodeId: 'node-3',
      userId: 'user-2',
      userEmail: 'support-user@example.com',
      userName: 'Support User',
      reason: 'support',
      associatedBy: 'user-admin-1',
      createdAt: '2026-04-22T06:15:00Z',
      updatedAt: '2026-04-22T06:30:00Z',
    },
  }),
];

const LONG_TEXT_NODES = [
  makeNode({
    id: 'node-long-1',
    name:
      'platform-node-' +
      'with-an-extremely-long-display-name-that-should-wrap-cleanly-without-overflowing-on-mobile-or-desktop-'.repeat(2),
    trial: {
      id: 'trial-long-1',
      status: 'claimed',
      repoOwner: 'emoji-ops-🚀-team',
      repoName:
        'repo-with-special-characters-<script>alert("xss")</script>-and-super-long-name-to-test-layout-wrapping',
      claimedByUserId: 'user-3',
    },
    association: {
      nodeId: 'node-long-1',
      userId: 'user-3',
      userEmail: 'unicode+ops@example.com',
      userName: 'Ops Ω 😀',
      reason: 'other',
      associatedBy: 'user-admin-1',
      createdAt: '2026-04-22T05:15:00Z',
      updatedAt: '2026-04-22T05:45:00Z',
    },
    errorMessage:
      'Provisioning reported special characters & entities: <tag> &amp; "quotes" and a very long URL https://example.com/really/long/path/that/should/not/cause/overflow/even/when/rendered/in/the/error/alert',
  }),
  makeNode({
    id: 'node-long-2',
    name: 'A',
    association: null,
  }),
];

const MANY_NODES = Array.from({ length: 30 }, (_, index) =>
  makeNode({
    id: `node-many-${index}`,
    name: `platform-node-${index + 1}`,
    status: index % 5 === 0 ? 'running' : 'ready',
    healthStatus: index % 7 === 0 ? 'degraded' : 'healthy',
    workspaceCount: (index % 4) + 1,
    activeWorkspaceCount: index % 3,
    association:
      index % 2 === 0
        ? {
            nodeId: `node-many-${index}`,
            userId: USER_OPTIONS[index % USER_OPTIONS.length].id,
            userEmail: USER_OPTIONS[index % USER_OPTIONS.length].email,
            userName: USER_OPTIONS[index % USER_OPTIONS.length].name,
            reason: index % 4 === 0 ? 'trial' : 'migration',
            associatedBy: 'user-admin-1',
            createdAt: '2026-04-22T05:15:00Z',
            updatedAt: '2026-04-22T05:45:00Z',
          }
        : null,
  }),
);

function projectSlug(projectName: string) {
  return projectName.includes('Desktop') ? 'desktop' : 'mobile';
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function expectNoHorizontalOverflow(page: Page) {
  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(hasOverflow).toBe(false);
}

async function setupApiMocks(
  page: Page,
  options: {
    nodes?: ReturnType<typeof makeNode>[];
    users?: typeof USER_OPTIONS;
    platformInfraStatus?: number;
  } = {},
) {
  const {
    nodes = NORMAL_NODES,
    users = USER_OPTIONS,
    platformInfraStatus = 200,
  } = options;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    if (path.includes('/api/auth/')) {
      return respond(200, MOCK_AUTH);
    }

    if (path === '/api/admin/platform-infra' && method === 'GET') {
      if (platformInfraStatus !== 200) {
        return respond(platformInfraStatus, {
          error: 'INTERNAL_ERROR',
          message: 'Platform infra fetch failed',
        });
      }
      return respond(200, { nodes, users });
    }

    if (path.startsWith('/api/admin/platform-infra/nodes/') && method === 'PUT') {
      const body = JSON.parse(route.request().postData() ?? '{}') as {
        userId?: string;
        reason?: 'trial' | 'support' | 'migration' | 'other';
      };
      const user = users.find((entry) => entry.id === body.userId) ?? users[0];
      const nodeId = path.split('/').at(-2) ?? 'node-1';
      return respond(200, {
        nodeId,
        userId: user.id,
        userEmail: user.email,
        userName: user.name,
        reason: body.reason ?? 'trial',
        associatedBy: 'user-admin-1',
        createdAt: '2026-04-22T07:15:00Z',
        updatedAt: '2026-04-22T07:15:00Z',
      });
    }

    if (path.startsWith('/api/admin/platform-infra/nodes/') && method === 'DELETE') {
      return respond(200, { success: true });
    }

    if (path === '/api/projects') {
      return respond(200, { projects: [] });
    }

    if (path === '/api/nodes') {
      return respond(200, []);
    }

    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }

    if (path.startsWith('/api/github/installations')) {
      return respond(200, []);
    }

    return respond(200, {});
  });
}

async function gotoPlatformInfra(page: Page) {
  await page.goto('/admin/platform-infra');
  await expect(page.getByRole('heading', { name: 'Platform Infrastructure' })).toBeVisible();
}

test.describe('Admin Platform Infra UI Audit', () => {
  test('normal data renders with clear hierarchy and actions', async ({ page }, testInfo) => {
    await setupApiMocks(page, { nodes: NORMAL_NODES });
    await gotoPlatformInfra(page);

    await expect(page.getByText('trial-node-alpha')).toBeVisible();
    await expect(page.getByText('Monitor platform-funded nodes and associate them with users for trial, support, or migration workflows.')).toBeVisible();

    const saveButton = page.getByRole('button', { name: 'Save' }).first();
    const buttonBox = await saveButton.boundingBox();
    expect(buttonBox?.height ?? 0).toBeGreaterThanOrEqual(44);

    await expectNoHorizontalOverflow(page);
    await screenshot(page, `admin-platform-infra-normal-${projectSlug(testInfo.project.name)}`);
  });

  test('long text and special characters wrap without overflow', async ({ page }, testInfo) => {
    await setupApiMocks(page, { nodes: LONG_TEXT_NODES });
    await gotoPlatformInfra(page);

    await expect(page.getByText(/emoji-ops-🚀-team/i)).toBeVisible();
    await expect(page.getByText(/Ops Ω 😀/)).toBeVisible();

    await expectNoHorizontalOverflow(page);
    await screenshot(page, `admin-platform-infra-long-text-${projectSlug(testInfo.project.name)}`);
  });

  test('empty state stays readable', async ({ page }, testInfo) => {
    await setupApiMocks(page, { nodes: [] });
    await gotoPlatformInfra(page);

    await expect(page.getByText('No platform-managed nodes')).toBeVisible();
    await expect(page.getByText('No platform-funded nodes match the current filter.')).toBeVisible();

    await expectNoHorizontalOverflow(page);
    await screenshot(page, `admin-platform-infra-empty-${projectSlug(testInfo.project.name)}`);
  });

  test('many items remain scrollable without layout breakage', async ({ page }, testInfo) => {
    await setupApiMocks(page, { nodes: MANY_NODES });
    await gotoPlatformInfra(page);

    await expect(page.getByText('platform-node-30')).toBeVisible();
    await expect(page.getByText(/^Nodes$/)).toBeVisible();
    await expect(page.locator('text=30').first()).toBeVisible();

    await expectNoHorizontalOverflow(page);
    await screenshot(page, `admin-platform-infra-many-${projectSlug(testInfo.project.name)}`);
  });

  test('error state is visible and recoverable', async ({ page }, testInfo) => {
    await setupApiMocks(page, { platformInfraStatus: 500 });
    await gotoPlatformInfra(page);

    await expect(page.getByText('Platform infra fetch failed')).toBeVisible();

    await expectNoHorizontalOverflow(page);
    await screenshot(page, `admin-platform-infra-error-${projectSlug(testInfo.project.name)}`);
  });
});
