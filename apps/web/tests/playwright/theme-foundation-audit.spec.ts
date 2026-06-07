import { type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, expectTheme, makeMockUser, screenshot, seedTheme } from './audit-helpers';

// ---------------------------------------------------------------------------
// Theme Foundation Visual Audit
//
// Verifies the additive light-mode token layer + theme switcher:
//   - dark theme (default, data-ui-theme="sam") renders unchanged
//   - light theme (data-ui-theme="sam-light") renders with light tokens
//   - neither theme introduces horizontal overflow at 375px or 1280px
//
// The theme is selected via localStorage key 'sam-theme' (read pre-paint in
// main.tsx). We seed it with addInitScript so the attribute is applied before
// first render — exactly the production FOUC-prevention path.
// ---------------------------------------------------------------------------

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  role: 'superadmin',
  sessionId: 'session-test-1',
  userId: 'user-test-1',
});

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
    createdAt: NOW - (6 - overrides.index) * 10000,
    sequence: overrides.index,
  };
}

// A small message set that exercises both glass message bubble variants
// (user + assistant) so the tokenized backgrounds/borders render in the shot.
const MESSAGES = [
  makeMessage({ id: 'msg-0', role: 'user', content: 'Can you help me wire up the theme switcher?', index: 0 }),
  makeMessage({
    id: 'msg-1',
    role: 'assistant',
    content:
      'Absolutely. The light theme is fully additive — every value lives behind the [data-ui-theme="sam-light"] selector, so dark mode stays pixel-for-pixel identical.',
    index: 1,
  }),
  makeMessage({ id: 'msg-2', role: 'user', content: 'And the Tokyo Night code blocks stay dark?', index: 2 }),
  makeMessage({
    id: 'msg-3',
    role: 'assistant',
    content: 'Correct — the --sam-color-tn-* tokens are never overridden, so syntax islands stay dark in both themes.',
    index: 3,
  }),
  makeMessage({ id: 'msg-4', role: 'user', content: 'Great, ship the foundation.', index: 4 }),
  makeMessage({
    id: 'msg-5',
    role: 'assistant',
    content: 'On it. Toggle lives in the user menu (sun/moon), persisted to localStorage under sam-theme.',
    index: 5,
  }),
];

const SESSIONS = [makeSession({ id: 'session-1', topic: 'Theme Foundation Chat' })];

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
      if (subPath === '/sessions') {
        return respond(200, { sessions: SESSIONS, total: SESSIONS.length, hasMore: false });
      }
      const sessionDetailMatch = subPath.match(/^\/sessions\/([^/]+)$/);
      if (sessionDetailMatch) {
        const sid = sessionDetailMatch[1];
        const session = SESSIONS.find((s) => s.id === sid) ?? SESSIONS[0];
        return respond(200, { session, messages: MESSAGES, hasMore: false });
      }
      if (subPath.match(/\/sessions\/[^/]+\/messages/)) return respond(200, MESSAGES);
      if (subPath === '/tasks') return respond(200, { tasks: [], nextCursor: null });
      if (subPath === '/agent-profiles') return respond(200, { items: [] });
      if (subPath.match(/\/commands/)) return respond(200, { commands: [] });
      return respond(200, MOCK_PROJECT);
    }

    if (path === '/api/projects') return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });

    return respond(200, {});
  });
}

async function auditTheme(page: Page, theme: 'dark' | 'light', label: string) {
  await seedTheme(page, theme);
  await setupApiMocks(page);
  await page.goto('/projects/proj-test-1/chat/session-1');
  await page.waitForTimeout(1200);

  // The pre-paint init must have applied the correct theme attribute.
  await expectTheme(page, theme);

  // No theme may introduce horizontal overflow.
  await assertNoOverflow(page);

  await screenshot(page, `theme-${theme}-chat-${label}`);
}

test.describe('Theme foundation — Desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('dark theme renders without overflow', async ({ page }) => {
    await auditTheme(page, 'dark', 'desktop');
  });

  test('light theme renders without overflow', async ({ page }) => {
    await auditTheme(page, 'light', 'desktop');
  });
});

test.describe('Theme foundation — Mobile (375x667)', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('dark theme renders without overflow', async ({ page }) => {
    await auditTheme(page, 'dark', 'mobile');
  });

  test('light theme renders without overflow', async ({ page }) => {
    await auditTheme(page, 'light', 'mobile');
  });
});
