import { expect, type Page, type Route, test } from '@playwright/test';

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
    repoProvider: 'github',
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

type AvailableRepository = {
  repository: string;
  githubRepoId: number;
  githubRepoNodeId: string | null;
  private: boolean;
};

function repo(repository: string, isPrivate = true, id = 1): AvailableRepository {
  return { repository, githubRepoId: id, githubRepoNodeId: null, private: isPrivate };
}

const AVAILABLE_FEW: AvailableRepository[] = [
  repo('acme/alpha', false, 1),
  repo('acme/beta', true, 2),
  repo('acme/gamma', true, 3),
];

// Stress: many repos + very long owner/repo names to catch overflow/clipping.
const AVAILABLE_MANY: AvailableRepository[] = [
  repo(
    'really-long-organization-name-that-keeps-going/an-extremely-long-repository-name-that-should-truncate-cleanly',
    true,
    100
  ),
  ...Array.from({ length: 30 }, (_, i) => repo(`acme/service-${i}`, i % 2 === 0, 200 + i)),
];

const ACTIVE_REPOSITORIES = [
  {
    id: 'pr-1',
    repository: 'acme/shared-lib',
    status: 'active' as const,
  },
  {
    id: 'pr-2',
    repository: 'acme/legacy-with-a-very-long-name-that-needs-to-truncate-in-the-row',
    status: 'access-revoked' as const,
  },
];

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupMocks(
  page: Page,
  options: {
    projectOverrides?: Record<string, unknown>;
    available?: AvailableRepository[];
    repositories?: Array<{ id: string; repository: string; status: string }>;
    availableError?: boolean;
  } = {}
) {
  const project = makeProject(options.projectOverrides ?? {});
  const available = options.available ?? AVAILABLE_FEW;
  const repositories = options.repositories ?? [];

  // Suppress the first-visit onboarding overlay (it auto-opens when agent/cloud/
  // GitHub setup is incomplete and would occlude the entire settings page).
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-user-test-1', 'true')
  );

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) {
      return respond(200, MOCK_USER);
    }
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }
    if (path === '/api/dashboard/active-tasks') {
      return respond(200, { tasks: [] });
    }
    if (path.startsWith('/api/github')) {
      return respond(200, []);
    }
    if (path === '/api/agents') {
      return respond(200, { agents: [] });
    }
    if (path === '/api/credentials/agent') {
      return respond(200, { credentials: [] });
    }
    if (path.startsWith('/api/credentials')) {
      return respond(200, [{ provider: 'hetzner', connected: true, id: 'cred-1' }]);
    }
    if (path.startsWith('/api/nodes/catalog') || path === '/api/providers/catalog') {
      return respond(200, {
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
      });
    }
    if (path.startsWith('/api/nodes')) {
      return respond(200, { nodes: [] });
    }
    if (path === '/api/projects' && method === 'GET') {
      return respond(200, { projects: [project] });
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] ?? '';

      if (subPath === '/repository-access/available') {
        if (options.availableError) {
          return respond(500, { error: 'boom' });
        }
        return respond(200, { repositories: available });
      }
      if (subPath === '/repository-access') {
        return respond(200, {
          primaryRepository: project.repository,
          repositories,
        });
      }
      if (subPath === '/repository-access/discover') {
        return respond(200, { suggestions: [] });
      }
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
      if (subPath === '/credentials') {
        return respond(200, { credentials: [] });
      }
      if (subPath.startsWith('/deployment')) {
        return respond(404, { error: 'Not found' });
      }
      if (method === 'PATCH') {
        return respond(200, project);
      }
      if (!subPath || subPath === '/') {
        return respond(200, project);
      }
    }

    if (path.endsWith('/health')) {
      return respond(200, { status: 'ok' });
    }

    return respond(200, {});
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function goToSettings(page: Page) {
  await page.goto('/projects/proj-test-1/settings');
  await page.waitForSelector('text=Repository Access', { timeout: 12000 });
}

async function openCombobox(page: Page) {
  await page.getByLabel('Additional repository').focus();
  // Wait for the lazy intersection load to render options.
  await page.waitForTimeout(400);
}

async function screenshot(page: Page, name: string) {
  // The SAM app shell scrolls inside an inner container, so the document never
  // scrolls and `fullPage` only captures the page top. Scroll the combobox into
  // the inner container's viewport and capture the viewport region instead so
  // the Repository Access surface (and any open dropdown overlay) is visible.
  await page.getByLabel('Additional repository').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
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
// MOBILE TESTS — 375x667 (Playwright config default)
// ===========================================================================

test.describe('RepositoryAccess combobox — Mobile (375x667)', () => {
  test('closed combobox baseline, no additional repos', async ({ page }) => {
    await setupMocks(page);
    await goToSettings(page);
    await expect(page.getByLabel('Additional repository')).toBeVisible();
    await screenshot(page, 'repo-access-closed-mobile');
    await assertNoOverflow(page);
  });

  test('open combobox shows intersection with badges', async ({ page }) => {
    await setupMocks(page, { available: AVAILABLE_FEW });
    await goToSettings(page);
    await openCombobox(page);
    await expect(page.getByText('acme/alpha')).toBeVisible();
    await expect(page.getByText('public')).toBeVisible();
    await screenshot(page, 'repo-access-open-mobile');
    await assertNoOverflow(page);
  });

  test('open combobox with many + very long repo names', async ({ page }) => {
    await setupMocks(page, { available: AVAILABLE_MANY });
    await goToSettings(page);
    await openCombobox(page);
    await screenshot(page, 'repo-access-many-long-mobile');
    await assertNoOverflow(page);
  });

  test('manual entry offered for owner/repo not in list', async ({ page }) => {
    await setupMocks(page, { available: AVAILABLE_FEW });
    await goToSettings(page);
    await openCombobox(page);
    await page.getByLabel('Additional repository').fill('other/repo');
    await page.waitForTimeout(200);
    await expect(page.getByText('other/repo')).toBeVisible();
    await screenshot(page, 'repo-access-manual-entry-mobile');
    await assertNoOverflow(page);
  });

  test('empty intersection shows guidance', async ({ page }) => {
    await setupMocks(page, { available: [] });
    await goToSettings(page);
    await openCombobox(page);
    await expect(
      page.getByText('No additional repositories available through this installation.')
    ).toBeVisible();
    await screenshot(page, 'repo-access-empty-mobile');
    await assertNoOverflow(page);
  });

  test('error state shows retry', async ({ page }) => {
    await setupMocks(page, { availableError: true });
    await goToSettings(page);
    await openCombobox(page);
    await expect(page.getByText('Retry')).toBeVisible();
    await screenshot(page, 'repo-access-error-mobile');
    await assertNoOverflow(page);
  });

  test('existing additional repos render with status badges', async ({ page }) => {
    await setupMocks(page, { repositories: ACTIVE_REPOSITORIES });
    await goToSettings(page);
    await expect(page.getByText('acme/shared-lib')).toBeVisible();
    await screenshot(page, 'repo-access-existing-rows-mobile');
    await assertNoOverflow(page);
  });
});

// ===========================================================================
// DESKTOP TESTS — 1280x800
// ===========================================================================

test.describe('RepositoryAccess combobox — Desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('open combobox baseline', async ({ page }) => {
    await setupMocks(page, { available: AVAILABLE_FEW });
    await goToSettings(page);
    await openCombobox(page);
    await expect(page.getByText('acme/beta')).toBeVisible();
    await screenshot(page, 'repo-access-open-desktop');
    await assertNoOverflow(page);
  });

  test('many + long repo names do not overflow', async ({ page }) => {
    await setupMocks(page, { available: AVAILABLE_MANY });
    await goToSettings(page);
    await openCombobox(page);
    await screenshot(page, 'repo-access-many-long-desktop');
    await assertNoOverflow(page);
  });

  test('filtering narrows the list as the user types', async ({ page }) => {
    await setupMocks(page, { available: AVAILABLE_FEW });
    await goToSettings(page);
    await openCombobox(page);
    await page.getByLabel('Additional repository').fill('bet');
    await page.waitForTimeout(200);
    await expect(page.getByText('acme/beta')).toBeVisible();
    await expect(page.getByText('acme/alpha')).not.toBeVisible();
    await screenshot(page, 'repo-access-filtered-desktop');
    await assertNoOverflow(page);
  });
});
