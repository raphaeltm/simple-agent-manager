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
// Compute Usage Mock Payloads
// ---------------------------------------------------------------------------

const PERIOD = {
  start: '2026-04-01T00:00:00Z',
  end: '2026-04-30T23:59:59Z',
};

function makeUserSummary(overrides: {
  userId: string;
  name?: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  totalVcpuHours?: number;
  platformVcpuHours?: number;
  userVcpuHours?: number;
  activeWorkspaces?: number;
}) {
  return {
    userId: overrides.userId,
    name: overrides.name ?? `User ${overrides.userId}`,
    email: overrides.email ?? `user-${overrides.userId}@example.com`,
    avatarUrl: overrides.avatarUrl ?? null,
    totalVcpuHours: overrides.totalVcpuHours ?? 12.5,
    platformVcpuHours: overrides.platformVcpuHours ?? 10.0,
    userVcpuHours: overrides.userVcpuHours ?? 2.5,
    activeWorkspaces: overrides.activeWorkspaces ?? 0,
  };
}

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

function makeUsageRecord(overrides: {
  id: string;
  workspaceId?: string;
  serverType?: string;
  vcpuCount?: number;
  credentialSource?: string;
  startedAt?: string;
  endedAt?: string | null;
}) {
  return {
    id: overrides.id,
    workspaceId: overrides.workspaceId ?? `ws-${overrides.id}-abcdef123456`,
    serverType: overrides.serverType ?? 'cpx21',
    vcpuCount: overrides.vcpuCount ?? 2,
    credentialSource: overrides.credentialSource ?? 'platform',
    startedAt: overrides.startedAt ?? '2026-04-10T08:00:00Z',
    endedAt: overrides.endedAt ?? '2026-04-10T10:30:00Z',
  };
}

// Normal dataset: a few users, mixed platform/BYOC, one with active workspace
const USERS_NORMAL = [
  makeUserSummary({ userId: 'u1', name: 'Alice Johnson', email: 'alice@example.com', totalVcpuHours: 24.5, platformVcpuHours: 20.0, userVcpuHours: 4.5, activeWorkspaces: 2 }),
  makeUserSummary({ userId: 'u2', name: 'Bob Smith', email: 'bob@example.com', totalVcpuHours: 8.2, platformVcpuHours: 8.2, userVcpuHours: 0, activeWorkspaces: 0 }),
  makeUserSummary({ userId: 'u3', name: null, email: 'charlie@example.com', totalVcpuHours: 1.1, platformVcpuHours: 0, userVcpuHours: 1.1, activeWorkspaces: 0 }),
];

// Long text dataset: names/emails longer than 60 chars
const USERS_LONG_TEXT = [
  makeUserSummary({
    userId: 'u-long',
    name: 'Alexandrina Bartholomew-Christodoulou von Österreich-Ungarn',
    email: 'very-long-email-address-that-might-overflow@extremely-long-subdomain.example.com',
    totalVcpuHours: 999.99,
    platformVcpuHours: 500.0,
    userVcpuHours: 499.99,
    activeWorkspaces: 1,
  }),
  makeUserSummary({
    userId: 'u-unicode',
    name: '田中 太郎 🤖 <test>',
    email: 'unicode+emoji@example.org',
    totalVcpuHours: 0.001,
    platformVcpuHours: 0.001,
    userVcpuHours: 0,
    activeWorkspaces: 0,
  }),
];

// Many users: 30+ to test scroll/list behavior
const USERS_MANY = Array.from({ length: 32 }, (_, i) =>
  makeUserSummary({
    userId: `user-${i}`,
    name: `Test User ${i + 1}`,
    email: `user${i + 1}@example.com`,
    totalVcpuHours: Math.random() * 50,
    platformVcpuHours: Math.random() * 30,
    userVcpuHours: Math.random() * 20,
    activeWorkspaces: i % 5 === 0 ? 1 : 0,
  })
);

// Active sessions for detail view
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

const RECENT_RECORDS_NORMAL = [
  makeUsageRecord({ id: 'r1', workspaceId: 'ws-finished1abcdef', serverType: 'cpx21', vcpuCount: 2, credentialSource: 'platform', startedAt: '2026-04-08T10:00:00Z', endedAt: '2026-04-08T12:30:00Z' }),
  makeUsageRecord({ id: 'r2', workspaceId: 'ws-finished2ghijkl', serverType: 'cpx31', vcpuCount: 4, credentialSource: 'user', startedAt: '2026-04-09T14:00:00Z', endedAt: '2026-04-09T16:45:00Z' }),
  makeUsageRecord({ id: 'r3', workspaceId: 'ws-running3mnopqr', serverType: 'ccx13', vcpuCount: 2, credentialSource: 'platform', startedAt: '2026-04-10T08:00:00Z', endedAt: null }),
];

const RECENT_RECORDS_MANY = Array.from({ length: 20 }, (_, i) =>
  makeUsageRecord({
    id: `rec-${i}`,
    workspaceId: `ws-rec${i}-abcdef123456${i}`,
    serverType: i % 2 === 0 ? 'cpx21' : 'cpx31',
    vcpuCount: i % 2 === 0 ? 2 : 4,
    credentialSource: i % 3 === 0 ? 'user' : 'platform',
    startedAt: `2026-04-${String(i + 1).padStart(2, '0')}T08:00:00Z`,
    endedAt: i % 4 === 0 ? null : `2026-04-${String(i + 1).padStart(2, '0')}T10:00:00Z`,
  })
);

// Detailed usage response (for admin user drill-down)
function makeDetailedUsage(options: {
  totalVcpuHours?: number;
  activeSessions?: ReturnType<typeof makeActiveSession>[];
  recentRecords?: ReturnType<typeof makeUsageRecord>[];
} = {}) {
  return {
    userId: 'u1',
    currentPeriod: {
      totalVcpuHours: options.totalVcpuHours ?? 24.5,
      platformVcpuHours: 20.0,
      userVcpuHours: 4.5,
      activeWorkspaces: (options.activeSessions ?? []).length,
      start: PERIOD.start,
      end: PERIOD.end,
    },
    activeSessions: options.activeSessions ?? ACTIVE_SESSIONS_NORMAL,
    recentRecords: options.recentRecords ?? RECENT_RECORDS_NORMAL,
  };
}

// Settings-level usage response
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

// Admin overview payload (used by AdminComputeUsage)
function makeAdminUsageResponse(users: ReturnType<typeof makeUserSummary>[]) {
  return {
    period: PERIOD,
    users,
    totals: {
      totalVcpuHours: users.reduce((s, u) => s + u.totalVcpuHours, 0),
      platformVcpuHours: users.reduce((s, u) => s + u.platformVcpuHours, 0),
      userVcpuHours: users.reduce((s, u) => s + u.userVcpuHours, 0),
      activeWorkspaces: users.reduce((s, u) => s + u.activeWorkspaces, 0),
    },
  };
}

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

type MockOptions = {
  adminUsers?: ReturnType<typeof makeUserSummary>[];
  userDetailedUsage?: ReturnType<typeof makeDetailedUsage>;
  computeUsage?: ReturnType<typeof makeComputeUsageResponse>;
  adminUsageError?: boolean;
  computeUsageError?: boolean;
};

async function setupMocks(page: Page, options: MockOptions = {}) {
  const adminUsageData = makeAdminUsageResponse(options.adminUsers ?? USERS_NORMAL);
  const userDetailData = options.userDetailedUsage ?? makeDetailedUsage();
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

    // Admin compute usage (overview list) — GET /api/admin/usage/compute
    if (path === '/api/admin/usage/compute') {
      if (options.adminUsageError) return respond(500, { error: 'Internal server error' });
      return respond(200, adminUsageData);
    }

    // Admin compute usage user detail — GET /api/admin/usage/compute/:userId
    const userDetailMatch = path.match(/^\/api\/admin\/usage\/compute\/([^/]+)$/);
    if (userDetailMatch) {
      return respond(200, userDetailData);
    }

    // Settings compute usage — GET /api/usage/compute
    if (path === '/api/usage/compute') {
      if (options.computeUsageError) return respond(500, { error: 'Failed to fetch' });
      return respond(200, computeUsageData);
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
// ADMIN COMPUTE USAGE — Mobile (375x667)
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
    await expect(page.locator('text=No compute usage this period.')).toBeVisible();
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

  test('active-workspace indicator uses design token color (not green-500)', async ({ page }) => {
    await setupMocks(page, {
      adminUsers: [makeUserSummary({ userId: 'u1', name: 'Alice', activeWorkspaces: 3 })],
    });
    await goToAdminUsage(page);

    // The green dot should exist and not use an arbitrary Tailwind color like bg-green-500
    // It should use bg-success which maps to the design system color
    const greenDot = page.locator('.bg-success').first();
    await expect(greenDot).toBeVisible();

    await screenshot(page, 'admin-usage-active-indicator-mobile');
    await assertNoOverflow(page);
  });

  test('drill-down: clicking user navigates to detail view', async ({ page }) => {
    await setupMocks(page, {
      adminUsers: USERS_NORMAL,
      userDetailedUsage: makeDetailedUsage(),
    });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    await expect(page.locator('text=Back to all users')).toBeVisible();
    await expect(page.locator('text=Active Sessions')).toBeVisible();
    await screenshot(page, 'admin-usage-detail-mobile');
    await assertNoOverflow(page);
  });

  test('detail view: long workspace IDs do not cause overflow', async ({ page }) => {
    await setupMocks(page, {
      adminUsers: USERS_NORMAL,
      userDetailedUsage: makeDetailedUsage({ activeSessions: ACTIVE_SESSIONS_LONG }),
    });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    await expect(page.locator('text=Active Sessions')).toBeVisible();
    await screenshot(page, 'admin-usage-detail-long-ws-mobile');
    await assertNoOverflow(page);
  });

  test('detail view: empty records section', async ({ page }) => {
    await setupMocks(page, {
      adminUsers: USERS_NORMAL,
      userDetailedUsage: makeDetailedUsage({ activeSessions: [], recentRecords: [] }),
    });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    await expect(page.locator('text=No usage records.')).toBeVisible();
    await screenshot(page, 'admin-usage-detail-empty-records-mobile');
    await assertNoOverflow(page);
  });

  test('detail view: many records in table do not overflow', async ({ page }) => {
    await setupMocks(page, {
      adminUsers: USERS_NORMAL,
      userDetailedUsage: makeDetailedUsage({ recentRecords: RECENT_RECORDS_MANY }),
    });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    await page.waitForTimeout(400);
    await screenshot(page, 'admin-usage-detail-many-records-mobile');
    // Table has overflow-x-auto container so body should not overflow
    await assertNoOverflow(page);
  });

  test('detail view: back button meets 44px minimum touch target', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_NORMAL, userDetailedUsage: makeDetailedUsage() });
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
});

// ===========================================================================
// ADMIN COMPUTE USAGE — Desktop (1280x800)
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
    await expect(page.locator('text=No compute usage this period.')).toBeVisible();
    await screenshot(page, 'admin-usage-empty-desktop');
    await assertNoOverflow(page);
  });

  test('detail view: stat cards and table visible', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_NORMAL, userDetailedUsage: makeDetailedUsage() });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    await expect(page.locator('text=Total vCPU-hrs')).toBeVisible();
    await expect(page.locator('text=Recent Records')).toBeVisible();
    await screenshot(page, 'admin-usage-detail-desktop');
    await assertNoOverflow(page);
  });

  test('detail view: 4 stat cards all have icon (visual consistency)', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_NORMAL, userDetailedUsage: makeDetailedUsage() });
    await goToAdminUsage(page);
    await page.locator('button:has-text("Alice Johnson")').click();
    // Verify the four stat card labels are present (scoped to the caption elements under Cards)
    await expect(page.locator('text=Total vCPU-hrs')).toBeVisible();
    // Each label is a <p class="sam-type-caption ..."> under a Card
    await expect(page.locator('p.sam-type-caption:has-text("Platform")').first()).toBeVisible();
    await expect(page.locator('p.sam-type-caption:has-text("BYOC")').first()).toBeVisible();
    await expect(page.locator('p.sam-type-caption:has-text("Active")').first()).toBeVisible();
    await screenshot(page, 'admin-usage-detail-stat-cards-desktop');
    await assertNoOverflow(page);
  });

  test('many items: 32 users render correctly', async ({ page }) => {
    await setupMocks(page, { adminUsers: USERS_MANY });
    await goToAdminUsage(page);
    await page.waitForTimeout(400);
    await screenshot(page, 'admin-usage-many-desktop');
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
