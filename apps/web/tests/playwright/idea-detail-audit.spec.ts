/**
 * UI/UX audit tests for IdeaDetailPage.
 * Captures mobile (375x667) and desktop (1280x800) screenshots.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock factories
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
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function makeTask(overrides: {
  id: string;
  title: string;
  status?: string;
  description?: string | null;
}) {
  return {
    projectId: 'proj-test-1',
    userId: 'user-test-1',
    parentTaskId: null,
    workspaceId: null,
    description: overrides.description ?? null,
    status: overrides.status ?? 'draft',
    executionStep: null,
    priority: 0,
    taskMode: 'task',
    dispatchDepth: 0,
    agentProfileHint: null,
    blocked: false,
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    outputSummary: null,
    outputBranch: null,
    outputPrUrl: null,
    finalizedAt: null,
    createdAt: '2026-03-20T10:00:00Z',
    updatedAt: '2026-03-20T10:00:00Z',
    dependencies: [],
    ...overrides,
  };
}

function makeSessionLink(overrides: {
  sessionId: string;
  topic?: string | null;
  status?: string;
  context?: string | null;
  linkedAt?: number;
}) {
  return {
    sessionId: overrides.sessionId,
    topic: overrides.topic ?? 'Untitled conversation',
    status: overrides.status ?? 'stopped',
    context: overrides.context ?? null,
    linkedAt: overrides.linkedAt ?? Date.now() - 3600000,
  };
}

// Sample tasks
const TASK_WITH_SESSIONS = makeTask({
  id: 'idea-1',
  title: 'Implement user authentication',
  status: 'in_progress',
  description: 'Add OAuth2 login flow with GitHub provider. Include session management and token refresh.',
});

const TASK_DONE = makeTask({
  id: 'idea-done',
  title: 'Refactor API error handling',
  status: 'completed',
  description: 'Standardize error responses across all endpoints.',
});

const TASK_NO_DESC = makeTask({
  id: 'idea-nodesc',
  title: 'Update dependencies',
  status: 'ready',
  description: null,
});

const TASK_LONG_TITLE = makeTask({
  id: 'idea-long',
  title: 'This is an extremely long idea title that should wrap properly on mobile screens without causing any horizontal overflow or layout breakage when displayed in the detail header area',
  status: 'draft',
  description: 'Short description for this task.',
});

const MOCK_SESSIONS = [
  makeSessionLink({
    sessionId: 's1',
    topic: 'Auth implementation discussion',
    status: 'stopped',
    context: 'Discussed approach for OAuth flow with GitHub',
    linkedAt: Date.now() - 7200000,
  }),
  makeSessionLink({
    sessionId: 's2',
    topic: 'Auth debugging session',
    status: 'active',
    context: 'Currently debugging token refresh issues',
    linkedAt: Date.now() - 600000,
  }),
];

const MANY_SESSIONS = Array.from({ length: 8 }, (_, i) =>
  makeSessionLink({
    sessionId: `sess-${i}`,
    topic: `Session ${i + 1}: ${['Planning', 'Implementation', 'Review', 'Debug', 'Testing'][i % 5]}`,
    status: i === 0 ? 'active' : 'stopped',
    context:
      i % 2 === 0
        ? `Context for session ${i + 1} with some details about what was discussed`
        : null,
    linkedAt: Date.now() - i * 3600000,
  }),
);

// ---------------------------------------------------------------------------
// Route mock helper
// ---------------------------------------------------------------------------

async function setupMocks(
  page: Page,
  options: {
    taskDetail?: ReturnType<typeof makeTask> | null;
    taskSessions?: ReturnType<typeof makeSessionLink>[];
    taskNotFound?: boolean;
    sessionsError?: boolean;
  } = {},
) {
  const {
    taskDetail = null,
    taskSessions = [],
    taskNotFound = false,
    sessionsError = false,
  } = options;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/github/installations') return respond(200, []);
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/agents') return respond(200, []);
    if (path.startsWith('/api/credentials')) return respond(200, { credentials: [] });
    if (path.startsWith('/api/workspaces')) return respond(200, []);
    if (path === '/api/projects') return respond(200, { projects: [] });
    if (path.endsWith('/health')) return respond(200, { status: 'ok' });

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';

      if (subPath === '/runtime-config') return respond(200, { envVars: [], files: [] });
      if (subPath.startsWith('/sessions')) return respond(200, { sessions: [], total: 0 });

      // Task sessions endpoint: /tasks/:id/sessions
      if (subPath.match(/^\/tasks\/[^/]+\/sessions$/)) {
        if (sessionsError) return respond(500, { error: 'Failed to load sessions' });
        return respond(200, { sessions: taskSessions, count: taskSessions.length });
      }

      // Task detail: /tasks/:id
      if (subPath.match(/^\/tasks\/[^/]+$/)) {
        if (taskNotFound || !taskDetail) return respond(404, { error: 'Not found' });
        return respond(200, taskDetail);
      }

      if (subPath === '/tasks' || subPath.startsWith('/tasks?')) {
        return respond(200, { tasks: [], nextCursor: null });
      }

      if (!subPath || subPath === '/') return respond(200, MOCK_PROJECT);
    }

    return respond(200, {});
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

// ---------------------------------------------------------------------------
// Mobile tests (375x667 — set in playwright.config.ts)
// ---------------------------------------------------------------------------

test.describe('IdeaDetailPage — Mobile (375px)', () => {
  test('with sessions', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_WITH_SESSIONS, taskSessions: MOCK_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas/idea-1');
    await page.waitForSelector('text=Implement user authentication');
    await screenshot(page, 'idea-detail-mobile-with-sessions');

    // Back link present
    await expect(page.getByRole('button', { name: /Back to Ideas/i })).toBeVisible();
    // Status badge present
    await expect(page.getByText('Executing')).toBeVisible();
    // Sessions section header
    await expect(page.getByText('Conversations (2)')).toBeVisible();
    // Session rows are buttons
    const sessionButtons = page.getByRole('button', { name: /Open conversation/i });
    await expect(sessionButtons.first()).toBeVisible();
  });

  test('empty sessions', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_NO_DESC, taskSessions: [] });
    await page.goto('/projects/proj-test-1/ideas/idea-nodesc');
    await page.waitForSelector('text=Update dependencies');
    await screenshot(page, 'idea-detail-mobile-empty-sessions');

    await expect(page.getByText('No conversations linked yet')).toBeVisible();
  });

  test('done status', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_DONE, taskSessions: [] });
    await page.goto('/projects/proj-test-1/ideas/idea-done');
    await page.waitForSelector('text=Refactor API error handling');
    await screenshot(page, 'idea-detail-mobile-done-status');

    await expect(page.getByText('Done')).toBeVisible();
  });

  test('long title wraps correctly', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_LONG_TITLE, taskSessions: [] });
    await page.goto('/projects/proj-test-1/ideas/idea-long');
    await page.waitForSelector('text=This is an extremely long idea title');
    await screenshot(page, 'idea-detail-mobile-long-title');

    // No horizontal overflow
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('many sessions', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_WITH_SESSIONS, taskSessions: MANY_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas/idea-1');
    await page.waitForSelector('text=Conversations (8)');
    await screenshot(page, 'idea-detail-mobile-many-sessions');
  });

  test('not found state', async ({ page }) => {
    await setupMocks(page, { taskNotFound: true });
    await page.goto('/projects/proj-test-1/ideas/nonexistent');
    await page.waitForTimeout(1200);
    await screenshot(page, 'idea-detail-mobile-not-found');

    await expect(page.getByRole('button', { name: /Back to Ideas/i })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Desktop tests (1280x800)
// ---------------------------------------------------------------------------

test.describe('IdeaDetailPage — Desktop (1280px)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('with sessions desktop', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_WITH_SESSIONS, taskSessions: MOCK_SESSIONS });
    await page.goto('/projects/proj-test-1/ideas/idea-1');
    await page.waitForSelector('text=Implement user authentication');
    await screenshot(page, 'idea-detail-desktop-with-sessions');
  });

  test('empty sessions desktop', async ({ page }) => {
    await setupMocks(page, { taskDetail: TASK_NO_DESC, taskSessions: [] });
    await page.goto('/projects/proj-test-1/ideas/idea-nodesc');
    await page.waitForSelector('text=Update dependencies');
    await screenshot(page, 'idea-detail-desktop-empty-sessions');
  });
});
