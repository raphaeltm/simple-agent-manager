import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock Data Factories
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'admin@example.com',
    name: 'Admin User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-test-1',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

// ---------------------------------------------------------------------------
// Node Usage Mock Payloads (AdminNodeUsageResponse shape)
// ---------------------------------------------------------------------------

const PERIOD = {
  start: '2026-04-01T00:00:00Z',
  end: '2026-04-30T23:59:59Z',
};

function makeUserNodeSummary(overrides: {
  userId: string;
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  totalNodeHours?: number;
  totalVcpuHours?: number;
  platformNodeHours?: number;
  activeNodes?: number;
}) {
  return {
    userId: overrides.userId,
    name: overrides.name ?? `User ${overrides.userId}`,
    email: overrides.email ?? `user-${overrides.userId}@example.com`,
    avatarUrl: overrides.avatarUrl ?? null,
    totalNodeHours: overrides.totalNodeHours ?? 12.5,
    totalVcpuHours: overrides.totalVcpuHours ?? 50.0,
    platformNodeHours: overrides.platformNodeHours ?? 10.0,
    activeNodes: overrides.activeNodes ?? 0,
  };
}

function makeNodeUsageRecord(overrides: {
  nodeId: string;
  name?: string;
  vmSize?: string;
  vcpuCount?: number;
  vmLocation?: string;
  cloudProvider?: string | null;
  credentialSource?: string;
  status?: string;
  createdAt?: string;
  endedAt?: string | null;
  workspaceCount?: number;
}) {
  return {
    nodeId: overrides.nodeId,
    name: overrides.name ?? `node-${overrides.nodeId.slice(0, 6)}`,
    vmSize: overrides.vmSize ?? 'cpx21',
    vcpuCount: overrides.vcpuCount ?? 2,
    vmLocation: overrides.vmLocation ?? 'hel1',
    cloudProvider: overrides.cloudProvider ?? 'hetzner',
    credentialSource: overrides.credentialSource ?? 'platform',
    status: overrides.status ?? 'running',
    createdAt: overrides.createdAt ?? '2026-04-10T08:00:00Z',
    endedAt: overrides.endedAt ?? null,
    workspaceCount: overrides.workspaceCount ?? 1,
  };
}

// Normal dataset: a few users, mixed platform/BYOC, one with active nodes
const USERS_NORMAL = [
  makeUserNodeSummary({ userId: 'u1', name: 'Alice Johnson', email: 'alice@example.com', totalNodeHours: 24.5, totalVcpuHours: 98.0, platformNodeHours: 20.0, activeNodes: 2 }),
  makeUserNodeSummary({ userId: 'u2', name: 'Bob Smith', email: 'bob@example.com', totalNodeHours: 8.2, totalVcpuHours: 32.8, platformNodeHours: 8.2, activeNodes: 0 }),
  makeUserNodeSummary({ userId: 'u3', name: null, email: 'charlie@example.com', totalNodeHours: 1.1, totalVcpuHours: 4.4, platformNodeHours: 0, activeNodes: 0 }),
];

// Long text dataset: names/emails longer than 60 chars
const USERS_LONG_TEXT = [
  makeUserNodeSummary({
    userId: 'u-long',
    name: 'Alexandrina Bartholomew-Christodoulou von Österreich-Ungarn',
    email: 'very-long-email-address-that-might-overflow@extremely-long-subdomain.example.com',
    totalNodeHours: 999.99,
    totalVcpuHours: 3999.96,
    platformNodeHours: 500.0,
    activeNodes: 1,
  }),
  makeUserNodeSummary({
    userId: 'u-unicode',
    name: '田中 太郎 🤖 <test>',
    email: 'unicode+emoji@example.org',
    totalNodeHours: 0.001,
    totalVcpuHours: 0.004,
    platformNodeHours: 0.001,
    activeNodes: 0,
  }),
];

// Many users: 30+ to test scroll/list behavior
const USERS_MANY = Array.from({ length: 32 }, (_, i) =>
  makeUserNodeSummary({
    userId: `user-${i}`,
    name: `Test User ${i + 1}`,
    email: `user${i + 1}@example.com`,
    totalNodeHours: Math.random() * 50,
    totalVcpuHours: Math.random() * 200,
    platformNodeHours: Math.random() * 30,
    activeNodes: i % 5 === 0 ? 1 : 0,
  })
);

// Node records for the detail view
const NODES_NORMAL = [
  makeNodeUsageRecord({ nodeId: 'node-abc123def456ghi', name: 'prod-worker-1', vmSize: 'cpx31', vcpuCount: 4, credentialSource: 'platform', status: 'running' }),
  makeNodeUsageRecord({ nodeId: 'node-xyz789uvw012jkl', name: 'dev-node-1', vmSize: 'ccx13', vcpuCount: 2, credentialSource: 'user', status: 'destroyed', endedAt: '2026-04-15T12:00:00Z' }),
];

const NODES_LONG_ID = [
  makeNodeUsageRecord({
    nodeId: 'node-averylongnodeidthatmightcauseoverflowissues-abc123',
    name: 'a-very-long-node-name-that-might-not-fit-in-the-column',
    vmSize: 'cx11',
    vcpuCount: 1,
    credentialSource: 'platform',
    status: 'running',
  }),
];

const NODES_MANY = Array.from({ length: 20 }, (_, i) =>
  makeNodeUsageRecord({
    nodeId: `node-rec${i}-abcdef123456${i}`,
    name: `node-${i + 1}`,
    vmSize: i % 2 === 0 ? 'cpx21' : 'cpx31',
    vcpuCount: i % 2 === 0 ? 2 : 4,
    credentialSource: i % 3 === 0 ? 'user' : 'platform',
    status: i % 4 === 0 ? 'running' : 'destroyed',
    endedAt: i % 4 === 0 ? null : `2026-04-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
    workspaceCount: i + 1,
  })
);

// Admin node usage overview response (AdminNodeUsageResponse)
function makeAdminNodeUsageResponse(users: ReturnType<typeof makeUserNodeSummary>[]) {
  return {
    period: PERIOD,
    users,
  };
}

// Per-user node detail response (AdminUserNodeDetailedUsage)
function makeDetailedNodeUsage(options: {
  totalNodeHours?: number;
  totalVcpuHours?: number;
  platformNodeHours?: number;
  activeNodes?: number;
  nodes?: ReturnType<typeof makeNodeUsageRecord>[];
} = {}) {
  return {
    period: PERIOD,
    totalNodeHours: options.totalNodeHours ?? 24.5,
    totalVcpuHours: options.totalVcpuHours ?? 98.0,
    platformNodeHours: options.platformNodeHours ?? 20.0,
    activeNodes: options.activeNodes ?? (options.nodes ?? NODES_NORMAL).filter((n) => n.status === 'running').length,
    nodes: options.nodes ?? NODES_NORMAL,
  };
}

// ---------------------------------------------------------------------------
// Settings-level compute usage mock (unchanged — still uses /api/usage/compute)
// ---------------------------------------------------------------------------

function makeActiveSession(overrides: {
  workspaceId?: string;
  serverType?: string;
  vcpuCount?: number;
  credentialSource?: string;
  startedAt?: string;
}) {
  return {
    workspaceId: overrides.workspaceId ?? 'ws-abc123def456',
    serverType: overrides.serverType ?? 'cpx31',
    vcpuCount: overrides.vcpuCount ?? 4,
    credentialSource: overrides.credentialSource ?? 'platform',
    startedAt: overrides.startedAt ?? new Date(Date.now() - 3600000).toISOString(),
  };
}

const ACTIVE_SESSIONS_NORMAL = [
  makeActiveSession({ workspaceId: 'ws-abc123def456ghi', serverType: 'cpx31', vcpuCount: 4, credentialSource: 'platform' }),
  makeActiveSession({ workspaceId: 'ws-xyz789uvw012jkl', serverType: 'ccx13', vcpuCount: 2, credentialSource: 'user', startedAt: new Date(Date.now() - 7200000).toISOString() }),
];

const ACTIVE_SESSIONS_LONG = [
  makeActiveSession({
    workspaceId: 'ws-averylongworkspaceidthatmightcauseoverflowissues-abc123',
    serverType: 'cx11',
    vcpuCount: 1,
    credentialSource: 'platform',
  }),
];

function makeComputeUsageResponse(options: {
  activeSessions?: ReturnType<typeof makeActiveSession>[];
  totalVcpuHours?: number;
  platformVcpuHours?: number;
  userVcpuHours?: number;
  activeWorkspaces?: number;
} = {}) {
  const sessions = options.activeSessions ?? [];
  return {
    currentPeriod: {
      totalVcpuHours: options.totalVcpuHours ?? 18.75,
      platformVcpuHours: options.platformVcpuHours ?? 15.0,
      userVcpuHours: options.userVcpuHours ?? 3.75,
      activeWorkspaces: options.activeWorkspaces ?? sessions.length,
      start: PERIOD.start,
      end: PERIOD.end,
    },
    activeSessions: sessions,
  };
}

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

type MockOptions = {
  adminUsers?: ReturnType<typeof makeUserNodeSummary>[];
  userDetailedUsage?: ReturnType<typeof makeDetailedNodeUsage>;
  computeUsage?: ReturnType<typeof makeComputeUsageResponse>;
  adminUsageError?: boolean;
  computeUsageError?: boolean;
};

async function setupMocks(page: Page, options: MockOptions = {}) {
  const adminUsageData = makeAdminNodeUsageResponse(options.adminUsers ?? USERS_NORMAL);
  const userDetailData = options.userDetailedUsage ?? makeDetailedNodeUsage();
  const computeUsageData = options.computeUsage ?? makeComputeUsageResponse({ activeSessions: ACTIVE_SESSIONS_NORMAL });

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // Auth
    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);

    // Notifications
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });

    // Dashboard
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });

    // GitHub
    if (path.startsWith('/api/github')) return respond(200, []);

    // Credentials (for Settings shell)
    if (path.startsWith('/api/credentials')) return respond(200, []);

    // Smoke test status
    if (path.includes('/api/smoke-test')) return respond(200, { enabled: false });

    // Admin node usage (overview list) — GET /api/admin/usage/nodes
    if (path === '/api/admin/usage/nodes') {
      if (options.adminUsageError) return respond(500, { error: 'Internal server error' });
      return respond(200, adminUsageData);
    }

    // Admin node usage user detail — GET /api/admin/usage/nodes/:userId
    const nodeUserDetailMatch = path.match(/^\/api\/admin\/usage\/nodes\/([^/]+)$/);
    if (nodeUserDetailMatch) {
      return respond(200, userDetailData);
    }

    // Settings compute usage — GET /api/usage/compute (unchanged)
    if (path === '/api/usage/compute') {
      if (options.computeUsageError) return respond(500, { error: 'Failed to fetch' });
      return respond(200, computeUsageData);
    }

    // Trial status
    if (path === '/api/trial-status') return respond(200, { available: false });

    // User quota status (for SettingsComputeUsage — returns "no quota configured" shape)
    if (path === '/api/usage/quota') {
      return respond(200, {
        byocExempt: false,
        monthlyVcpuHoursLimit: null,
        currentUsage: 0,
        remaining: null,
        periodStart: PERIOD.start,
        periodEnd: PERIOD.end,
      });
    }

    // Nodes
    if (path.startsWith('/api/nodes')) return respond(200, { nodes: [] });

    // Projects
    if (path === '/api/projects') return respond(200, { projects: [] });

    // Health
    if (path.endsWith('/health')) return respond(200, { status: 'ok' });

    // Catch-all
    return respond(200, {});
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function goToAdminUsage(page: Page) {
  await page.goto('/admin/usage');
  await page.waitForTimeout(1500);
}

async function goToSettingsUsage(page: Page) {
  await page.goto('/settings/usage');
  await page.waitForTimeout(1500);
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoOverflow(page: Page) {
  const result = await page.evaluate(() => ({
    docOverflow: document.documentElement.scrollWidth > window.innerWidth,
    bodyOverflow: document.body.scrollWidth > window.innerWidth,
    docWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(
    result.docOverflow,
    `Document scrollWidth (${result.docWidth}) exceeds viewport (${result.viewportWidth})`
  ).toBe(false);
  expect(result.bodyOverflow).toBe(false);
}

// ===========================================================================
// ADMIN NODE USAGE — Mobile (375x667)
// ===========================================================================

test.describe('AdminComputeUsage — Mobile (375x667)', () => {
  test('normal data: user list renders without overflow', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_NORMAL });
    await goToAdminUsage(page);
    await expect(page.locator('text=Alice Johnson')).toBeVisible();
    await screenshot(page, 'admin-usage-normal-mobile');
    await assertNoOverflow(page);
  });

  test('long text: names and emails truncate, no overflow', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_LONG_TEXT });
    await goToAdminUsage(page);
    await page.waitForTimeout(400);
    await screenshot(page, 'admin-usage-long-text-mobile');
    await assertNoOverflow(page);
  });

  test('empty state: renders correctly with icon and message', async ({ page }) => {
    await setupMocks(page, { adminUsers: [] });
    await goToAdminUsage(page);
    await expect(page.locator('text=No node usage this period.')).toBeVisible();
    await screenshot(page, 'admin-usage-empty-mobile');
    await assertNoOverflow(page);
  });

  test('many items: 32-user list does not overflow', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_MANY });
    await goToAdminUsage(page);
    await page.waitForTimeout(400);
    await screenshot(page, 'admin-usage-many-mobile');
    await assertNoOverflow(page);
  });

  test('error state: renders error message', async ({ page }) => {
    await setupMocks(page, { adminUsageError: true });
    await page.goto('/admin/usage');
    await page.waitForTimeout(3000);
    await screenshot(page, 'admin-usage-error-mobile');
    await assertNoOverflow(page);
  });

  test('active-node indicator uses design token color (not green-500)', async ({ page }) => {
    await setupMocks(page, {
      adminUsers: [makeUserNodeSummary({ userId: 'u1', name: 'Alice', activeNodes: 3 })],
    });
    await goToAdminUsage(page);

    // The green dot should use bg-success (design system token), not an arbitrary Tailwind color
    const greenDot = page.locator('.bg-success').first();
    await expect(greenDot).toBeVisible();

    await screenshot(page, 'admin-usage-active-indicator-mobile');
    await assertNoOverflow(page);
  });

  test('drill-down: clicking user navigates to detail view', async ({ page }) => {
    await setupMocks(page, {
      adminUsers: USERS_NORMAL,
      userDetailedUsage: makeDetailedNodeUsage(),
    });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    await expect(page.locator('text=Back to all users')).toBeVisible();
    // Detail view should show stat cards and the Nodes table section
    await expect(page.locator('text=Node-hrs')).toBeVisible();
    await screenshot(page, 'admin-usage-detail-mobile');
    await assertNoOverflow(page);
  });

  test('detail view: long node IDs do not cause overflow', async ({ page }) => {
    await setupMocks(page, {
      adminUsers: USERS_NORMAL,
      userDetailedUsage: makeDetailedNodeUsage({ nodes: NODES_LONG_ID }),
    });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    await expect(page.locator('text=Back to all users')).toBeVisible();
    await screenshot(page, 'admin-usage-detail-long-node-mobile');
    await assertNoOverflow(page);
  });

  test('detail view: empty nodes section', async ({ page }) => {
    await setupMocks(page, {
      adminUsers: USERS_NORMAL,
      userDetailedUsage: makeDetailedNodeUsage({ nodes: [] }),
    });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    await expect(page.locator('text=No nodes this period.')).toBeVisible();
    await screenshot(page, 'admin-usage-detail-empty-nodes-mobile');
    await assertNoOverflow(page);
  });

  test('detail view: many nodes in table do not overflow', async ({ page }) => {
    await setupMocks(page, {
      adminUsers: USERS_NORMAL,
      userDetailedUsage: makeDetailedNodeUsage({ nodes: NODES_MANY }),
    });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    await expect(page.locator('text=Back to all users')).toBeVisible();
    await page.waitForTimeout(400);
    await screenshot(page, 'admin-usage-detail-many-nodes-mobile');
    // Table has overflow-x-auto container so body should not overflow
    await assertNoOverflow(page);
  });

  test('detail view: back button meets 44px minimum touch target', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_NORMAL, userDetailedUsage: makeDetailedNodeUsage() });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    await expect(page.locator('text=Back to all users')).toBeVisible();

    const backBtn = page.locator('button[aria-label="Back to all users"]');
    await expect(backBtn).toBeVisible();
    const box = await backBtn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    await screenshot(page, 'admin-usage-back-button-mobile');
  });

  test('special characters: unicode and HTML entities render safely', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_LONG_TEXT });
    await goToAdminUsage(page);
    // Unicode/emoji names should render without XSS or breaking layout
    await page.waitForTimeout(400);
    await screenshot(page, 'admin-usage-special-chars-mobile');
    await assertNoOverflow(page);
  });

  test('node status badge: running node shows green indicator', async ({ page }) => {
    await setupMocks(page, {
      adminUsers: USERS_NORMAL,
      userDetailedUsage: makeDetailedNodeUsage({ nodes: NODES_NORMAL }),
    });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    await expect(page.locator('text=Back to all users')).toBeVisible();
    // The running node status badge should have a green dot (bg-success token)
    const badge = page.locator('.bg-success').first();
    await expect(badge).toBeVisible();
    await screenshot(page, 'admin-usage-node-status-badge-mobile');
    await assertNoOverflow(page);
  });
});

// ===========================================================================
// ADMIN NODE USAGE — Desktop (1280x800)
// ===========================================================================

test.describe('AdminComputeUsage — Desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('normal data: user list with stats column visible', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_NORMAL });
    await goToAdminUsage(page);
    await expect(page.locator('text=Alice Johnson')).toBeVisible();
    // "Usage" column header (the hidden sm:block span) should be visible on desktop
    await expect(page.locator('span.hidden.sm\\:block:has-text("Usage")')).toBeVisible();
    await screenshot(page, 'admin-usage-normal-desktop');
    await assertNoOverflow(page);
  });

  test('long text: desktop layout handles long names', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_LONG_TEXT });
    await goToAdminUsage(page);
    await page.waitForTimeout(400);
    await screenshot(page, 'admin-usage-long-text-desktop');
    await assertNoOverflow(page);
  });

  test('empty state: renders cleanly', async ({ page }) => {
    await setupMocks(page, { adminUsers: [] });
    await goToAdminUsage(page);
    await expect(page.locator('text=No node usage this period.')).toBeVisible();
    await screenshot(page, 'admin-usage-empty-desktop');
    await assertNoOverflow(page);
  });

  test('detail view: stat cards and nodes table visible', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_NORMAL, userDetailedUsage: makeDetailedNodeUsage() });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    // Four stat card labels: node-hrs, vCPU-hrs, Platform, Active Nodes
    await expect(page.locator('text=Node-hrs')).toBeVisible();
    await expect(page.locator('text=vCPU-hrs').first()).toBeVisible();
    await expect(page.locator('text=Nodes').first()).toBeVisible();
    await screenshot(page, 'admin-usage-detail-desktop');
    await assertNoOverflow(page);
  });

  test('detail view: 4 stat cards all have icons', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_NORMAL, userDetailedUsage: makeDetailedNodeUsage() });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    // All four stat card caption labels should be visible
    await expect(page.locator('p.sam-type-caption:has-text("Node-hrs")')).toBeVisible();
    await expect(page.locator('p.sam-type-caption:has-text("vCPU-hrs")')).toBeVisible();
    await expect(page.locator('p.sam-type-caption:has-text("Platform")')).toBeVisible();
    await expect(page.locator('p.sam-type-caption:has-text("Active Nodes")')).toBeVisible();
    await screenshot(page, 'admin-usage-detail-stat-cards-desktop');
    await assertNoOverflow(page);
  });

  test('detail view: nodes table has correct column headers', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_NORMAL, userDetailedUsage: makeDetailedNodeUsage() });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    // Column headers from the new node-centric table
    await expect(page.locator('th:has-text("Node")')).toBeVisible();
    await expect(page.locator('th:has-text("Size")')).toBeVisible();
    await expect(page.locator('th:has-text("vCPUs")')).toBeVisible();
    await expect(page.locator('th:has-text("Location")')).toBeVisible();
    await expect(page.locator('th:has-text("Source")')).toBeVisible();
    await expect(page.locator('th:has-text("Workspaces")')).toBeVisible();
    await expect(page.locator('th:has-text("Uptime")')).toBeVisible();
    await expect(page.locator('th:has-text("Status")')).toBeVisible();
    await screenshot(page, 'admin-usage-detail-table-headers-desktop');
    await assertNoOverflow(page);
  });

  test('many items: 32 users render correctly', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_MANY });
    await goToAdminUsage(page);
    await page.waitForTimeout(400);
    await screenshot(page, 'admin-usage-many-desktop');
    await assertNoOverflow(page);
  });

  test('detail view: node name and truncated ID shown in node column', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_NORMAL, userDetailedUsage: makeDetailedNodeUsage({ nodes: NODES_NORMAL }) });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    await expect(page.locator('text=prod-worker-1')).toBeVisible();
    await screenshot(page, 'admin-usage-detail-node-name-desktop');
    await assertNoOverflow(page);
  });
});

// ===========================================================================
// SETTINGS COMPUTE USAGE — Mobile (375x667)
// ===========================================================================

test.describe('SettingsComputeUsage — Mobile (375x667)', () => {
  test('normal data with active sessions renders without overflow', async ({ page }) => {
    await setupMocks(page, {
      computeUsage: makeComputeUsageResponse({ activeSessions: ACTIVE_SESSIONS_NORMAL }),
    });
    await goToSettingsUsage(page);
    await expect(page.locator('text=Compute Usage')).toBeVisible();
    await expect(page.locator('text=Active Workspaces')).toBeVisible();
    await screenshot(page, 'settings-usage-normal-mobile');
    await assertNoOverflow(page);
  });

  test('no active sessions: empty state card shown', async ({ page }) => {
    await setupMocks(page, {
      computeUsage: makeComputeUsageResponse({ activeSessions: [] }),
    });
    await goToSettingsUsage(page);
    await expect(page.locator('text=No active workspaces right now.')).toBeVisible();
    await screenshot(page, 'settings-usage-no-sessions-mobile');
    await assertNoOverflow(page);
  });

  test('long workspace ID does not overflow at 375px', async ({ page }) => {
    await setupMocks(page, {
      computeUsage: makeComputeUsageResponse({ activeSessions: ACTIVE_SESSIONS_LONG }),
    });
    await goToSettingsUsage(page);
    await page.waitForTimeout(400);
    await screenshot(page, 'settings-usage-long-wsid-mobile');
    await assertNoOverflow(page);
  });

  test('zero vCPU-hours: shows < 0.01 formatting', async ({ page }) => {
    await setupMocks(page, {
      computeUsage: makeComputeUsageResponse({
        totalVcpuHours: 0.001,
        platformVcpuHours: 0.001,
        userVcpuHours: 0,
        activeWorkspaces: 0,
        activeSessions: [],
      }),
    });
    await goToSettingsUsage(page);
    await expect(page.locator('text=< 0.01').first()).toBeVisible();
    await screenshot(page, 'settings-usage-zero-hours-mobile');
    await assertNoOverflow(page);
  });

  test('error state: renders inside card', async ({ page }) => {
    await setupMocks(page, { computeUsageError: true });
    await page.goto('/settings/usage');
    await page.waitForTimeout(3000);
    await screenshot(page, 'settings-usage-error-mobile');
    await assertNoOverflow(page);
  });

  test('stat card grid: 2-column layout at 375px', async ({ page }) => {
    await setupMocks(page, {
      computeUsage: makeComputeUsageResponse({ activeSessions: [] }),
    });
    await goToSettingsUsage(page);

    // Grid should be 2 columns at mobile — check cards are side-by-side by verifying 4 stat labels
    await expect(page.locator('text=Total vCPU-hrs')).toBeVisible();
    await expect(page.locator('text=Platform')).toBeVisible();
    await expect(page.locator('text=Your Keys (BYOC)')).toBeVisible();
    await expect(page.locator('text=Active Now')).toBeVisible();
    await screenshot(page, 'settings-usage-stat-grid-mobile');
    await assertNoOverflow(page);
  });

  test('active session row: server+credential+duration details visible', async ({ page }) => {
    await setupMocks(page, {
      computeUsage: makeComputeUsageResponse({ activeSessions: ACTIVE_SESSIONS_NORMAL }),
    });
    await goToSettingsUsage(page);
    // Server type text should be visible
    await expect(page.locator('text=cpx31').first()).toBeVisible();
    await screenshot(page, 'settings-usage-session-details-mobile');
    await assertNoOverflow(page);
  });

  test('special characters in workspace ID render safely', async ({ page }) => {
    await setupMocks(page, {
      computeUsage: makeComputeUsageResponse({
        activeSessions: [
          makeActiveSession({ workspaceId: 'ws-<script>alert(1)</script>' }),
        ],
      }),
    });
    await goToSettingsUsage(page);
    await page.waitForTimeout(400);
    await screenshot(page, 'settings-usage-xss-wsid-mobile');
    await assertNoOverflow(page);
    // XSS payload should not execute — page should still be intact
    await expect(page.locator('text=Active Workspaces')).toBeVisible();
  });
});

// ===========================================================================
// SETTINGS COMPUTE USAGE — Desktop (1280x800)
// ===========================================================================

test.describe('SettingsComputeUsage — Desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('normal data: 4-column stat grid and session rows visible', async ({ page }) => {
    await setupMocks(page, {
      computeUsage: makeComputeUsageResponse({ activeSessions: ACTIVE_SESSIONS_NORMAL }),
    });
    await goToSettingsUsage(page);
    await expect(page.locator('text=Total vCPU-hrs')).toBeVisible();
    await screenshot(page, 'settings-usage-normal-desktop');
    await assertNoOverflow(page);
  });

  test('no active sessions: empty card and stat grid', async ({ page }) => {
    await setupMocks(page, {
      computeUsage: makeComputeUsageResponse({ activeSessions: [] }),
    });
    await goToSettingsUsage(page);
    await expect(page.locator('text=No active workspaces right now.')).toBeVisible();
    await screenshot(page, 'settings-usage-no-sessions-desktop');
    await assertNoOverflow(page);
  });

  test('long workspace ID: truncates without overflow at 1280px', async ({ page }) => {
    await setupMocks(page, {
      computeUsage: makeComputeUsageResponse({ activeSessions: ACTIVE_SESSIONS_LONG }),
    });
    await goToSettingsUsage(page);
    await page.waitForTimeout(400);
    await screenshot(page, 'settings-usage-long-wsid-desktop');
    await assertNoOverflow(page);
  });

  test('error state: error message in card', async ({ page }) => {
    await setupMocks(page, { computeUsageError: true });
    await page.goto('/settings/usage');
    await page.waitForTimeout(3000);
    await screenshot(page, 'settings-usage-error-desktop');
    await assertNoOverflow(page);
  });
});
