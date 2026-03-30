import { test, expect, type Page, type Route } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock Data Factories
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User',
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

function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 'proj-test-1',
    name: 'Test Project',
    repository: 'testuser/test-repo',
    defaultBranch: 'main',
    userId: 'user-test-1',
    githubInstallationId: 'inst-1',
    defaultVmSize: null,
    defaultAgentType: null,
    defaultProvider: null,
    defaultLocation: null,
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
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const MOCK_CATALOG = {
  catalogs: [
    {
      provider: 'hetzner',
      sizes: {
        small: { vcpu: 2, ramGb: 4, price: '$4.51/mo' },
        medium: { vcpu: 4, ramGb: 8, price: '$8.21/mo' },
        large: { vcpu: 8, ramGb: 16, price: '$15.90/mo' },
      },
    },
  ],
};

type CredentialEntry = { provider: string; connected: boolean; id: string };
const CREDS_ONE: CredentialEntry[] = [{ provider: 'hetzner', connected: true, id: 'cred-1' }];
const CREDS_TWO: CredentialEntry[] = [
  { provider: 'hetzner', connected: true, id: 'cred-1' },
  { provider: 'scaleway', connected: true, id: 'cred-2' },
];
const CREDS_THREE: CredentialEntry[] = [
  { provider: 'hetzner', connected: true, id: 'cred-1' },
  { provider: 'scaleway', connected: true, id: 'cred-2' },
  { provider: 'gcp', connected: true, id: 'cred-3' },
];
const CREDS_NONE: CredentialEntry[] = [];

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupMocks(
  page: Page,
  options: {
    projectOverrides?: Record<string, unknown>;
    credentials?: CredentialEntry[];
  } = {}
) {
  const project = makeProject(options.projectOverrides ?? {});
  const credentials = options.credentials ?? CREDS_ONE;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // Auth
    if (path.includes('/api/auth/')) {
      return respond(200, MOCK_USER);
    }

    // Notifications
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }

    // Dashboard
    if (path === '/api/dashboard/active-tasks') {
      return respond(200, { tasks: [] });
    }

    // GitHub
    if (path.startsWith('/api/github')) {
      return respond(200, []);
    }

    // Credentials
    if (path.startsWith('/api/credentials')) {
      return respond(200, credentials);
    }

    // Provider catalog
    if (path.startsWith('/api/nodes/catalog')) {
      return respond(200, MOCK_CATALOG);
    }

    // Nodes
    if (path.startsWith('/api/nodes')) {
      return respond(200, { nodes: [] });
    }

    // Projects list
    if (path === '/api/projects' && method === 'GET') {
      return respond(200, { projects: [project] });
    }

    // Project-scoped routes
    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] ?? '';

      if (subPath === '/runtime-config') {
        return respond(200, { envVars: [], files: [] });
      }
      if (subPath.startsWith('/sessions')) {
        return respond(200, { sessions: [], total: 0 });
      }
      if (subPath.startsWith('/tasks')) {
        return respond(200, { tasks: [], nextCursor: null });
      }
      if (subPath.startsWith('/agent-profiles')) {
        return respond(200, []);
      }
      if (subPath.startsWith('/deployment')) {
        return respond(404, { error: 'Not found' });
      }
      // PATCH for save actions
      if (method === 'PATCH') {
        return respond(200, project);
      }
      // Project detail (GET, no sub-path)
      if (!subPath || subPath === '/') {
        return respond(200, project);
      }
    }

    // Health
    if (path.endsWith('/health')) {
      return respond(200, { status: 'ok' });
    }

    // Catch-all
    return respond(200, {});
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function goToSettings(page: Page) {
  await page.goto('/projects/proj-test-1/settings');
  await page.waitForSelector('text=Scaling & Scheduling', { timeout: 12000 });
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
// MOBILE TESTS — 375x667 (via Playwright config default)
// ===========================================================================

test.describe('ScalingSettings — Mobile (375x667)', () => {
  test('baseline: all-null project, single provider configured', async ({ page }) => {
    await setupMocks(page, { credentials: CREDS_ONE });
    await goToSettings(page);
    await screenshot(page, 'scaling-baseline-mobile');
    await assertNoOverflow(page);
  });

  test('prefilled: provider + location + all scaling params set', async ({ page }) => {
    await setupMocks(page, {
      projectOverrides: {
        defaultProvider: 'hetzner',
        defaultLocation: 'ash',
        taskExecutionTimeoutMs: 7200000,
        maxConcurrentTasks: 3,
        maxDispatchDepth: 2,
        maxSubTasksPerTask: 10,
        warmNodeTimeoutMs: 600000,
        maxWorkspacesPerNode: 4,
        nodeCpuThresholdPercent: 80,
        nodeMemoryThresholdPercent: 75,
        nodeIdleTimeoutMs: 1800000,
      },
      credentials: CREDS_TWO,
    });
    await goToSettings(page);
    await screenshot(page, 'scaling-prefilled-mobile');
    await assertNoOverflow(page);
  });

  test('two providers: dropdown options visible', async ({ page }) => {
    await setupMocks(page, {
      projectOverrides: { defaultProvider: 'scaleway', defaultLocation: 'nl-ams-1' },
      credentials: CREDS_TWO,
    });
    await goToSettings(page);
    await screenshot(page, 'scaling-two-providers-mobile');
    await assertNoOverflow(page);
  });

  test('no providers configured: system picks shown', async ({ page }) => {
    await setupMocks(page, { credentials: CREDS_NONE });
    await goToSettings(page);
    await screenshot(page, 'scaling-no-providers-mobile');
    await assertNoOverflow(page);
  });

  test('three providers with GCP long location label', async ({ page }) => {
    await setupMocks(page, {
      projectOverrides: { defaultProvider: 'gcp', defaultLocation: 'asia-northeast1-a' },
      credentials: CREDS_THREE,
    });
    await goToSettings(page);
    await screenshot(page, 'scaling-long-labels-mobile');
    await assertNoOverflow(page);
  });

  test('removed duplicate sections are absent, renamed section present', async ({ page }) => {
    await setupMocks(page, { credentials: CREDS_TWO });
    await goToSettings(page);

    // "Default Cloud Provider" toggle section was removed from ProjectSettings
    // (canonical control lives in ScalingSettings as a dropdown)
    const duplicateProviderSection = page.locator(
      'text=Default Cloud Provider'
    );
    // ScalingSettings has "Default Provider" (not "Default Cloud Provider")
    // so "Default Cloud Provider" should not appear anywhere on the page
    await expect(duplicateProviderSection).not.toBeVisible();

    // "Compute Lifecycle" was renamed to "Workspace Idle Timeout" after
    // nodeIdleTimeoutMs was removed (it now only has workspaceIdleTimeoutMs)
    await expect(page.locator('text=Compute Lifecycle')).not.toBeVisible();
    await expect(
      page.locator('text=Workspace Idle Timeout')
    ).toBeVisible();

    await screenshot(page, 'scaling-no-duplicates-mobile');
    await assertNoOverflow(page);
  });

  test('reset button appears when value is set', async ({ page }) => {
    await setupMocks(page, {
      projectOverrides: { maxConcurrentTasks: 5, taskExecutionTimeoutMs: 7200000 },
      credentials: CREDS_ONE,
    });
    await goToSettings(page);

    // At least one Reset button should be visible
    const resetBtns = page.locator('button:has-text("Reset")');
    await expect(resetBtns.first()).toBeVisible();

    await screenshot(page, 'scaling-reset-visible-mobile');
    await assertNoOverflow(page);
  });
});

// ===========================================================================
// DESKTOP TESTS — 1280x800
// ===========================================================================

test.describe('ScalingSettings — Desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('baseline: all-null project', async ({ page }) => {
    await setupMocks(page, { credentials: CREDS_ONE });
    await goToSettings(page);
    await screenshot(page, 'scaling-baseline-desktop');
    await assertNoOverflow(page);
  });

  test('prefilled: all params set with Hetzner Nuremberg', async ({ page }) => {
    await setupMocks(page, {
      projectOverrides: {
        defaultProvider: 'hetzner',
        defaultLocation: 'nbg1',
        taskExecutionTimeoutMs: 14400000,
        maxConcurrentTasks: 5,
        maxDispatchDepth: 3,
        maxSubTasksPerTask: 20,
        warmNodeTimeoutMs: 1800000,
        maxWorkspacesPerNode: 6,
        nodeCpuThresholdPercent: 90,
        nodeMemoryThresholdPercent: 85,
        nodeIdleTimeoutMs: 3600000,
      },
      credentials: CREDS_TWO,
    });
    await goToSettings(page);
    await screenshot(page, 'scaling-prefilled-desktop');
    await assertNoOverflow(page);
  });

  test('location dropdown visible when provider is selected', async ({ page }) => {
    await setupMocks(page, {
      projectOverrides: { defaultProvider: 'hetzner', defaultLocation: 'fsn1' },
      credentials: CREDS_TWO,
    });
    await goToSettings(page);
    await expect(page.locator('#scaling-location')).toBeVisible();
    await screenshot(page, 'scaling-location-dropdown-desktop');
    await assertNoOverflow(page);
  });

  test('location dropdown absent when no provider selected', async ({ page }) => {
    await setupMocks(page, {
      projectOverrides: { defaultProvider: null, defaultLocation: null },
      credentials: CREDS_ONE,
    });
    await goToSettings(page);
    await expect(page.locator('#scaling-location')).not.toBeVisible();
    await screenshot(page, 'scaling-no-location-desktop');
    await assertNoOverflow(page);
  });

  test('primary save buttons meet minimum 36px height (size=sm)', async ({ page }) => {
    await setupMocks(page, { credentials: CREDS_ONE });
    await goToSettings(page);

    const saveProvBtn = page.locator('button:has-text("Save Provider & Location")');
    await expect(saveProvBtn).toBeVisible();
    const box = await saveProvBtn.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(36);

    const saveScalingBtn = page.locator('button:has-text("Save Scaling Settings")');
    await expect(saveScalingBtn).toBeVisible();
    const box2 = await saveScalingBtn.boundingBox();
    expect(box2).not.toBeNull();
    expect(box2!.height).toBeGreaterThanOrEqual(36);

    await screenshot(page, 'scaling-touch-targets-desktop');
    await assertNoOverflow(page);
  });
});
