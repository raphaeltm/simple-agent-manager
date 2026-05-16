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

const NOW = Date.now();

/** SessionSummaryItem shape — matches the new D1-backed API response. */
interface SessionOverrides {
  id: string;
  topic?: string | null;
  status?: string;
  agentCompletedAt?: number | null;
  lastMessageAt?: number;
  projectId?: string;
  projectName?: string;
}

function makeSession(overrides: SessionOverrides) {
  const lastMessageAt = overrides.lastMessageAt ?? NOW - 30000;
  return {
    id: overrides.id,
    projectId: overrides.projectId ?? 'proj-1',
    projectName: overrides.projectName ?? 'Backend API',
    userId: 'user-test-1',
    status: overrides.status ?? 'active',
    topic: overrides.topic ?? null,
    taskId: null,
    workspaceId: null,
    messageCount: 5,
    startedAt: lastMessageAt - 60000,
    lastMessageAt,
    agentCompletedAt: overrides.agentCompletedAt ?? null,
    endedAt: overrides.status === 'stopped' ? lastMessageAt : null,
    updatedAt: lastMessageAt,
  };
}

const NORMAL_SESSIONS = [
  makeSession({ id: 's1', topic: 'Fix authentication flow', status: 'active', lastMessageAt: NOW - 60000, projectId: 'proj-1', projectName: 'Backend API' }),
  makeSession({ id: 's2', topic: 'Add user dashboard', status: 'active', agentCompletedAt: NOW - 300000, lastMessageAt: NOW - 300000, projectId: 'proj-1', projectName: 'Backend API' }),
  makeSession({ id: 's3', topic: 'Refactor component library', status: 'active', lastMessageAt: NOW - 120000, projectId: 'proj-2', projectName: 'Frontend App' }),
  makeSession({ id: 's4', topic: null, status: 'active', lastMessageAt: NOW - 900000, projectId: 'proj-2', projectName: 'Frontend App' }),
  makeSession({ id: 's5', topic: 'Terraform modules update', status: 'active', lastMessageAt: NOW - 180000, projectId: 'proj-3', projectName: 'Infrastructure' }),
];

const LONG_TEXT_SESSIONS = [
  makeSession({
    id: 'lt1',
    topic: 'This is an extremely long chat topic that should definitely be truncated because it contains way too many words and characters to fit in a single line without breaking the layout or causing horizontal scroll issues',
    status: 'active',
    lastMessageAt: NOW - 60000,
    projectId: 'proj-1',
    projectName: 'Backend API',
  }),
  makeSession({
    id: 'lt2',
    topic: 'Fix: handling of special characters like <script>alert("xss")</script> & "quotes" and 日本語テキスト',
    status: 'active',
    agentCompletedAt: NOW - 120000,
    lastMessageAt: NOW - 120000,
    projectId: 'proj-1',
    projectName: 'Backend API',
  }),
  makeSession({
    id: 'lt3',
    topic: 'x'.repeat(500),
    status: 'active',
    lastMessageAt: NOW - 180000,
    projectId: 'proj-2',
    projectName: 'Frontend App',
  }),
];

const MANY_SESSIONS = [
  ...Array.from({ length: 10 }, (_, i) =>
    makeSession({
      id: `many-1-${i}`,
      topic: `Backend task ${i + 1}: ${['Fix API endpoint', 'Add middleware', 'Optimize queries', 'Update schema', 'Add tests'][i % 5]}`,
      status: 'active',
      agentCompletedAt: i % 3 === 0 ? NOW - i * 60000 : null,
      lastMessageAt: NOW - i * 60000,
      projectId: 'proj-1',
      projectName: 'Backend API',
    }),
  ),
  ...Array.from({ length: 10 }, (_, i) =>
    makeSession({
      id: `many-2-${i}`,
      topic: `Frontend task ${i + 1}: ${['Fix layout', 'Add animation', 'Refactor hooks', 'Add dark mode', 'Update styles'][i % 5]}`,
      status: 'active',
      lastMessageAt: NOW - (i + 10) * 60000,
      projectId: 'proj-2',
      projectName: 'Frontend App',
    }),
  ),
  ...Array.from({ length: 10 }, (_, i) =>
    makeSession({
      id: `many-3-${i}`,
      topic: `Infra task ${i + 1}`,
      status: 'active',
      lastMessageAt: NOW - (i + 20) * 60000,
      projectId: 'proj-3',
      projectName: 'Infrastructure',
    }),
  ),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupApiMocks(
  page: Page,
  options: {
    sessions?: ReturnType<typeof makeSession>[];
    error?: boolean;
    noProjects?: boolean;
  },
) {
  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();

    if (url.includes('/api/auth/')) {
      return route.fulfill({ json: MOCK_USER });
    }

    if (url.includes('/api/notifications')) {
      return route.fulfill({ json: { notifications: [], total: 0 } });
    }

    // New D1-backed recent-chats endpoint (used by useRecentChats / dropdown)
    if (url.includes('/api/chats/recent')) {
      if (options.error) {
        return route.fulfill({ status: 500, json: { error: 'Server error' } });
      }
      if (options.noProjects) {
        return route.fulfill({ json: { sessions: [], totalActive: 0 } });
      }
      const sessions = (options.sessions ?? []).filter(
        (s) => s.status !== 'stopped' && s.status !== 'failed',
      );
      return route.fulfill({ json: { sessions, totalActive: sessions.length } });
    }

    // New D1-backed all-chats endpoint (used by useAllChatSessions on /chats page)
    if (url.includes('/api/chats')) {
      if (options.error) {
        return route.fulfill({ status: 500, json: { error: 'Server error' } });
      }
      const sessions = options.sessions ?? [];
      return route.fulfill({ json: { sessions, total: sessions.length } });
    }

    return route.fulfill({ status: 200, json: {} });
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

/** Opens the Recent Chats dropdown and returns a locator scoped to the dialog panel. */
async function openDropdown(page: Page) {
  const btn = page.getByLabel(/Recent chats/);
  await btn.click();
  const dialog = page.locator('[aria-label="Recent chats"][role="menu"]');
  await dialog.waitFor({ state: 'visible', timeout: 3000 });
  await page.waitForTimeout(300);
  return dialog;
}

// ---------------------------------------------------------------------------
// Mobile Tests (default viewport from config — 375x667)
// ---------------------------------------------------------------------------

test.describe('Recent Chats Dropdown — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('normal data — dropdown shows recent chats', async ({ page }) => {
    await setupApiMocks(page, { sessions: NORMAL_SESSIONS });
    await page.goto('/chats');
    await page.waitForTimeout(800);

    // Button should be visible
    const btn = page.getByLabel(/Recent chats/);
    await expect(btn).toBeVisible();

    // Open dropdown first (triggers data fetch), then verify badge
    const dialog = await openDropdown(page);

    // Badge should now be visible with active count (data loaded)
    const badge = page.getByLabel(/Recent chats \(\d+ active\)/).locator('span');
    await expect(badge.first()).toBeVisible();
    await screenshot(page, 'recent-chats-normal-mobile');

    // Verify no horizontal overflow
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);

    // Verify chat items are visible within the dropdown (scoped)
    await expect(dialog.getByText('Fix authentication flow')).toBeVisible();
    await expect(dialog.getByText('Refactor component library')).toBeVisible();
    await expect(dialog.getByText('Backend API').first()).toBeVisible();
    await expect(dialog.getByText('Frontend App').first()).toBeVisible();
  });

  test('long text wraps correctly', async ({ page }) => {
    await setupApiMocks(page, { sessions: LONG_TEXT_SESSIONS });
    await page.goto('/chats');
    await page.waitForTimeout(800);

    await openDropdown(page);
    await screenshot(page, 'recent-chats-long-text-mobile');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test('empty state — no active chats', async ({ page }) => {
    await setupApiMocks(page, { sessions: [] });
    await page.goto('/chats');
    await page.waitForTimeout(800);

    const dialog = await openDropdown(page);
    await screenshot(page, 'recent-chats-empty-mobile');

    // Scope to dialog to avoid matching the Chats page empty state
    await expect(dialog.getByText('No active chats')).toBeVisible();
    await expect(dialog.getByText('Start a conversation in any project')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test('many items — scroll behavior', async ({ page }) => {
    await setupApiMocks(page, { sessions: MANY_SESSIONS });
    await page.goto('/chats');
    await page.waitForTimeout(800);

    const dialog = await openDropdown(page);
    await screenshot(page, 'recent-chats-many-items-mobile');

    // Should show the "View all chats" footer within the dropdown
    await expect(dialog.getByText('View all chats')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test('error state', async ({ page }) => {
    await setupApiMocks(page, { error: true });
    await page.goto('/chats');
    await page.waitForTimeout(800);

    const dialog = await openDropdown(page);
    await screenshot(page, 'recent-chats-error-mobile');

    await expect(dialog.getByText('Failed to load chats')).toBeVisible();
    await expect(dialog.getByText('Retry')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test('no projects — empty state', async ({ page }) => {
    await setupApiMocks(page, { noProjects: true });
    await page.goto('/chats');
    await page.waitForTimeout(800);

    const dialog = await openDropdown(page);
    await screenshot(page, 'recent-chats-no-projects-mobile');

    await expect(dialog.getByText('No active chats')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test('close on escape', async ({ page }) => {
    await setupApiMocks(page, { sessions: NORMAL_SESSIONS });
    await page.goto('/chats');
    await page.waitForTimeout(800);

    await openDropdown(page);
    const dialogLocator = page.locator('[aria-label="Recent chats"][role="menu"]');
    await expect(dialogLocator).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(dialogLocator).not.toBeVisible();
  });

  test('close on click outside', async ({ page }) => {
    await setupApiMocks(page, { sessions: NORMAL_SESSIONS });
    await page.goto('/chats');
    await page.waitForTimeout(800);

    await openDropdown(page);
    const menuLocator = page.locator('[aria-label="Recent chats"][role="menu"]');
    await expect(menuLocator).toBeVisible();

    // Click outside the dropdown
    await page.mouse.click(10, 10);
    await page.waitForTimeout(300);
    await expect(menuLocator).not.toBeVisible();
  });

  test('clicking a chat navigates away', async ({ page }) => {
    await setupApiMocks(page, { sessions: NORMAL_SESSIONS });
    await page.goto('/chats');
    await page.waitForTimeout(800);

    const dialog = await openDropdown(page);

    // Click the first chat item within the dropdown dialog
    await dialog.getByText('Fix authentication flow').click();
    await page.waitForTimeout(300);

    // Should have navigated — dropdown should be closed
    await expect(page.locator('[aria-label="Recent chats"][role="menu"]')).not.toBeVisible();
    // URL should reflect the chat navigation
    expect(page.url()).toContain('/projects/proj-1/chat/s1');
  });
});

// ---------------------------------------------------------------------------
// Desktop Tests
// ---------------------------------------------------------------------------

test.describe('Recent Chats Dropdown — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('normal data — dropdown in sidebar', async ({ page }) => {
    await setupApiMocks(page, { sessions: NORMAL_SESSIONS });
    await page.goto('/chats');
    await page.waitForTimeout(800);

    const dialog = await openDropdown(page);
    await screenshot(page, 'recent-chats-normal-desktop');

    await expect(dialog.getByText('Fix authentication flow')).toBeVisible();
    await expect(dialog.getByText('Recent Chats')).toBeVisible();
  });

  test('long text', async ({ page }) => {
    await setupApiMocks(page, { sessions: LONG_TEXT_SESSIONS });
    await page.goto('/chats');
    await page.waitForTimeout(800);

    await openDropdown(page);
    await screenshot(page, 'recent-chats-long-text-desktop');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test('empty state', async ({ page }) => {
    await setupApiMocks(page, { sessions: [] });
    await page.goto('/chats');
    await page.waitForTimeout(800);

    const dialog = await openDropdown(page);
    await screenshot(page, 'recent-chats-empty-desktop');

    await expect(dialog.getByText('No active chats')).toBeVisible();
  });

  test('many items', async ({ page }) => {
    await setupApiMocks(page, { sessions: MANY_SESSIONS });
    await page.goto('/chats');
    await page.waitForTimeout(800);

    const dialog = await openDropdown(page);
    await screenshot(page, 'recent-chats-many-items-desktop');

    await expect(dialog.getByText('View all chats')).toBeVisible();
  });
});
