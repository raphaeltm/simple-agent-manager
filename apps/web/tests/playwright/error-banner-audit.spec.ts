import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Visual audit for the glass-chrome error banner in SessionHeader / index.tsx
//
// Tests all combination states:
//   1. Error only (banner is the bottom-most panel — should have rounded bottom + glow)
//   2. Error + summary (banner is middle panel — no rounding/glow, summary gets those)
//   3. Summary only (no error — just the TruncatedSummary panel)
//   4. Neither (no error, no summary — SessionHeader is terminal with rounding)
//   5. Long error message (wrapping behavior, no overflow)
//   6. Error with HTML/XSS payload (rendering safety)
// ---------------------------------------------------------------------------

const NOW = Date.now();

const MOCK_USER = {
  user: {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'user',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-1',
    userId: 'user-1',
    expiresAt: new Date(NOW + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const MOCK_PROJECT = {
  id: 'proj-err-1',
  name: 'Error Banner Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-1',
  githubInstallationId: null,
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function makeSession(taskOverrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'chat-err-1',
    workspaceId: null,
    taskId: 'task-err-1',
    topic: 'Deploy production release',
    status: 'terminated',
    messageCount: 10,
    startedAt: NOW - 600000,
    endedAt: NOW - 60000,
    createdAt: NOW - 600000,
    lastMessageAt: NOW - 60000,
    isIdle: false,
    isTerminated: true,
    agentSessionId: null,
    agentType: 'claude-code',
    task: {
      id: 'task-err-1',
      status: 'failed',
      executionStep: null,
      errorMessage: null,
      outputBranch: null,
      outputPrUrl: null,
      outputSummary: null,
      finalizedAt: new Date(NOW - 60000).toISOString(),
      taskMode: 'task',
      agentProfileHint: null,
      ...taskOverrides,
    },
  };
}

async function setupApiMocks(
  page: Page,
  opts: { session?: Record<string, unknown>; messages?: unknown[] } = {}
) {
  const session = opts.session ?? makeSession();
  const messages = opts.messages ?? [];

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/provider-catalog')) return respond(200, { catalogs: [] });
    if (path.startsWith('/api/github/installations')) return respond(200, []);
    if (path.startsWith('/api/trial-status')) {
      return respond(200, {
        available: false,
        agentType: null,
        hasInfraCredential: false,
        hasAgentCredential: false,
        dailyTokenBudget: null,
        dailyTokenUsage: null,
      });
    }
    if (path === '/api/agents') return respond(200, { agents: [] });

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '/sessions') return respond(200, { sessions: [session], total: 1 });
      if (subPath.match(/\/sessions\/[^/]+$/) && !subPath.includes('/messages')) {
        return respond(200, { session, messages, hasMore: false });
      }
      if (subPath.match(/\/sessions\/[^/]+\/messages/)) return respond(200, { messages, hasMore: false });
      if (subPath === '/tasks') return respond(200, { tasks: [], nextCursor: null });
      if (subPath.match(/\/tasks\//)) return respond(200, { id: 'task-err-1', status: 'failed' });
      if (subPath === '/agents') return respond(200, { agents: [] });
      if (subPath === '/agent-profiles') return respond(200, { items: [] });
      if (subPath === '/cached-commands') return respond(200, { items: [] });
      if (subPath === '/triggers') return respond(200, { items: [] });
      if (subPath === '/knowledge') return respond(200, { entities: [], total: 0 });
      return respond(200, MOCK_PROJECT);
    }
    if (path === '/api/projects') return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    return respond(200, {});
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(700);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflow).toBe(false);
}

const BASE_URL = '/projects/proj-err-1/chat/chat-err-1';

// ─── Mobile tests ───────────────────────────────────────────────────────────

test.describe('Error Banner — Mobile (375x667)', () => {
  test('error only — rounded bottom with red glow', async ({ page }) => {
    await setupApiMocks(page, {
      session: makeSession({
        errorMessage: 'Build failed: cannot find module "react-dom/server"',
        outputSummary: null,
      }),
    });
    await page.goto(BASE_URL);
    await page.waitForTimeout(800);
    await screenshot(page, 'error-banner-error-only-mobile');

    // Error text is visible
    await expect(page.getByText('Task failed:')).toBeVisible();
    await expect(page.getByText('Build failed: cannot find module "react-dom/server"')).toBeVisible();

    await assertNoOverflow(page);
  });

  test('error + summary — error panel is middle (no bottom rounding), summary is terminal', async ({ page }) => {
    await setupApiMocks(page, {
      session: makeSession({
        errorMessage: 'Deployment timed out after 30 minutes',
        outputSummary: 'The task partially completed. 12 of 15 tests passed before the timeout.',
      }),
    });
    await page.goto(BASE_URL);
    await page.waitForTimeout(800);
    await screenshot(page, 'error-banner-error-and-summary-mobile');

    await expect(page.getByText('Task failed:')).toBeVisible();
    await expect(page.getByText('Deployment timed out after 30 minutes')).toBeVisible();
    await expect(page.getByText('Summary:')).toBeVisible();

    await assertNoOverflow(page);
  });

  test('summary only — no error banner rendered', async ({ page }) => {
    await setupApiMocks(page, {
      session: makeSession({
        errorMessage: null,
        outputSummary: 'Task completed successfully. All 15 tests passed.',
      }),
    });
    await page.goto(BASE_URL);
    await page.waitForTimeout(800);
    await screenshot(page, 'error-banner-summary-only-mobile');

    await expect(page.getByText('Task failed:')).not.toBeVisible();
    await expect(page.getByText('Summary:')).toBeVisible();

    await assertNoOverflow(page);
  });

  test('no error no summary — clean terminated state', async ({ page }) => {
    await setupApiMocks(page, {
      session: makeSession({
        errorMessage: null,
        outputSummary: null,
      }),
    });
    await page.goto(BASE_URL);
    await page.waitForTimeout(800);
    await screenshot(page, 'error-banner-clean-terminated-mobile');

    await expect(page.getByText('Task failed:')).not.toBeVisible();
    await expect(page.getByText('Summary:')).not.toBeVisible();

    await assertNoOverflow(page);
  });

  test('long error message wraps without overflow', async ({ page }) => {
    await setupApiMocks(page, {
      session: makeSession({
        errorMessage:
          'Error: ENOENT: no such file or directory, open \'/workspace/apps/api/dist/worker.js\' — this is a very long error message that should wrap correctly across multiple lines on narrow viewports without causing horizontal scroll or text clipping issues in the glass-chrome error banner component',
        outputSummary: null,
      }),
    });
    await page.goto(BASE_URL);
    await page.waitForTimeout(800);
    await screenshot(page, 'error-banner-long-text-mobile');

    await expect(page.getByText('Task failed:')).toBeVisible();

    await assertNoOverflow(page);
  });

  test('error with special characters and unicode', async ({ page }) => {
    await setupApiMocks(page, {
      session: makeSession({
        errorMessage: 'Failed: 文件不存在 — <script>alert("xss")</script> & "quotes" \'apostrophes\' \u{1F525} fire emoji',
        outputSummary: null,
      }),
    });
    await page.goto(BASE_URL);
    await page.waitForTimeout(800);
    await screenshot(page, 'error-banner-special-chars-mobile');

    await expect(page.getByText('Task failed:')).toBeVisible();

    await assertNoOverflow(page);
  });

  test('error with messages (non-empty conversation)', async ({ page }) => {
    // ChatMessageResponse.content is a plain string (server-side stringified JSON)
    const messages = [
      {
        id: 'msg-1',
        sessionId: 'chat-err-1',
        role: 'user',
        content: JSON.stringify([{ type: 'text', text: 'Deploy the app' }]),
        toolMetadata: null,
        createdAt: NOW - 500000,
      },
      {
        id: 'msg-2',
        sessionId: 'chat-err-1',
        role: 'assistant',
        content: JSON.stringify([{ type: 'text', text: 'Starting deployment process...' }]),
        toolMetadata: null,
        createdAt: NOW - 490000,
      },
    ];
    await setupApiMocks(page, {
      session: makeSession({
        errorMessage: 'Deployment failed: server unreachable',
        outputSummary: null,
      }),
      messages,
    });
    await page.goto(BASE_URL);
    await page.waitForTimeout(800);
    await screenshot(page, 'error-banner-with-messages-mobile');

    await expect(page.getByText('Task failed:')).toBeVisible();

    await assertNoOverflow(page);
  });
});

// ─── Desktop tests ───────────────────────────────────────────────────────────

test.describe('Error Banner — Desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('error only — desktop layout', async ({ page }) => {
    await setupApiMocks(page, {
      session: makeSession({
        errorMessage: 'Build failed: cannot find module "react-dom/server"',
        outputSummary: null,
      }),
    });
    await page.goto(BASE_URL);
    await page.waitForTimeout(800);
    await screenshot(page, 'error-banner-error-only-desktop');

    await expect(page.getByText('Task failed:')).toBeVisible();

    await assertNoOverflow(page);
  });

  test('error + summary — desktop layout', async ({ page }) => {
    await setupApiMocks(page, {
      session: makeSession({
        errorMessage: 'Deployment timed out after 30 minutes',
        outputSummary: 'The task partially completed. 12 of 15 tests passed before the timeout.',
      }),
    });
    await page.goto(BASE_URL);
    await page.waitForTimeout(800);
    await screenshot(page, 'error-banner-error-and-summary-desktop');

    await expect(page.getByText('Task failed:')).toBeVisible();
    await expect(page.getByText('Summary:')).toBeVisible();

    await assertNoOverflow(page);
  });

  test('long error wraps on desktop', async ({ page }) => {
    await setupApiMocks(page, {
      session: makeSession({
        errorMessage:
          'TypeError: Cannot read properties of undefined (reading "map") at ProjectMessageView.render (apps/web/src/components/project-message-view/index.tsx:284:12) — this error indicates a null reference was encountered during the rendering phase of the conversation list',
        outputSummary: null,
      }),
    });
    await page.goto(BASE_URL);
    await page.waitForTimeout(800);
    await screenshot(page, 'error-banner-long-text-desktop');

    await assertNoOverflow(page);
  });
});
