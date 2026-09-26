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
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const NOW = Date.now();

function makeSession(overrides: { id: string; topic?: string; status?: string }) {
  return {
    id: overrides.id,
    workspaceId: null,
    taskId: null,
    topic: overrides.topic ?? 'Test Session',
    status: overrides.status ?? 'active',
    messageCount: 50,
    startedAt: NOW - 60000,
    endedAt: null,
    createdAt: NOW - 120000,
    lastMessageAt: NOW - 30000,
    isIdle: false,
    agentCompletedAt: null,
    isTerminated: false,
    workspaceUrl: null,
    cleanupAt: null,
    agentSessionId: null,
  };
}

function makeMessage(overrides: { id: string; role: string; content: string; index: number }) {
  return {
    id: overrides.id,
    sessionId: 'session-1',
    role: overrides.role,
    content: overrides.content,
    toolMetadata: null,
    createdAt: NOW - (50 - overrides.index) * 10000,
    sequence: overrides.index,
  };
}

// Generate enough messages to make the chat scrollable
const MANY_MESSAGES = Array.from({ length: 50 }, (_, i) =>
  makeMessage({
    id: `msg-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content:
      i % 2 === 0
        ? `User message ${i}: Can you help me with this task?`
        : `Assistant message ${i}: Here is a detailed response that spans multiple lines to ensure the message list becomes scrollable. ${'This is additional filler content to make the message taller. '.repeat(3)}`,
    index: i,
  })
);

const SESSIONS = [makeSession({ id: 'session-1', topic: 'Active Chat Session' })];

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupApiMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/provider-catalog')) return respond(200, { catalogs: [] });
    if (path === '/api/trial/status') return respond(200, { available: false });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/workspaces') return respond(200, []);

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';

      // Sessions list: returns { sessions, total, hasMore }
      if (subPath === '/sessions') {
        return respond(200, { sessions: SESSIONS, total: SESSIONS.length, hasMore: false });
      }

      // Session detail: returns { session, messages, hasMore }
      const sessionDetailMatch = subPath.match(/^\/sessions\/([^/]+)$/);
      if (sessionDetailMatch) {
        const sid = sessionDetailMatch[1];
        const session = SESSIONS.find((s) => s.id === sid) ?? SESSIONS[0];
        return respond(200, { session, messages: MANY_MESSAGES, hasMore: false });
      }

      // Messages for a session
      if (subPath.match(/\/sessions\/[^/]+\/messages/)) {
        return respond(200, MANY_MESSAGES);
      }

      // Tasks list: returns { tasks, nextCursor }
      if (subPath === '/tasks') return respond(200, { tasks: [], nextCursor: null });

      // Agent profiles
      if (subPath === '/agent-profiles') return respond(200, { items: [] });

      // Cached commands
      if (subPath.match(/\/commands/)) return respond(200, { commands: [] });

      // Single project
      return respond(200, MOCK_PROJECT);
    }

    if (path === '/api/projects') return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });

    return respond(200, {});
  });
}

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

// ---------------------------------------------------------------------------
// Tests: Body/document should never scroll — only the chat message area
// ---------------------------------------------------------------------------

test.describe('Chat layout scroll containment — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('document body does not scroll vertically when chat has many messages', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat/session-1');
    await page.waitForTimeout(1500);

    const bodyScrollable = await page.evaluate(() => {
      return document.documentElement.scrollHeight > document.documentElement.clientHeight;
    });
    expect(bodyScrollable).toBe(false);

    await screenshot(page, 'chat-layout-no-body-scroll-desktop');
  });

  test('scrolling past chat bottom does not move the whole layout', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat/session-1');
    await page.waitForTimeout(1500);

    // Scroll aggressively past the end of the chat area
    await page.mouse.move(640, 400);
    await page.mouse.wheel(0, 50000);
    await page.waitForTimeout(500);

    // Document body should not have scrolled
    const bodyScrollTop = await page.evaluate(() => {
      return document.documentElement.scrollTop || document.body.scrollTop;
    });
    expect(bodyScrollTop).toBe(0);

    // Document height should equal viewport (no overflow created)
    const docOverflow = await page.evaluate(() => {
      return document.documentElement.scrollHeight > document.documentElement.clientHeight;
    });
    expect(docOverflow).toBe(false);

    // #root should not have scrolled either
    const rootScrollTop = await page.evaluate(() => {
      return document.getElementById('root')?.scrollTop ?? 0;
    });
    expect(rootScrollTop).toBe(0);

    await screenshot(page, 'chat-layout-after-overscroll-desktop');
  });

  test('no horizontal overflow on chat page', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat/session-1');
    await page.waitForTimeout(1000);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(overflow).toBe(false);
  });
});

test.describe('Chat layout scroll containment — Mobile', () => {
  test('document body does not scroll vertically on mobile chat', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat/session-1');
    await page.waitForTimeout(1500);

    const bodyScrollable = await page.evaluate(() => {
      return document.documentElement.scrollHeight > document.documentElement.clientHeight;
    });
    expect(bodyScrollable).toBe(false);

    await screenshot(page, 'chat-layout-no-body-scroll-mobile');
  });

  test('scrolling past chat bottom does not move layout on mobile', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat/session-1');
    await page.waitForTimeout(1500);

    await page.mouse.move(187, 400);
    await page.mouse.wheel(0, 50000);
    await page.waitForTimeout(500);

    const bodyScrollTop = await page.evaluate(() => {
      return document.documentElement.scrollTop || document.body.scrollTop;
    });
    expect(bodyScrollTop).toBe(0);

    await screenshot(page, 'chat-layout-after-overscroll-mobile');
  });
});
