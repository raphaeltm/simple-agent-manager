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

interface SessionOverrides {
  id: string;
  topic?: string | null;
  status?: string;
  isIdle?: boolean;
  agentCompletedAt?: number | null;
  lastMessageAt?: number;
}

function makeSession(overrides: SessionOverrides) {
  return {
    id: overrides.id,
    workspaceId: null,
    taskId: null,
    topic: overrides.topic ?? null,
    status: overrides.status ?? 'active',
    messageCount: 5,
    startedAt: (overrides.lastMessageAt ?? NOW) - 60000,
    endedAt: null,
    createdAt: (overrides.lastMessageAt ?? NOW) - 120000,
    lastMessageAt: overrides.lastMessageAt ?? NOW - 30000,
    isIdle: overrides.isIdle ?? false,
    agentCompletedAt: overrides.agentCompletedAt ?? null,
    isTerminated: overrides.status === 'stopped',
    workspaceUrl: null,
    cleanupAt: null,
    agentSessionId: null,
  };
}

const MOCK_PROJECTS = [
  { id: 'proj-1', name: 'Backend API', repository: 'org/backend', defaultBranch: 'main', userId: 'user-test-1', githubInstallationId: 'inst-1', defaultVmSize: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'proj-2', name: 'Frontend App', repository: 'org/frontend', defaultBranch: 'main', userId: 'user-test-1', githubInstallationId: 'inst-2', defaultVmSize: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'proj-3', name: 'Infrastructure', repository: 'org/infra', defaultBranch: 'main', userId: 'user-test-1', githubInstallationId: 'inst-3', defaultVmSize: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
];

const NORMAL_SESSIONS: Record<string, ReturnType<typeof makeSession>[]> = {
  'proj-1': [
    makeSession({ id: 's1', topic: 'Fix authentication flow', status: 'active', lastMessageAt: NOW - 60000 }),
    makeSession({ id: 's2', topic: 'Add user dashboard', status: 'active', isIdle: true, agentCompletedAt: NOW - 300000, lastMessageAt: NOW - 300000 }),
  ],
  'proj-2': [
    makeSession({ id: 's3', topic: 'Refactor component library', status: 'active', lastMessageAt: NOW - 120000 }),
    makeSession({ id: 's4', topic: null, status: 'active', lastMessageAt: NOW - 900000 }),
  ],
  'proj-3': [
    makeSession({ id: 's5', topic: 'Terraform modules update', status: 'active', lastMessageAt: NOW - 180000 }),
  ],
};

const LONG_TEXT_SESSIONS: Record<string, ReturnType<typeof makeSession>[]> = {
  'proj-1': [
    makeSession({
      id: 'lt1',
      topic: 'This is an extremely long chat topic that should definitely be truncated because it contains way too many words and characters to fit in a single line without breaking the layout or causing horizontal scroll issues',
      status: 'active',
      lastMessageAt: NOW - 60000,
    }),
    makeSession({
      id: 'lt2',
      topic: 'Fix: handling of special characters like <script>alert("xss")</script> & "quotes" and Japanese text',
      status: 'active',
      isIdle: true,
      agentCompletedAt: NOW - 120000,
      lastMessageAt: NOW - 120000,
    }),
    makeSession({
      id: 'lt3',
      topic: 'x'.repeat(500),
      status: 'active',
      lastMessageAt: NOW - 180000,
    }),
  ],
  'proj-2': [],
  'proj-3': [],
};

const MANY_SESSIONS: Record<string, ReturnType<typeof makeSession>[]> = {
  'proj-1': Array.from({ length: 10 }, (_, i) =>
    makeSession({
      id: `many-1-${i}`,
      topic: `Backend task ${i + 1}: ${['Fix API endpoint', 'Add middleware', 'Optimize queries', 'Update schema', 'Add tests'][i % 5]}`,
      status: 'active',
      isIdle: i % 3 === 0,
      agentCompletedAt: i % 3 === 0 ? NOW - i * 60000 : null,
      lastMessageAt: NOW - i * 60000,
    }),
  ),
  'proj-2': Array.from({ length: 10 }, (_, i) =>
    makeSession({
      id: `many-2-${i}`,
      topic: `Frontend task ${i + 1}: ${['Fix layout', 'Add animation', 'Refactor hooks', 'Add dark mode', 'Update styles'][i % 5]}`,
      status: 'active',
      lastMessageAt: NOW - (i + 10) * 60000,
    }),
  ),
  'proj-3': Array.from({ length: 10 }, (_, i) =>
    makeSession({
      id: `many-3-${i}`,
      topic: `Infra task ${i + 1}`,
      status: 'active',
      lastMessageAt: NOW - (i + 20) * 60000,
    }),
  ),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupApiMocks(
  page: Page,
  options: {
    sessions?: Record<string, ReturnType<typeof makeSession>[]>;
    error?: boolean;
    noProjects?: boolean;
  },
) {
  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();

    if (url.includes('/api/auth/session')) {
      return route.fulfill({ json: MOCK_USER });
    }

    if (url.includes('/api/notifications')) {
      return route.fulfill({ json: { notifications: [], total: 0 } });
    }

    if (url.includes('/api/projects') && !url.includes('/sessions')) {
      if (options.noProjects) {
        return route.fulfill({ json: { projects: [], total: 0 } });
      }
      return route.fulfill({
        json: { projects: MOCK_PROJECTS, total: MOCK_PROJECTS.length },
      });
    }

    if (url.includes('/sessions')) {
      if (options.error) {
        return route.fulfill({ status: 500, json: { error: 'Server error' } });
      }
      const projMatch = url.match(/projects\/([^/]+)\/sessions/);
      const projId = projMatch?.[1] ?? 'proj-1';
      const sessions = options.sessions?.[projId] ?? [];
      return route.fulfill({ json: { sessions } });
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

async function openDropdown(page: Page) {
  const btn = page.getByLabel(/Recent chats/);
  await btn.click();
  // Wait for the dropdown panel to appear
  await page.waitForSelector('[aria-label="Recent chats"][role="dialog"]', { timeout: 3000 });
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// Mobile Tests (default viewport from config — 375x667)
// ---------------------------------------------------------------------------

test.describe('Recent Chats Dropdown — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('normal data — dropdown shows recent chats', async ({ page }) => {
    await setupApiMocks(page, { sessions: NORMAL_SESSIONS });
    await page.goto('/');
    await page.waitForTimeout(500);

    // Badge should be visible with count
    const btn = page.getByLabel(/Recent chats/);
    await expect(btn).toBeVisible();

    await openDropdown(page);
    await screenshot(page, 'recent-chats-normal-mobile');

    // Verify no horizontal overflow
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);

    // Verify chat items are visible
    await expect(page.getByText('Fix authentication flow')).toBeVisible();
    await expect(page.getByText('Refactor component library')).toBeVisible();
    await expect(page.getByText('Backend API')).toBeVisible();
    await expect(page.getByText('Frontend App')).toBeVisible();
  });

  test('long text wraps correctly', async ({ page }) => {
    await setupApiMocks(page, { sessions: LONG_TEXT_SESSIONS });
    await page.goto('/');
    await page.waitForTimeout(500);

    await openDropdown(page);
    await screenshot(page, 'recent-chats-long-text-mobile');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test('empty state — no active chats', async ({ page }) => {
    await setupApiMocks(page, { sessions: { 'proj-1': [], 'proj-2': [], 'proj-3': [] } });
    await page.goto('/');
    await page.waitForTimeout(500);

    await openDropdown(page);
    await screenshot(page, 'recent-chats-empty-mobile');

    await expect(page.getByText('No active chats')).toBeVisible();
    await expect(page.getByText('Start a conversation in any project')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test('many items — scroll behavior', async ({ page }) => {
    await setupApiMocks(page, { sessions: MANY_SESSIONS });
    await page.goto('/');
    await page.waitForTimeout(500);

    await openDropdown(page);
    await screenshot(page, 'recent-chats-many-items-mobile');

    // Should show the "View all chats" footer
    await expect(page.getByText('View all chats')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test('error state', async ({ page }) => {
    await setupApiMocks(page, { error: true });
    await page.goto('/');
    await page.waitForTimeout(500);

    await openDropdown(page);
    await screenshot(page, 'recent-chats-error-mobile');

    await expect(page.getByText('Failed to load chats')).toBeVisible();
    await expect(page.getByText('Retry')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test('no projects — empty state', async ({ page }) => {
    await setupApiMocks(page, { noProjects: true });
    await page.goto('/');
    await page.waitForTimeout(500);

    await openDropdown(page);
    await screenshot(page, 'recent-chats-no-projects-mobile');

    await expect(page.getByText('No active chats')).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test('close on escape', async ({ page }) => {
    await setupApiMocks(page, { sessions: NORMAL_SESSIONS });
    await page.goto('/');
    await page.waitForTimeout(500);

    await openDropdown(page);
    await expect(page.locator('[aria-label="Recent chats"][role="dialog"]')).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(page.locator('[aria-label="Recent chats"][role="dialog"]')).not.toBeVisible();
  });

  test('clicking a chat navigates away', async ({ page }) => {
    await setupApiMocks(page, { sessions: NORMAL_SESSIONS });
    await page.goto('/');
    await page.waitForTimeout(500);

    await openDropdown(page);

    // Click the first chat item
    await page.getByText('Fix authentication flow').click();
    await page.waitForTimeout(300);

    // Should have navigated — dropdown should be closed
    await expect(page.locator('[aria-label="Recent chats"][role="dialog"]')).not.toBeVisible();
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
    await page.goto('/');
    await page.waitForTimeout(500);

    await openDropdown(page);
    await screenshot(page, 'recent-chats-normal-desktop');

    await expect(page.getByText('Fix authentication flow')).toBeVisible();
    await expect(page.getByText('Recent Chats')).toBeVisible();
  });

  test('long text', async ({ page }) => {
    await setupApiMocks(page, { sessions: LONG_TEXT_SESSIONS });
    await page.goto('/');
    await page.waitForTimeout(500);

    await openDropdown(page);
    await screenshot(page, 'recent-chats-long-text-desktop');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    );
    expect(overflow).toBe(false);
  });

  test('empty state', async ({ page }) => {
    await setupApiMocks(page, { sessions: { 'proj-1': [], 'proj-2': [], 'proj-3': [] } });
    await page.goto('/');
    await page.waitForTimeout(500);

    await openDropdown(page);
    await screenshot(page, 'recent-chats-empty-desktop');

    await expect(page.getByText('No active chats')).toBeVisible();
  });

  test('many items', async ({ page }) => {
    await setupApiMocks(page, { sessions: MANY_SESSIONS });
    await page.goto('/');
    await page.waitForTimeout(500);

    await openDropdown(page);
    await screenshot(page, 'recent-chats-many-items-desktop');

    await expect(page.getByText('View all chats')).toBeVisible();
  });
});
