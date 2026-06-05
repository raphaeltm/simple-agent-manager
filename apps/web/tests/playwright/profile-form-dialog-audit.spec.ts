import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock Data
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

const MOCK_PROJECT = {
  id: 'proj-test-1',
  name: 'Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultProvider: 'hetzner',
  defaultLocation: 'fsn1',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const MOCK_CATALOGS = {
  catalogs: [
    {
      provider: 'hetzner',
      displayName: 'Hetzner Cloud',
      defaultLocation: 'fsn1',
      locations: [
        { id: 'fsn1', name: 'Falkenstein', country: 'DE' },
        { id: 'nbg1', name: 'Nuremberg', country: 'DE' },
      ],
      sizes: {
        small: { type: 'cx22', price: '\u20ac4.35/mo', vcpu: 2, ramGb: 4, storageGb: 40 },
        medium: { type: 'cx32', price: '\u20ac7.69/mo', vcpu: 4, ramGb: 8, storageGb: 80 },
        large: { type: 'cx42', price: '\u20ac14.49/mo', vcpu: 8, ramGb: 16, storageGb: 160 },
      },
    },
  ],
};

/** Fully-loaded profile with custom GitHub CLI policy */
const FULL_PROFILE = {
  id: 'prof-full',
  name: 'Production Implementer',
  description:
    'A heavily configured profile for fast, autonomous task execution with restricted GitHub access',
  projectId: 'proj-test-1',
  userId: 'user-test-1',
  agentType: 'claude-code',
  model: 'claude-sonnet-4-6',
  permissionMode: 'auto-accept',
  systemPromptAppend:
    'Always write tests before implementation. Follow TDD principles. Use the project conventions in CLAUDE.md.',
  maxTurns: 200,
  timeoutMinutes: 120,
  vmSizeOverride: 'medium',
  workspaceProfile: 'full',
  devcontainerConfigName: 'typescript',
  taskMode: 'task',
  provider: null,
  vmLocation: null,
  githubCliPolicy: {
    mode: 'custom',
    repositoryScope: 'project',
    permissions: {
      contents: 'write',
      pullRequests: 'write',
      issues: 'none',
      actions: 'read',
      packages: 'none',
    },
  },
  isBuiltin: false,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
};

/** Profile with inherited (default) GitHub policy */
const INHERIT_PROFILE = {
  ...FULL_PROFILE,
  id: 'prof-inherit',
  name: 'Inherit Profile',
  description: 'Uses inherited GitHub CLI permissions',
  githubCliPolicy: null,
};

const PROFILES = [FULL_PROFILE, INHERIT_PROFILE];

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupApiMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/github/installations') return respond(200, []);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/agents') return respond(200, []);
    if (path.startsWith('/api/credentials')) return respond(200, { credentials: [] });
    // Note: real path is /api/providers/catalog
    if (path === '/api/providers/catalog') return respond(200, MOCK_CATALOGS);

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath.match(/\/agent-profiles\/[^/]+\/runtime\/env-vars$/))
        return respond(200, { envVars: [] });
      if (subPath.match(/\/agent-profiles\/[^/]+\/runtime\/files$/))
        return respond(200, { files: [] });
      if (subPath === '/runtime-config') return respond(200, { envVars: [], files: [] });
      if (subPath.startsWith('/sessions')) return respond(200, { sessions: [], total: 0 });
      if (subPath.startsWith('/tasks')) return respond(200, { tasks: [], total: 0 });
      if (subPath === '/agent-profiles') return respond(200, { items: PROFILES });
      if (subPath.startsWith('/triggers')) return respond(200, { triggers: [] });
      return respond(200, MOCK_PROJECT);
    }

    if (path === '/api/projects') return respond(200, [MOCK_PROJECT]);
    return respond(200, {});
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  const vp = page.viewportSize();
  const vpLabel = vp ? `${vp.width}x${vp.height}` : 'unknown';
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}-${vpLabel}.png`,
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
}

// ---------------------------------------------------------------------------
// Tests — Profile Form Dialog
// ---------------------------------------------------------------------------

/** Scroll the dialog's inner scrollable div and screenshot at each position */
async function screenshotDialog(page: Page, baseName: string) {
  // The Dialog renders: [role="dialog"] > backdrop + panel > div.overflow-y-auto (scrollable)
  const scrollContainer = page.locator('[role="dialog"] .overflow-y-auto');
  await screenshot(page, `${baseName}-top`);

  // Scroll to middle
  await scrollContainer.evaluate((el) => {
    el.scrollTop = el.scrollHeight / 3;
  });
  await screenshot(page, `${baseName}-mid`);

  // Scroll to bottom
  await scrollContainer.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await screenshot(page, `${baseName}-bottom`);
}

async function openDialog(
  page: Page,
  opts: { trigger: string; waitFor: string; screenshotBase: string },
) {
  await setupApiMocks(page);
  await page.goto('/projects/proj-test-1/profiles');
  await page.waitForSelector('text=Production Implementer');
  await page.click(opts.trigger);
  await page.waitForSelector(`text=${opts.waitFor}`);
  await screenshotDialog(page, opts.screenshotBase);
  await assertNoOverflow(page);
}

test.describe('Profile Form Dialog', () => {
  test('create mode — click New Profile to open empty form', async ({ page }) => {
    await openDialog(page, {
      trigger: 'button:has-text("New Profile")',
      waitFor: 'Create Agent Profile',
      screenshotBase: 'profile-form-create',
    });
  });

  test('edit mode — fully loaded profile with custom GitHub CLI policy', async ({ page }) => {
    await openDialog(page, {
      trigger: 'button[aria-label="Edit Production Implementer"]',
      waitFor: 'Edit Profile',
      screenshotBase: 'profile-form-edit-custom',
    });
  });

  test('edit mode — profile with inherited GitHub policy', async ({ page }) => {
    await openDialog(page, {
      trigger: 'button[aria-label="Edit Inherit Profile"]',
      waitFor: 'Edit Profile',
      screenshotBase: 'profile-form-edit-inherit',
    });
  });
});
