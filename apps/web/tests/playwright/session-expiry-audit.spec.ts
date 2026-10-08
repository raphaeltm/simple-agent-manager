import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Visual audit for expired conversations in the chat header and list.
//
// Verifies readable transcripts, the Expired label, and the Fork action on
// desktop and mobile, including tasks absent from the recent-task page.
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
  id: 'proj-agent-1',
  name: 'Agent Info Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function makeWorkspace(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ws-1',
    nodeId: 'node-1',
    projectId: 'proj-agent-1',
    name: 'ws-test-1',
    displayName: 'Test Workspace',
    repository: 'testuser/test-repo',
    branch: 'main',
    status: 'running',
    vmSize: 'medium',
    vmLocation: 'fsn1',
    workspaceProfile: 'full',
    vmIp: '10.0.0.1',
    url: 'https://ws-ws-1.workspaces.example.com',
    lastActivityAt: new Date(NOW - 30000).toISOString(),
    errorMessage: null,
    createdAt: new Date(NOW - 600000).toISOString(),
    updatedAt: new Date(NOW - 30000).toISOString(),
    ...overrides,
  };
}

const MOCK_NODE = {
  id: 'node-1',
  name: 'node-test-1',
  status: 'running',
  healthStatus: 'healthy',
  cloudProvider: 'hetzner',
  vmSize: 'medium',
  vmLocation: 'fsn1',
  ipAddress: '10.0.0.1',
  lastHeartbeatAt: new Date(NOW - 10000).toISOString(),
  errorMessage: null,
  createdAt: new Date(NOW - 600000).toISOString(),
  updatedAt: new Date(NOW - 10000).toISOString(),
};

function makeSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'chat-session-1',
    workspaceId: 'ws-1',
    taskId: 'task-1',
    topic: 'Implement feature X',
    status: 'active',
    messageCount: 5,
    startedAt: NOW - 300000,
    endedAt: null,
    createdAt: NOW - 600000,
    lastMessageAt: NOW - 30000,
    isIdle: false,
    isTerminated: false,
    agentSessionId: 'acp-session-1',
    agentType: 'claude-code',
    task: {
      id: 'task-1',
      status: 'in_progress',
      executionStep: 'agent_session',
      errorMessage: null,
      outputBranch: 'sam/feature-x',
      outputPrUrl: null,
      outputSummary: null,
      finalizedAt: null,
      taskMode: 'task',
      agentProfileHint: 'default',
    },
    ...overrides,
  };
}

function makeTask(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'task-1',
    projectId: 'proj-agent-1',
    title: 'Implement feature X',
    description: 'Implement feature X',
    status: 'in_progress',
    priority: 0,
    parentTaskId: null,
    blocked: false,
    triggeredBy: 'user',
    dispatchDepth: 0,
    taskMode: 'task',
    createdAt: new Date(NOW - 600000).toISOString(),
    updatedAt: new Date(NOW - 30000).toISOString(),
    ...overrides,
  };
}

async function setupApiMocks(
  page: Page,
  opts: {
    ports?: Array<Record<string, unknown>>;
    detailMessages?: Array<Record<string, unknown>>;
    detailHasMore?: boolean;
    messageLookupMessages?: Array<Record<string, unknown>>;
    session?: Record<string, unknown>;
    sessions?: Array<Record<string, unknown>>;
    tasks?: Array<Record<string, unknown>>;
    workspace?: Record<string, unknown>;
  } = {}
) {
  const session = opts.session ?? makeSession();
  const sessions = opts.sessions ?? [session];
  const tasks = opts.tasks ?? [makeTask()];
  const workspace = makeWorkspace(opts.workspace);
  const ports = opts.ports ?? [];
  const detailMessages = opts.detailMessages ?? [];
  const messageLookupMessages = opts.messageLookupMessages ?? detailMessages;
  const detailHasMore = opts.detailHasMore ?? false;

  await page.route('**/workspaces/ws-1/ports**', (route: Route) => respondJson(route, { ports }));
  await page.routeWebSocket('**/api/**', () => {});
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const respond = (status: number, body: unknown) => respondJson(route, body, status);

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/terminal/token') {
      return respond(200, {
        token: 'terminal-token',
        expiresAt: new Date(NOW + 600000).toISOString(),
      });
    }
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/credentials/agent') {
      return respond(200, {
        credentials: [
          {
            agentType: 'claude-code',
            provider: 'anthropic',
            credentialKind: 'oauth-token',
            isActive: true,
            maskedKey: 'oauth-••••',
            label: 'Mock subscription',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });
    }
    if (path.startsWith('/api/credentials')) {
      return respond(200, [
        {
          id: 'cred-hetzner-1',
          provider: 'hetzner',
          connected: true,
          createdAt: '2026-01-01T00:00:00Z',
        },
      ]);
    }
    if (path.startsWith('/api/provider-catalog')) return respond(200, { catalogs: [] });
    if (path.startsWith('/api/github/installations')) {
      return respond(200, [
        {
          id: 'inst-1',
          accountLogin: 'testuser',
          accountType: 'User',
          repositorySelection: 'all',
        },
      ]);
    }
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

    // Workspace and node routes
    if (path === '/api/workspaces/ws-1') return respond(200, workspace);
    if (path === '/api/workspaces/ws-1/ports-public') {
      const body = route.request().postDataJSON() as { enabled?: boolean };
      workspace.portsPublicEnabled = Boolean(body.enabled);
      return respond(200, workspace);
    }
    if (path.startsWith('/api/workspaces/ws-1/ports')) return respond(200, { ports });
    if (path === '/api/nodes/node-1') return respond(200, MOCK_NODE);

    // Project routes
    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '/skills') return respond(200, { items: [] });
      if (subPath === '/sessions') {
        return respond(200, { sessions, total: sessions.length });
      }
      // Session detail
      if (subPath.match(/\/sessions\/[^/]+$/) && !subPath.includes('/messages')) {
        return respond(200, { session, messages: detailMessages, hasMore: detailHasMore });
      }
      if (subPath.match(/\/sessions\/[^/]+\/messages/)) {
        const roles = url.searchParams.get('roles')?.split(',').filter(Boolean);
        const limit = Number.parseInt(
          url.searchParams.get('limit') ?? String(messageLookupMessages.length),
          10
        );
        const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';
        const filtered =
          roles && roles.length > 0
            ? messageLookupMessages.filter((msg) => roles.includes(String(msg.role)))
            : messageLookupMessages;
        const sorted = filtered.slice().sort((a, b) => {
          const timeA = Number(a.createdAt ?? 0);
          const timeB = Number(b.createdAt ?? 0);
          return order === 'asc' ? timeA - timeB : timeB - timeA;
        });
        return respond(200, { messages: sorted.slice(0, limit), hasMore: sorted.length > limit });
      }
      if (subPath === '/tasks') return respond(200, { tasks, nextCursor: null });
      if (subPath.match(/\/tasks\//)) return respond(200, { id: 'task-1', status: 'in_progress' });
      if (subPath === '/agents') return respond(200, { agents: [] });
      if (subPath === '/agent-profiles') return respond(200, { items: [] });
      if (subPath === '/cached-commands') return respond(200, { items: [] });
      if (subPath === '/triggers') return respond(200, { items: [] });
      if (subPath === '/knowledge') return respond(200, { entities: [], total: 0 });
      return respond(200, MOCK_PROJECT);
    }

    if (path === '/api/projects')
      return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    return respond(200, {});
  });
}

function respondJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

test('expired transcript, neutral label, and Fork remain usable', async ({ page }, testInfo) => {
  page.on('pageerror', error => console.log('PAGE ERROR', error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('BROWSER ERROR', message.text()); });
  const longTitle =
    'Saved workspace expired — readable transcript Ω ' + 'long conversation title '.repeat(12);
  const expiredTask = makeTask({
    status: 'cancelled',
    terminalReason: 'snapshot_expired',
    errorMessage: null,
  });
  const session = makeSession({
    status: 'stopped',
    topic: longTitle,
    endedAt: NOW,
    isTerminated: true,
    task: { ...expiredTask, taskMode: 'conversation' },
  });
  const sessions = Array.from({ length: 31 }, (_, i) => ({
    ...session,
    id: i ? `old-${i}` : session.id,
    taskId: i ? `old-task-${i}` : 'task-1',
    topic: i ? `Older conversation ${i}` : longTitle,
  }));
  await setupApiMocks(page, {
    session,
    sessions,
    // An old expired task is absent from the unrelated recent-task page.
    tasks: [],
    workspace: { status: 'deleted' },
    detailMessages: [
      {
        id: 'message-1',
        sessionId: 'chat-session-1',
        role: 'assistant',
        content: 'Your earlier work remains readable in this transcript.',
        createdAt: NOW - 1000,
      },
    ],
  });
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-user-1', 'true')
  );
  await page.goto('/projects/proj-agent-1/chat/chat-session-1');
  await expect(page.getByText('Expired', { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText('Your earlier work remains readable in this transcript.')
  ).toBeVisible();
  await expect(page.getByText(/The saved workspace has expired/)).toBeVisible();
  await expect(page.getByTestId('session-tool-fork').first()).toBeVisible();
  await expect(page.getByTestId('session-tool-retry')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const suffix = testInfo.project.name.startsWith('Desktop') ? 'desktop' : 'mobile';
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/expired-header-${suffix}.png`,
  });
  await page.getByRole('button', { name: 'Fork conversation', exact: true }).click();
  await expect(page.getByText(/Forking from:/)).toBeVisible();
  // No agent is configured in this fixture, so the composer shows its add-an-agent placeholder.
  await expect(page.getByRole('combobox')).toHaveValue(/Parent session ID: chat-session-1/);
  await page.goto('/projects/proj-agent-1/chat/chat-session-1');
  const openList = page.getByRole('button', { name: 'Open chat list' });
  if (suffix === 'mobile') {
    await expect(openList).toBeVisible();
    await openList.click();
  }
  await expect(page.getByPlaceholder('Search chats...')).toBeVisible();
  await expect(page.getByText('Older conversation 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Expired', { exact: true }).first()).toBeVisible();
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/expired-list-${suffix}.png`,
  });
});
