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

const SHORT_PROJECT = {
  id: 'proj-test-1',
  name: 'My Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const LONG_NAME_PROJECT = {
  ...SHORT_PROJECT,
  name: 'This Is An Extremely Long Project Name That Should Be Truncated In The Navigation',
};

const MOCK_SESSIONS: unknown[] = [];
const MOCK_TASKS: unknown[] = [];

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupApiMocks(
  page: Page,
  options: { project?: typeof SHORT_PROJECT } = {},
) {
  const project = options.project ?? SHORT_PROJECT;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // Auth — match all auth endpoints
    if (path.includes('/api/auth/')) {
      return respond(200, MOCK_USER);
    }

    // Sessions list
    if (path.match(/^\/api\/projects\/[^/]+\/sessions/)) {
      return respond(200, { sessions: MOCK_SESSIONS, total: 0 });
    }

    // Tasks list
    if (path.match(/^\/api\/projects\/[^/]+\/tasks/)) {
      return respond(200, { tasks: MOCK_TASKS, nextCursor: null });
    }

    // Project activity
    if (path.match(/^\/api\/projects\/[^/]+\/activity/)) {
      return respond(200, []);
    }

    // Project detail
    if (path.match(/^\/api\/projects\/[^/]+$/) && route.request().method() === 'GET') {
      return respond(200, project);
    }

    // Notifications
    if (path.includes('/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }

    // Agent profiles (returns { items: [...] })
    if (path.match(/^\/api\/projects\/[^/]+\/agent-profiles/)) {
      return respond(200, { items: [] });
    }

    // Credentials (returns plain array)
    if (path === '/api/credentials') {
      return respond(200, []);
    }

    // Agent credentials
    if (path.includes('/credentials/agent')) {
      return respond(200, { credentials: [] });
    }

    // Dashboard active tasks
    if (path === '/api/dashboard/active-tasks') {
      return respond(200, { tasks: [] });
    }

    // GitHub installations
    if (path === '/api/github/installations') {
      return respond(200, []);
    }

    // Agents (returns { agents: [...] })
    if (path === '/api/agents') {
      return respond(200, { agents: [] });
    }

    // Projects list
    if (path === '/api/projects') {
      return respond(200, { projects: [project] });
    }

    // Runtime config
    if (path.includes('/runtime-config')) {
      return respond(200, { envVars: [], files: [] });
    }

    // Default fallback — log unhandled routes for debugging
    return respond(200, {});
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
}

// ---------------------------------------------------------------------------
// Mobile Tests (375x667 — default from Playwright config)
// ---------------------------------------------------------------------------

test.describe('Nav Toggle — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });

  test('project nav shows toggle button instead of link', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Debug: screenshot before clicking hamburger
    await screenshot(page, 'nav-toggle-debug-before-hamburger');

    // Open mobile drawer
    await page.click('[aria-label="Open navigation menu"]');
    await page.waitForTimeout(300);

    // Should see "Back to Projects" as toggle button, not a navigation link
    const toggleBtn = page.getByTestId('mobile-nav-toggle');
    await expect(toggleBtn).toBeVisible();
    await expect(toggleBtn).toHaveText(/Back to Projects/);

    // Should see project nav items
    const chatBtn = page.getByRole('button', { name: 'Chat' });
    await expect(chatBtn).toBeVisible();

    await screenshot(page, 'nav-toggle-mobile-project-view');
    await assertNoHorizontalOverflow(page);
  });

  test('toggle switches to global nav', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(500);

    // Open mobile drawer
    await page.click('[aria-label="Open navigation menu"]');
    await page.waitForTimeout(300);

    // Click toggle to show global nav
    const toggleBtn = page.getByTestId('mobile-nav-toggle');
    await toggleBtn.click();
    await page.waitForTimeout(300);

    // Should now show "Back to [Project Name]"
    await expect(toggleBtn).toHaveText(/Back to My Project/);

    // Should see global nav items
    const homeBtn = page.getByRole('button', { name: 'Home' });
    await expect(homeBtn).toBeVisible();
    const projectsBtn = page.getByRole('button', { name: 'Projects' });
    await expect(projectsBtn).toBeVisible();
    const settingsBtn = page.getByTestId('mobile-nav-panel').getByRole('button', { name: 'Settings' });
    await expect(settingsBtn).toBeVisible();

    await screenshot(page, 'nav-toggle-mobile-global-view');
    await assertNoHorizontalOverflow(page);
  });

  test('toggle back to project nav', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(500);

    // Open drawer, toggle to global, then toggle back
    await page.click('[aria-label="Open navigation menu"]');
    await page.waitForTimeout(300);

    const toggleBtn = page.getByTestId('mobile-nav-toggle');
    await toggleBtn.click();
    await page.waitForTimeout(300);

    // Now toggle back
    await toggleBtn.click();
    await page.waitForTimeout(300);

    // Should show project nav again
    await expect(toggleBtn).toHaveText(/Back to Projects/);
    const chatBtn = page.getByRole('button', { name: 'Chat' });
    await expect(chatBtn).toBeVisible();

    await screenshot(page, 'nav-toggle-mobile-back-to-project');
    await assertNoHorizontalOverflow(page);
  });

  test('global nav item navigates away', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(500);

    // Open drawer, toggle to global nav
    await page.click('[aria-label="Open navigation menu"]');
    await page.waitForTimeout(300);
    await page.getByTestId('mobile-nav-toggle').click();
    await page.waitForTimeout(300);

    // Click "Home" global nav item
    await page.getByRole('button', { name: 'Home' }).click();
    await page.waitForTimeout(500);

    // Should have navigated to /dashboard
    expect(page.url()).toContain('/dashboard');

    await screenshot(page, 'nav-toggle-mobile-navigated-to-home');
  });

  test('long project name truncates correctly', async ({ page }) => {
    await setupApiMocks(page, { project: LONG_NAME_PROJECT });
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(500);

    // Open drawer
    await page.click('[aria-label="Open navigation menu"]');
    await page.waitForTimeout(300);

    // Toggle to global nav to see "Back to [long name]"
    await page.getByTestId('mobile-nav-toggle').click();
    await page.waitForTimeout(300);

    // The toggle button text should be truncated, not overflowing
    const toggleBtn = page.getByTestId('mobile-nav-toggle');
    await expect(toggleBtn).toBeVisible();

    await screenshot(page, 'nav-toggle-mobile-long-name');
    await assertNoHorizontalOverflow(page);
  });

  test('non-project pages show normal nav (no toggle)', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/dashboard');
    await page.waitForTimeout(500);

    // Open drawer
    await page.click('[aria-label="Open navigation menu"]');
    await page.waitForTimeout(300);

    // Should NOT have toggle button
    const toggleBtn = page.getByTestId('mobile-nav-toggle');
    await expect(toggleBtn).not.toBeVisible();

    // Should show global nav items directly
    const homeBtn = page.getByRole('button', { name: 'Home' });
    await expect(homeBtn).toBeVisible();

    await screenshot(page, 'nav-toggle-mobile-global-page-no-toggle');
    await assertNoHorizontalOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Desktop Tests (1280x800)
// ---------------------------------------------------------------------------

test.describe('Nav Toggle — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('project sidebar shows toggle button instead of link', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(500);

    // Should see "Back to Projects" button in the sidebar
    const backBtn = page.getByRole('button', { name: 'Show global navigation' });
    await expect(backBtn).toBeVisible();

    // Should see project nav items
    const chatLink = page.getByRole('link', { name: 'Chat' });
    await expect(chatLink).toBeVisible();

    await screenshot(page, 'nav-toggle-desktop-project-view');
    await assertNoHorizontalOverflow(page);
  });

  test('toggle switches to global nav on desktop', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(500);

    // Click toggle
    const backBtn = page.getByRole('button', { name: 'Show global navigation' });
    await backBtn.click();
    await page.waitForTimeout(300);

    // Should now show global nav items
    const homeLink = page.getByRole('link', { name: 'Home' });
    await expect(homeLink).toBeVisible();
    const projectsLink = page.getByRole('link', { name: 'Projects' });
    await expect(projectsLink).toBeVisible();

    // Should see "Back to [Project Name]" button
    const backToProject = page.getByRole('button', { name: /Back to My Project/ });
    await expect(backToProject).toBeVisible();

    await screenshot(page, 'nav-toggle-desktop-global-view');
    await assertNoHorizontalOverflow(page);
  });

  test('toggle back to project nav on desktop', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(500);

    // Toggle to global
    await page.getByRole('button', { name: 'Show global navigation' }).click();
    await page.waitForTimeout(300);

    // Toggle back to project
    await page.getByRole('button', { name: /Back to My Project/ }).click();
    await page.waitForTimeout(300);

    // Should show project nav again
    const chatLink = page.getByRole('link', { name: 'Chat' });
    await expect(chatLink).toBeVisible();

    await screenshot(page, 'nav-toggle-desktop-back-to-project');
    await assertNoHorizontalOverflow(page);
  });

  test('long project name truncates on desktop', async ({ page }) => {
    await setupApiMocks(page, { project: LONG_NAME_PROJECT });
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(500);

    // Toggle to global to see long name in button
    await page.getByRole('button', { name: 'Show global navigation' }).click();
    await page.waitForTimeout(300);

    await screenshot(page, 'nav-toggle-desktop-long-name');
    await assertNoHorizontalOverflow(page);
  });

  test('non-project pages show normal sidebar (no toggle)', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/dashboard');
    await page.waitForTimeout(500);

    // Should see global nav items directly (no toggle)
    const homeLink = page.getByRole('link', { name: 'Home' });
    await expect(homeLink).toBeVisible();

    // Should NOT have a toggle button
    const toggleBtn = page.getByRole('button', { name: 'Show global navigation' });
    await expect(toggleBtn).not.toBeVisible();

    await screenshot(page, 'nav-toggle-desktop-global-page');
    await assertNoHorizontalOverflow(page);
  });

  test('global nav item navigates away on desktop', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(500);

    // Toggle to global nav
    await page.getByRole('button', { name: 'Show global navigation' }).click();
    await page.waitForTimeout(300);

    // Click "Settings" in global nav
    await page.getByRole('link', { name: 'Settings' }).click();
    await page.waitForTimeout(500);

    // Should have navigated to /settings
    expect(page.url()).toContain('/settings');

    await screenshot(page, 'nav-toggle-desktop-navigated-to-settings');
  });
});
