import { expect, type Page, type Route,test } from '@playwright/test';

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
  projectId?: string;
  projectName?: string;
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
];

const NORMAL_SESSIONS = [
  makeSession({ id: 's1', topic: 'Fix authentication flow', status: 'active', lastMessageAt: NOW - 60000 }),
  makeSession({ id: 's2', topic: 'Add user dashboard', status: 'active', isIdle: true, agentCompletedAt: NOW - 300000, lastMessageAt: NOW - 300000 }),
  makeSession({ id: 's3', topic: 'Refactor database layer', status: 'stopped', lastMessageAt: NOW - 600000 }),
  makeSession({ id: 's4', topic: null, status: 'active', lastMessageAt: NOW - 900000 }),
];

const LONG_TEXT_SESSIONS = [
  makeSession({
    id: 'lt1',
    topic: 'This is an extremely long chat topic that should definitely be truncated on mobile screens because it contains way too many words and characters to fit in a single line without breaking the layout or causing horizontal scroll issues on smaller viewports',
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
];

const MANY_SESSIONS = Array.from({ length: 30 }, (_, i) => {
  const statuses = ['active', 'active', 'stopped'];
  return makeSession({
    id: `many-${i}`,
    topic: `Session ${i + 1}: ${['Implement feature', 'Fix bug', 'Refactor code', 'Add tests', 'Update docs'][i % 5]} #${i + 1}`,
    status: statuses[i % statuses.length],
    isIdle: i % 4 === 0,
    agentCompletedAt: i % 4 === 0 ? NOW - i * 60000 : null,
    lastMessageAt: NOW - i * 60000,
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupApiMocks(
  page: Page,
  options: {
    sessions?: Record<string, unknown[]>;
    error?: boolean;
  },
) {
  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();

    if (url.includes('/api/auth/session')) {
      return route.fulfill({ json: MOCK_USER });
    }

    if (url.includes('/api/projects') && !url.includes('/sessions')) {
      return route.fulfill({
        json: { projects: MOCK_PROJECTS, total: MOCK_PROJECTS.length },
      });
    }

    if (url.includes('/sessions')) {
      if (options.error) {
        return route.fulfill({ status: 500, json: { error: 'Server error' } });
      }
      // Extract project ID from URL
      const projMatch = url.match(/projects\/([^/]+)\/sessions/);
      const projId = projMatch?.[1] ?? 'proj-1';
      const sessions = options.sessions?.[projId] ?? [];
      return route.fulfill({
        json: { sessions, total: sessions.length },
      });
    }

    // Default: empty response
    return route.fulfill({ json: {} });
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
}

// ---------------------------------------------------------------------------
// Mobile Tests (default viewport from config)
// ---------------------------------------------------------------------------

test.describe('Chats Page — Mobile', () => {
  test('normal data', async ({ page }) => {
    await setupApiMocks(page, {
      sessions: { 'proj-1': NORMAL_SESSIONS.slice(0, 2), 'proj-2': NORMAL_SESSIONS.slice(2) },
    });
    await page.goto('/chats');
    await page.waitForSelector('text=Fix authentication flow');
    await assertNoOverflow(page);
    await screenshot(page, 'chats-normal-mobile');
  });

  test('long text wraps correctly', async ({ page }) => {
    await setupApiMocks(page, {
      sessions: { 'proj-1': LONG_TEXT_SESSIONS, 'proj-2': [] },
    });
    await page.goto('/chats');
    await page.waitForTimeout(800);
    await assertNoOverflow(page);
    await screenshot(page, 'chats-long-text-mobile');
  });

  test('empty state', async ({ page }) => {
    await setupApiMocks(page, { sessions: { 'proj-1': [], 'proj-2': [] } });
    await page.goto('/chats');
    await page.waitForSelector('text=No active chats');
    await assertNoOverflow(page);
    await screenshot(page, 'chats-empty-mobile');
  });

  test('many items', async ({ page }) => {
    await setupApiMocks(page, {
      sessions: { 'proj-1': MANY_SESSIONS.slice(0, 15), 'proj-2': MANY_SESSIONS.slice(15) },
    });
    await page.goto('/chats');
    await page.waitForSelector('text=Session 1');
    await assertNoOverflow(page);
    await screenshot(page, 'chats-many-mobile');
  });

  test('error state', async ({ page }) => {
    await setupApiMocks(page, { error: true });
    await page.goto('/chats');
    await page.waitForTimeout(800);
    await assertNoOverflow(page);
    await screenshot(page, 'chats-error-mobile');
  });
});

// ---------------------------------------------------------------------------
// Desktop Tests
// ---------------------------------------------------------------------------

test.describe('Chats Page — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('normal data', async ({ page }) => {
    await setupApiMocks(page, {
      sessions: { 'proj-1': NORMAL_SESSIONS.slice(0, 2), 'proj-2': NORMAL_SESSIONS.slice(2) },
    });
    await page.goto('/chats');
    await page.waitForSelector('text=Fix authentication flow');
    await assertNoOverflow(page);
    await screenshot(page, 'chats-normal-desktop');
  });

  test('long text', async ({ page }) => {
    await setupApiMocks(page, {
      sessions: { 'proj-1': LONG_TEXT_SESSIONS, 'proj-2': [] },
    });
    await page.goto('/chats');
    await page.waitForTimeout(800);
    await assertNoOverflow(page);
    await screenshot(page, 'chats-long-text-desktop');
  });
});
