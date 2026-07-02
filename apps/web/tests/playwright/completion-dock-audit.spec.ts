import { expect, type Page, type Route, test } from '@playwright/test';

import { seedTheme } from './audit-helpers';

// ---------------------------------------------------------------------------
// CompletionDock visual audit against the REAL project chat UI.
//
// The dock replaces the two former state strips in ProjectMessageView. It is
// driven entirely by the existing lifecycle signal: the dock's `working` prop is
// `lc.agentActivity !== 'idle'`. `agentActivity` is hydrated at session-load
// time from the session-detail response's `state.activity` field. So to render
// the WORKING morph (red Interrupt + spinner ring + Plan pill + elapsed) we mock
// the session detail with `state.activity === 'prompting'`; to render the IDLE
// morph (grey Archive) we omit `state` (defaults to idle) on an active session.
//
// Captured at mobile (375x667) and desktop (1280x800), dark (sam) and light
// (sam-light), both dock states, asserting no horizontal overflow.
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

function makeSession() {
  return {
    id: 'session-1',
    workspaceId: 'ws-1',
    taskId: null,
    topic: 'Active Chat Session',
    status: 'active',
    messageCount: 6,
    startedAt: NOW - 60000,
    endedAt: null,
    createdAt: NOW - 120000,
    lastMessageAt: NOW - 30000,
    isIdle: false,
    agentCompletedAt: null,
    isTerminated: false,
    workspaceUrl: null,
    cleanupAt: null,
    agentSessionId: 'agent-sess-1',
    agentType: 'claude-code',
    // Conversation-mode task embed — the dock's Archive morph is only wired for
    // conversation-mode sessions the caller can close (task-mode never archives).
    task: {
      id: 'task-conv-1',
      status: 'in_progress',
      taskMode: 'conversation',
      executionStep: null,
      errorMessage: null,
      outputBranch: null,
      outputPrUrl: null,
      outputSummary: null,
      finalizedAt: null,
    },
  };
}

function makeMessage(overrides: { id: string; role: string; content: string; index: number }) {
  return {
    id: overrides.id,
    sessionId: 'session-1',
    role: overrides.role,
    content: overrides.content,
    toolMetadata: null,
    createdAt: NOW - (6 - overrides.index) * 10000,
    sequence: overrides.index,
  };
}

const MESSAGES = Array.from({ length: 6 }, (_, i) =>
  makeMessage({
    id: `msg-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content:
      i % 2 === 0
        ? `User message ${i}: Can you help me with this task?`
        : `Assistant message ${i}: Here is a detailed response that helps verify the dock renders above the composer.`,
    index: i,
  })
);

// Working-state snapshot: drives agentActivity='prompting' + a plan (Plan pill)
// + promptStartedAt (elapsed slot).
const WORKING_STATE = {
  activity: 'prompting',
  activityAt: NOW,
  statusError: null,
  currentPlan: [
    { content: 'Investigate the failing test', status: 'completed' },
    { content: 'Patch the lifecycle handler', status: 'in_progress' },
    { content: 'Add a regression test', status: 'pending' },
  ],
  planUpdatedAt: NOW,
  promptStartedAt: NOW - 45000,
  agentType: 'claude-code',
  lastStopReason: null,
};

const IDLE_STATE = {
  activity: 'idle',
  activityAt: NOW,
  statusError: null,
  currentPlan: null,
  planUpdatedAt: null,
  promptStartedAt: null,
  agentType: 'claude-code',
  lastStopReason: null,
};

async function setupApiMocks(page: Page, opts: { working: boolean }) {
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

      if (subPath === '/sessions') {
        return respond(200, { sessions: [makeSession()], total: 1, hasMore: false });
      }

      const sessionDetailMatch = subPath.match(/^\/sessions\/([^/]+)$/);
      if (sessionDetailMatch) {
        return respond(200, {
          session: makeSession(),
          messages: MESSAGES,
          hasMore: false,
          state: opts.working ? WORKING_STATE : IDLE_STATE,
        });
      }

      if (subPath.match(/\/sessions\/[^/]+\/messages/)) {
        return respond(200, MESSAGES);
      }

      if (subPath === '/tasks') return respond(200, { tasks: [], nextCursor: null });
      if (subPath === '/agent-profiles') return respond(200, { items: [] });
      if (subPath.match(/\/commands/)) return respond(200, { commands: [] });

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

async function gotoChat(page: Page) {
  await page.goto('/projects/proj-test-1/chat/session-1');
  await page.waitForTimeout(1500);
}

// ---------------------------------------------------------------------------
// Audit matrix: {dark, light} x {mobile, desktop} x {idle, working}
// ---------------------------------------------------------------------------

for (const theme of ['dark', 'light'] as const) {
  test.describe(`CompletionDock — ${theme} — Desktop`, () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('idle: grey Archive control', async ({ page }) => {
      await seedTheme(page, theme);
      await setupApiMocks(page, { working: false });
      await gotoChat(page);
      await expect(page.getByRole('button', { name: 'Archive conversation' })).toBeVisible();
      await screenshot(page, `completion-dock-idle-${theme}-desktop`);
      await assertNoOverflow(page);
    });

    test('working: red Interrupt + spinner + plan pill', async ({ page }) => {
      await seedTheme(page, theme);
      await setupApiMocks(page, { working: true });
      await gotoChat(page);
      await expect(page.getByRole('button', { name: 'Interrupt agent' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'View plan' })).toBeVisible();
      await screenshot(page, `completion-dock-working-${theme}-desktop`);
      await assertNoOverflow(page);
    });
  });

  test.describe(`CompletionDock — ${theme} — Mobile`, () => {
    test('idle: grey Archive control', async ({ page }) => {
      await seedTheme(page, theme);
      await setupApiMocks(page, { working: false });
      await gotoChat(page);
      await expect(page.getByRole('button', { name: 'Archive conversation' })).toBeVisible();
      await screenshot(page, `completion-dock-idle-${theme}-mobile`);
      await assertNoOverflow(page);
    });

    test('working: red Interrupt + spinner + plan pill', async ({ page }) => {
      await seedTheme(page, theme);
      await setupApiMocks(page, { working: true });
      await gotoChat(page);
      await expect(page.getByRole('button', { name: 'Interrupt agent' })).toBeVisible();
      await screenshot(page, `completion-dock-working-${theme}-mobile`);
      await assertNoOverflow(page);
    });
  });
}
