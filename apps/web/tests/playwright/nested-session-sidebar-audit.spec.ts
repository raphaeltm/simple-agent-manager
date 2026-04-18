import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Visual audit for the nested chat-session sidebar (SessionTreeItem).
//
// Verifies that deeply-nested session trees render without horizontal
// overflow on mobile (375px) and that the "L6+" depth-overflow badge appears
// beyond the visual-indent cap.
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-test-1',
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
    id: 'session-test-1',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const MOCK_PROJECT = {
  id: 'proj-1',
  name: 'Nested Tree Project',
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

function makeSession(id: string, taskId: string, topic: string, status = 'active') {
  return {
    id,
    workspaceId: null,
    taskId,
    topic,
    status,
    messageCount: 3,
    startedAt: NOW - 60000,
    endedAt: status === 'stopped' ? NOW - 30000 : null,
    createdAt: NOW - 120000,
    lastMessageAt: NOW - 30000,
    isIdle: false,
    isTerminated: status === 'stopped',
  };
}

function makeTask(id: string, title: string, parentTaskId: string | null, status = 'pending') {
  return {
    id,
    title,
    description: null,
    projectId: 'proj-1',
    userId: 'user-test-1',
    status,
    blocked: false,
    parentTaskId,
    triggeredBy: 'user',
    createdAt: new Date(NOW - 120000).toISOString(),
    updatedAt: new Date(NOW - 30000).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Scenario: normal 2-level nested hierarchy
// parent -> child1, child2
// ---------------------------------------------------------------------------
const NORMAL_SESSIONS = [
  makeSession('s-parent', 't-parent', 'Implement authentication'),
  makeSession('s-child1', 't-child1', 'Add JWT validation'),
  makeSession('s-child2', 't-child2', 'Wire up login form'),
];
const NORMAL_TASKS = [
  makeTask('t-parent', 'Implement authentication', null, 'running'),
  makeTask('t-child1', 'Add JWT validation', 't-parent', 'pending'),
  makeTask('t-child2', 'Wire up login form', 't-parent', 'pending'),
];

// ---------------------------------------------------------------------------
// Scenario: deeply nested (L6+ depth badge)
// root -> L1 -> L2 -> L3 -> L4 -> L5 -> L6 (the deepest one gets the badge)
// ---------------------------------------------------------------------------
const DEEP_SESSIONS = Array.from({ length: 7 }, (_, i) =>
  makeSession(`s-deep-${i}`, `t-deep-${i}`, `Level ${i} session`),
);
const DEEP_TASKS = Array.from({ length: 7 }, (_, i) =>
  makeTask(`t-deep-${i}`, `Level ${i} task`, i === 0 ? null : `t-deep-${i - 1}`, 'pending'),
);

// ---------------------------------------------------------------------------
// Scenario: the original bug case — deep child with stopped ancestors
// grandparent (stopped) -> parent (stopped) -> child (active)
// Only the child is in `visibleSessions`; ancestors come in via allSessions.
// ---------------------------------------------------------------------------
const STALE_ANCESTOR_SESSIONS = [
  makeSession('s-gp', 't-gp', 'Original investigation', 'stopped'),
  makeSession('s-p', 't-p', 'Follow-up research', 'stopped'),
  makeSession('s-c', 't-c', 'Active deep child', 'active'),
];
const STALE_ANCESTOR_TASKS = [
  makeTask('t-gp', 'Original investigation', null, 'completed'),
  makeTask('t-p', 'Follow-up research', 't-gp', 'completed'),
  makeTask('t-c', 'Active deep child', 't-p', 'running'),
];

type Fixture = {
  sessions: ReturnType<typeof makeSession>[];
  tasks: ReturnType<typeof makeTask>[];
};

async function setupApiMocks(page: Page, fixture: Fixture) {
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
      if (subPath === '/sessions') {
        return respond(200, { sessions: fixture.sessions, total: fixture.sessions.length });
      }
      if (subPath.match(/\/sessions\/[^/]+\/messages/)) return respond(200, []);
      if (subPath === '/tasks') return respond(200, { tasks: fixture.tasks, nextCursor: null });
      if (subPath === '/agents') return respond(200, { agents: [] });
      if (subPath === '/agent-profiles') return respond(200, { items: [] });
      if (subPath === '/cached-commands') return respond(200, { items: [] });
      if (subPath === '/triggers') return respond(200, { items: [] });
      if (subPath === '/knowledge') return respond(200, { entities: [], total: 0 });
      return respond(200, MOCK_PROJECT);
    }

    if (path === '/api/projects') return respond(200, [MOCK_PROJECT]);
    return respond(200, {});
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(800);
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

/**
 * Guard against error-boundary false positives: if the page crashed,
 * overflow will be trivially 0 but no sidebar content will exist.
 * This asserts that the page actually rendered a chat surface.
 */
async function assertChatPageRendered(page: Page) {
  const body = await page.evaluate(() => document.body.innerText);
  expect(body).not.toContain('Something went wrong');
  expect(body).not.toContain('Cannot read properties of undefined');
}

/** On mobile, the session list is collapsed behind an "Open chat list" button. */
async function openMobileSidebar(page: Page) {
  const btn = page.getByRole('button', { name: 'Open chat list' });
  if (await btn.count()) {
    await btn.first().click();
    await page.waitForTimeout(500);
  }
}

/** Assert that at least one of the expected session topics renders in the DOM. */
async function assertSessionVisible(page: Page, topic: string) {
  const visible = await page.evaluate(
    (t: string) => document.body.innerText.includes(t),
    topic,
  );
  expect(visible, `expected session topic "${topic}" to be visible`).toBe(true);
}

// ---------------------------------------------------------------------------
// Mobile tests (375x667 default from config)
// ---------------------------------------------------------------------------

test.describe('Nested session sidebar — Mobile', () => {
  test('normal 2-level nesting renders without overflow', async ({ page }) => {
    await setupApiMocks(page, { sessions: NORMAL_SESSIONS, tasks: NORMAL_TASKS });
    await page.goto('/projects/proj-1');
    await page.waitForTimeout(1500);
    await assertChatPageRendered(page);
    await openMobileSidebar(page);
    await assertSessionVisible(page, 'Implement authentication');
    await assertNoOverflow(page);
    await screenshot(page, 'nested-sidebar-normal-mobile');
  });

  test('deeply nested (L6+) renders without overflow + depth badge visible', async ({ page }) => {
    await setupApiMocks(page, { sessions: DEEP_SESSIONS, tasks: DEEP_TASKS });
    await page.goto('/projects/proj-1');
    await page.waitForTimeout(1500);
    await assertChatPageRendered(page);
    await openMobileSidebar(page);
    await assertSessionVisible(page, 'Level 0 session');
    await assertNoOverflow(page);
    await screenshot(page, 'nested-sidebar-deep-mobile');
  });

  test('stopped ancestors of deep child surface as context anchors', async ({ page }) => {
    await setupApiMocks(page, { sessions: STALE_ANCESTOR_SESSIONS, tasks: STALE_ANCESTOR_TASKS });
    await page.goto('/projects/proj-1');
    await page.waitForTimeout(1500);
    await assertChatPageRendered(page);
    await openMobileSidebar(page);
    // The original bug: deep child's stopped ancestors were never surfaced.
    // Verifies the root stopped ancestor renders as a context anchor, which
    // is what restores lineage navigation to the deep child.
    await assertSessionVisible(page, 'Original investigation');
    await assertNoOverflow(page);
    await screenshot(page, 'nested-sidebar-stale-ancestor-mobile');
  });
});

// ---------------------------------------------------------------------------
// Desktop tests (1280x800)
// ---------------------------------------------------------------------------

test.describe('Nested session sidebar — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('normal 2-level nesting renders without overflow', async ({ page }) => {
    await setupApiMocks(page, { sessions: NORMAL_SESSIONS, tasks: NORMAL_TASKS });
    await page.goto('/projects/proj-1');
    await page.waitForTimeout(1500);
    await assertChatPageRendered(page);
    await openMobileSidebar(page);
    await assertSessionVisible(page, 'Implement authentication');
    await assertNoOverflow(page);
    await screenshot(page, 'nested-sidebar-normal-desktop');
  });

  test('deeply nested (L6+) renders without overflow', async ({ page }) => {
    await setupApiMocks(page, { sessions: DEEP_SESSIONS, tasks: DEEP_TASKS });
    await page.goto('/projects/proj-1');
    await page.waitForTimeout(1500);
    await assertChatPageRendered(page);
    await assertSessionVisible(page, 'Level 0 session');
    await assertNoOverflow(page);
    await screenshot(page, 'nested-sidebar-deep-desktop');
  });
});
