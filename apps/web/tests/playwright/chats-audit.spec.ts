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
  makeSession({ id: 's3', topic: 'Refactor database layer', status: 'active', lastMessageAt: NOW - 600000, projectId: 'proj-2', projectName: 'Frontend App' }),
  makeSession({ id: 's4', topic: null, status: 'active', lastMessageAt: NOW - 900000, projectId: 'proj-2', projectName: 'Frontend App' }),
];

const LONG_TEXT_SESSIONS = [
  makeSession({
    id: 'lt1',
    topic: 'This is an extremely long chat topic that should definitely be truncated on mobile screens because it contains way too many words and characters to fit in a single line without breaking the layout or causing horizontal scroll issues on smaller viewports',
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

const MANY_SESSIONS = Array.from({ length: 30 }, (_, i) => {
  return makeSession({
    id: `many-${i}`,
    topic: `Session ${i + 1}: ${['Implement feature', 'Fix bug', 'Refactor code', 'Add tests', 'Update docs'][i % 5]} #${i + 1}`,
    status: 'active',
    agentCompletedAt: i % 4 === 0 ? NOW - i * 60000 : null,
    lastMessageAt: NOW - i * 60000,
    projectId: `proj-${(i % 2) + 1}`,
    projectName: i % 2 === 0 ? 'Backend API' : 'Frontend App',
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function setupApiMocks(
  page: Page,
  options: {
    sessions?: ReturnType<typeof makeSession>[];
    error?: boolean;
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

    if (url.includes('/api/projects') && !url.includes('/api/projects/')) {
      return route.fulfill({ json: { projects: [], total: 0 } });
    }

    // New D1-backed cross-project endpoint (used by useAllChatSessions)
    if (url.includes('/api/chats') && !url.includes('/recent')) {
      if (options.error) {
        return route.fulfill({ status: 500, json: { error: 'Server error' } });
      }
      const sessions = options.sessions ?? [];
      return route.fulfill({
        json: { sessions, total: sessions.length },
      });
    }

    // New D1-backed recent-chats endpoint (used by useRecentChats / dropdown)
    if (url.includes('/api/chats/recent')) {
      if (options.error) {
        return route.fulfill({ status: 500, json: { error: 'Server error' } });
      }
      const sessions = options.sessions ?? [];
      const active = sessions.filter((s) => s.status !== 'stopped' && s.status !== 'failed');
      return route.fulfill({
        json: { sessions: active, totalActive: active.length },
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
    await setupApiMocks(page, { sessions: NORMAL_SESSIONS });
    await page.goto('/chats');
    await page.waitForSelector('text=Fix authentication flow');
    await assertNoOverflow(page);
    await screenshot(page, 'chats-normal-mobile');
  });

  test('long text wraps correctly', async ({ page }) => {
    await setupApiMocks(page, { sessions: LONG_TEXT_SESSIONS });
    await page.goto('/chats');
    await page.waitForTimeout(800);
    await assertNoOverflow(page);
    await screenshot(page, 'chats-long-text-mobile');
  });

  test('empty state', async ({ page }) => {
    await setupApiMocks(page, { sessions: [] });
    await page.goto('/chats');
    await page.waitForSelector('text=No active chats');
    await assertNoOverflow(page);
    await screenshot(page, 'chats-empty-mobile');
  });

  test('many items', async ({ page }) => {
    await setupApiMocks(page, { sessions: MANY_SESSIONS });
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
    await setupApiMocks(page, { sessions: NORMAL_SESSIONS });
    await page.goto('/chats');
    await page.waitForSelector('text=Fix authentication flow');
    await assertNoOverflow(page);
    await screenshot(page, 'chats-normal-desktop');
  });

  test('long text', async ({ page }) => {
    await setupApiMocks(page, { sessions: LONG_TEXT_SESSIONS });
    await page.goto('/chats');
    await page.waitForTimeout(800);
    await assertNoOverflow(page);
    await screenshot(page, 'chats-long-text-desktop');
  });
});
