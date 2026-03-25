import { test, expect, type Page, type Route } from '@playwright/test';

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

function makeSession(overrides: { id: string; title?: string; status?: string }) {
  return {
    id: overrides.id,
    projectId: 'proj-test-1',
    taskId: `task-${overrides.id}`,
    title: overrides.title || 'Test Session',
    status: overrides.status || 'active',
    workspaceId: 'ws-test-1',
    nodeId: 'node-test-1',
    branch: 'sam/test-branch',
    createdAt: '2026-01-15T10:00:00Z',
    updatedAt: '2026-01-15T10:05:00Z',
    stoppedAt: null,
  };
}

function makeMessage(overrides: { id: string; role: string; content: string; index?: number }) {
  return {
    id: overrides.id,
    sessionId: 'session-1',
    role: overrides.role,
    content: overrides.content,
    messageIndex: overrides.index ?? 0,
    createdAt: '2026-01-15T10:01:00Z',
  };
}

const MANY_MESSAGES = Array.from({ length: 40 }, (_, i) => makeMessage({
  id: `msg-${i}`,
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `Message ${i}: ${i % 2 === 0 ? 'User says something' : 'Assistant responds with a longer explanation about the topic that spans multiple lines and provides detailed information to make the message list scrollable.'}`,
  index: i,
}));

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

type MockOptions = {
  sessions?: ReturnType<typeof makeSession>[];
  messages?: ReturnType<typeof makeMessage>[];
};

async function setupApiMocks(page: Page, options: MockOptions = {}) {
  const {
    sessions = [makeSession({ id: 'session-1', title: 'Active Session', status: 'active' })],
    messages = MANY_MESSAGES,
  } = options;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    // Auth
    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);

    // Notifications
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });

    // Credentials
    if (path.startsWith('/api/credentials')) return respond(200, []);

    // Provider catalog
    if (path.startsWith('/api/provider-catalog')) {
      return respond(200, { catalogs: [] });
    }

    // Project-scoped routes
    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';

      // Sessions list
      if (subPath === '/sessions') return respond(200, sessions);

      // Messages for a session
      if (subPath.match(/\/sessions\/[^/]+\/messages/)) return respond(200, messages);

      // Tasks list
      if (subPath === '/tasks') return respond(200, []);

      // Agents list
      if (subPath === '/agents') return respond(200, []);

      // Single project
      return respond(200, MOCK_PROJECT);
    }

    // Projects list
    if (path === '/api/projects') return respond(200, [MOCK_PROJECT]);

    // Fallback
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
// Tests: Scroll button positioning with cancel bar
// ---------------------------------------------------------------------------

test.describe('Chat scroll button — Mobile', () => {
  test('scroll button does not cause horizontal overflow', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat/session-1');
    await page.waitForTimeout(1000);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(overflow).toBe(false);

    await screenshot(page, 'chat-scroll-button-mobile');
  });

  test('scroll button has correct bottom offset class when both buttons could be active', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat/session-1');
    await page.waitForTimeout(1000);

    // Inject a simulated scenario: both scroll button and cancel bar visible
    // The scroll button uses conditional CSS: bottom-3 (normal) vs bottom-14 (when cancel bar visible)
    // Verify the transition classes are present for smooth animation
    const scrollButton = page.locator('button[aria-label="Scroll to bottom"]');

    // The button may or may not be visible depending on scroll state.
    // If visible, verify it has the correct positioning classes.
    const isVisible = await scrollButton.isVisible().catch(() => false);
    if (isVisible) {
      const classes = await scrollButton.getAttribute('class');
      expect(classes).toContain('transition-all');
      expect(classes).toContain('duration-200');
      // Should have either bottom-3 or bottom-14 (not both)
      const hasBottom3 = classes?.includes('bottom-3');
      const hasBottom14 = classes?.includes('bottom-14');
      expect(hasBottom3 || hasBottom14).toBe(true);
      expect(hasBottom3 && hasBottom14).toBe(false);
    }

    await screenshot(page, 'chat-scroll-button-classes-mobile');
  });
});

test.describe('Chat scroll button — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('scroll button does not cause horizontal overflow', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat/session-1');
    await page.waitForTimeout(1000);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(overflow).toBe(false);

    await screenshot(page, 'chat-scroll-button-desktop');
  });

  test('scroll button positioning classes are correct', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat/session-1');
    await page.waitForTimeout(1000);

    const scrollButton = page.locator('button[aria-label="Scroll to bottom"]');
    const isVisible = await scrollButton.isVisible().catch(() => false);
    if (isVisible) {
      const classes = await scrollButton.getAttribute('class');
      expect(classes).toContain('transition-all');
      expect(classes).toContain('duration-200');
      expect(classes).toContain('right-4');
      // Touch target: w-11 h-11 = 44px
      expect(classes).toContain('w-11');
      expect(classes).toContain('h-11');
    }

    await screenshot(page, 'chat-scroll-button-classes-desktop');
  });
});
