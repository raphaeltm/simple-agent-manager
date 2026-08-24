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
// the session detail with `state.activity === 'prompting'`; to render the awake
// IDLE morph (Sleep) we use an idle state on an active taskless instant session,
// matching the Cloudflare Container chat path. A separate sleeping scenario
// verifies Archive is only exposed after the reversible sleep boundary.
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

const MOCK_CLOUD_CREDENTIALS = [
  {
    id: 'cred-cloud-1',
    provider: 'hetzner',
    connected: true,
    createdAt: '2026-01-01T00:00:00Z',
  },
];

const MOCK_AGENT_CREDENTIALS = {
  credentials: [
    {
      agentType: 'claude-code',
      provider: 'anthropic',
      credentialKind: 'api-key',
      isActive: true,
      maskedKey: 'sk-ant-••••test',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ],
};

const MOCK_GITHUB_INSTALLATIONS = [
  {
    id: 'gh-inst-1',
    userId: 'user-test-1',
    installationId: 'inst-1',
    accountType: 'personal',
    accountName: 'testuser',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
];

const NOW = Date.now();

type CompletionDockMode = 'working' | 'idle' | 'sleeping';

function makeSession(status: 'active' | 'sleeping' = 'active') {
  return {
    id: 'session-1',
    workspaceId: 'ws-1',
    taskId: null,
    topic: 'Active Chat Session',
    status,
    messageCount: 6,
    startedAt: NOW - 60000,
    endedAt: null,
    createdAt: NOW - 120000,
    lastMessageAt: NOW - 30000,
    isIdle: status === 'sleeping',
    agentCompletedAt: null,
    isTerminated: false,
    workspaceUrl: null,
    cleanupAt: null,
    agentSessionId: 'agent-sess-1',
    agentType: 'claude-code',
    task: null,
  };
}

function makeWorkspace(status: 'running' | 'sleeping' = 'running') {
  return {
    id: 'ws-1',
    nodeId: 'node-1',
    projectId: MOCK_PROJECT.id,
    name: 'test-workspace',
    displayName: 'Test workspace',
    repository: MOCK_PROJECT.repository,
    branch: 'main',
    status,
    vmSize: 'cx22',
    vmLocation: 'fsn1',
    workspaceProfile: 'full',
    devcontainerConfigName: null,
    vmIp: '203.0.113.10',
    lastActivityAt: new Date(NOW - 30000).toISOString(),
    portsPublicEnabled: false,
    errorMessage: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: new Date(NOW).toISOString(),
    url: null,
    bootLogs: [],
    chatSessionId: 'session-1',
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
  currentPlan: [
    { content: 'Keep the last plan visible while idle', status: 'completed' },
    { content: 'Wait for the next follow-up', status: 'pending' },
  ],
  planUpdatedAt: NOW - 30000,
  promptStartedAt: null,
  agentType: 'claude-code',
  lastStopReason: null,
};

async function setupApiMocks(page: Page, opts: { mode: CompletionDockMode }) {
  const state: { mode: CompletionDockMode; sleepRequests: string[] } = {
    mode: opts.mode,
    sleepRequests: [],
  };

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/credentials/agent') return respond(200, MOCK_AGENT_CREDENTIALS);
    if (path.startsWith('/api/credentials')) return respond(200, MOCK_CLOUD_CREDENTIALS);
    if (path.startsWith('/api/provider-catalog')) return respond(200, { catalogs: [] });
    if (path === '/api/trial/status') return respond(200, { available: false });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/github/installations') return respond(200, MOCK_GITHUB_INSTALLATIONS);
    if (path === '/api/workspaces') {
      return respond(200, [makeWorkspace(state.mode === 'sleeping' ? 'sleeping' : 'running')]);
    }
    if (path === '/api/workspaces/ws-1/sleep') {
      if (route.request().method() !== 'POST') {
        return respond(405, { error: 'METHOD_NOT_ALLOWED' });
      }
      state.sleepRequests.push(`${route.request().method()} ${path}`);
      state.mode = 'sleeping';
      return respond(200, {
        status: 'sleeping',
        workspaceId: 'ws-1',
        chatSessionId: 'session-1',
        snapshotExpiresAt: '2026-08-28T00:00:00.000Z',
      });
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      const session = makeSession(state.mode === 'sleeping' ? 'sleeping' : 'active');

      if (subPath === '/sessions') {
        return respond(200, { sessions: [session], total: 1, hasMore: false });
      }

      const sessionDetailMatch = subPath.match(/^\/sessions\/([^/]+)$/);
      if (sessionDetailMatch) {
        return respond(200, {
          session,
          messages: MESSAGES,
          hasMore: false,
          state: state.mode === 'working' ? WORKING_STATE : IDLE_STATE,
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

    if (path === '/api/projects')
      return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });

    return respond(404, { error: 'UNMOCKED_API_ROUTE', path });
  });

  return state;
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(700);
  const viewport = page.viewportSize();
  const suffix = viewport ? `-${viewport.width}x${viewport.height}` : '';
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}${suffix}.png`,
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

    test('awake idle: blue Sleep control + plan pill', async ({ page }) => {
      await seedTheme(page, theme);
      await setupApiMocks(page, { mode: 'idle' });
      await gotoChat(page);
      await expect(page.getByRole('button', { name: 'Sleep session' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Archive conversation' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'View plan' })).toBeVisible();
      await screenshot(page, `completion-dock-sleep-${theme}-desktop`);
      await assertNoOverflow(page);
    });

    if (theme === 'dark') {
      test('awake idle: clicking Sleep posts to workspace sleep and refreshes to Archive', async ({
        page,
      }) => {
        await seedTheme(page, theme);
        const apiState = await setupApiMocks(page, { mode: 'idle' });
        await gotoChat(page);

        await page.getByRole('button', { name: 'Sleep session' }).click();

        await expect
          .poll(() => apiState.sleepRequests)
          .toEqual(['POST /api/workspaces/ws-1/sleep']);
        await expect(page.getByRole('button', { name: 'Archive conversation' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Sleep session' })).toHaveCount(0);
        await assertNoOverflow(page);
      });
    }

    test('sleeping: grey Archive control + confirmation', async ({ page }) => {
      await seedTheme(page, theme);
      await setupApiMocks(page, { mode: 'sleeping' });
      await gotoChat(page);
      await page.getByRole('button', { name: 'Archive conversation' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByText('Archive conversation?')).toBeVisible();
      await screenshot(page, `completion-dock-archive-confirm-${theme}-desktop`);
      await assertNoOverflow(page);
    });

    test('working: red Interrupt + spinner + plan pill', async ({ page }) => {
      await seedTheme(page, theme);
      await setupApiMocks(page, { mode: 'working' });
      await gotoChat(page);
      await expect(page.getByRole('button', { name: 'Interrupt agent' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'View plan' })).toBeVisible();
      await screenshot(page, `completion-dock-working-${theme}-desktop`);
      await assertNoOverflow(page);
    });
  });

  test.describe(`CompletionDock — ${theme} — Mobile`, () => {
    test('awake idle: blue Sleep control + plan pill', async ({ page }) => {
      await seedTheme(page, theme);
      await setupApiMocks(page, { mode: 'idle' });
      await gotoChat(page);
      await expect(page.getByRole('button', { name: 'Sleep session' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Archive conversation' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'View plan' })).toBeVisible();
      await screenshot(page, `completion-dock-sleep-${theme}-mobile`);
      await assertNoOverflow(page);
    });

    test('sleeping: grey Archive control + confirmation', async ({ page }) => {
      await seedTheme(page, theme);
      await setupApiMocks(page, { mode: 'sleeping' });
      await gotoChat(page);
      await page.getByRole('button', { name: 'Archive conversation' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByText('Archive conversation?')).toBeVisible();
      await screenshot(page, `completion-dock-archive-confirm-${theme}-mobile`);
      await assertNoOverflow(page);
    });

    test('working: red Interrupt + spinner + plan pill', async ({ page }) => {
      await seedTheme(page, theme);
      await setupApiMocks(page, { mode: 'working' });
      await gotoChat(page);
      await expect(page.getByRole('button', { name: 'Interrupt agent' })).toBeVisible();
      await screenshot(page, `completion-dock-working-${theme}-mobile`);
      await assertNoOverflow(page);
    });
  });
}
