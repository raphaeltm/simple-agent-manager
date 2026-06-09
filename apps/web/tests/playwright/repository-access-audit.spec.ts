import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, setupAuditRoutes } from './audit-helpers';

// ---------------------------------------------------------------------------
// Mock Data Factories
// ---------------------------------------------------------------------------

const MOCK_USER = makeMockUser({
  userId: 'user-test-1',
  sessionId: 'session-test-1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'superadmin',
});

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

  // Exact-path fixtures for top-level collection endpoints.
  const exactFixtures: Record<string, unknown> = {
    '/api/dashboard/active-tasks': { tasks: [] },
    '/api/agents': { agents: [] },
    '/api/credentials/agent': { credentials: [] },
    '/api/providers/catalog': MOCK_CATALOG,
    '/api/projects': { projects: [project] },
  };

  // Prefix fixtures, evaluated top-down (first match wins). Order matters:
  // `/api/nodes/catalog` precedes `/api/nodes`, and `/api/credentials/agent`
  // is resolved by the exact table above before the broader credentials prefix.
  const prefixFixtures: Array<[string, unknown]> = [
    ['/api/auth/', MOCK_USER],
    ['/api/notifications', { notifications: [], unreadCount: 0 }],
    ['/api/github', []],
    ['/api/nodes/catalog', MOCK_CATALOG],
    ['/api/credentials', [{ provider: 'hetzner', connected: true, id: 'cred-1' }]],
    ['/api/nodes', { nodes: [] }],
  ];

  await setupAuditRoutes(page, (path, respond) => {
    if (path in exactFixtures) return respond(200, exactFixtures[path]);
    for (const [prefix, body] of prefixFixtures) {
      if (path.startsWith(prefix)) return respond(200, body);
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] ?? '';
      if (subPath === '/repository-access/available') {
        return options.availableError
          ? respond(500, { error: 'boom' })
          : respond(200, { repositories: available });
      }
      if (subPath === '/repository-access') {
        return respond(200, { primaryRepository: project.repository, repositories });
      }
      if (subPath === '/repository-access/discover') return respond(200, { suggestions: [] });
      if (subPath === '/runtime-config') return respond(200, { envVars: [], files: [] });
      if (subPath.startsWith('/sessions')) return respond(200, { sessions: [], total: 0 });
      if (subPath.startsWith('/tasks')) return respond(200, { tasks: [], nextCursor: null });
      if (subPath.startsWith('/agent-profiles')) return respond(200, []);
      if (subPath === '/credentials') return respond(200, { credentials: [] });
      if (subPath.startsWith('/deployment')) return respond(404, { error: 'Not found' });
      // Project detail (GET) and settings save (PATCH) both echo the project.
      return respond(200, project);
    }

    if (path.endsWith('/health')) return respond(200, { status: 'ok' });
    return undefined;
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

async function typeInCombobox(page: Page, value: string) {
  await page.getByLabel('Additional repository').fill(value);
  await page.waitForTimeout(200);
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
    await typeInCombobox(page, 'other/repo');
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
    await typeInCombobox(page, 'bet');
    await expect(page.getByText('acme/beta')).toBeVisible();
    await expect(page.getByText('acme/alpha')).not.toBeVisible();
    await screenshot(page, 'repo-access-filtered-desktop');
    await assertNoOverflow(page);
  });
});
