import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Visual audit for agent info in the SessionHeader expanded panel.
//
// Verifies that agent type, task mode, and profile hint display correctly
// in the expanded session details without horizontal overflow.
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
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) => respondJson(route, body, status);

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/terminal/token') {
      return respond(200, { token: 'terminal-token', expiresAt: new Date(NOW + 600000).toISOString() });
    }
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
      if (subPath === '/sessions') {
        return respond(200, { sessions, total: sessions.length });
      }
      // Session detail
      if (subPath.match(/\/sessions\/[^/]+$/) && !subPath.includes('/messages')) {
        return respond(200, { session, messages: detailMessages, hasMore: detailHasMore });
      }
      if (subPath.match(/\/sessions\/[^/]+\/messages/)) {
        const roles = url.searchParams.get('roles')?.split(',').filter(Boolean);
        const limit = Number.parseInt(url.searchParams.get('limit') ?? String(messageLookupMessages.length), 10);
        const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';
        const filtered = roles && roles.length > 0
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

    if (path === '/api/projects') return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    return respond(200, {});
  });
}

function respondJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(800);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function expandHeader(page: Page) {
  const expandBtn = page.locator('button[aria-label="Show session details"]').first();
  await expandBtn.waitFor({ state: 'visible', timeout: 10000 });
  await expandBtn.click();
  await page.waitForTimeout(300);
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflow).toBe(false);
}

const STRESS_TITLE =
  'Investigate a crowded mobile session header with a long conversation title, unicode Ω, HTML-looking text <script>alert(1)</script>, and a single-super-long-token-that-must-wrap-without-breaking-the-layout-abcdefghijklmnopqrstuvwxyz0123456789';

const STRESS_INITIAL_PROMPT =
  'Please review the production conversation header and make the full title plus initial prompt easy to inspect on mobile.\n\nInclude a very long sentence, unicode Ω, emoji-like text, escaped-looking HTML <script>alert(1)</script>, and enough detail to prove the prompt panel scrolls instead of pushing controls off screen. '.repeat(3);

function makeStressPorts() {
  return Array.from({ length: 50 }, (_, index) => {
    const port = 3000 + index;
    return {
      port,
      address: '127.0.0.1',
      label: `Stress forwarded service ${index + 1}`,
      url: `https://ws-ws-1--${port}.workspaces.example.com`,
      detectedAt: new Date(NOW - index * 1000).toISOString(),
    };
  });
}

function makeStressInitialMessage() {
  return {
    id: 'msg-initial-prompt',
    sessionId: 'chat-session-1',
    role: 'user',
    content: STRESS_INITIAL_PROMPT,
    toolMetadata: null,
    createdAt: NOW - 900000,
  };
}

test.describe('SessionHeader Agent Info — Mobile', () => {
  test('claude-code agent with task mode', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-agent-1/chat/chat-session-1');
    await expandHeader(page);
    await screenshot(page, 'session-header-agent-claude-code-mobile');

    // Verify agent info is visible in the expanded details panel
    await expect(page.getByText('Claude Code')).toBeVisible();
    await assertNoOverflow(page);
  });

  test('openai-codex agent with conversation mode', async ({ page }) => {
    await setupApiMocks(page, {
      session: makeSession({
        agentType: 'openai-codex',
        task: {
          id: 'task-1',
          status: 'in_progress',
          executionStep: 'agent_session',
          errorMessage: null,
          outputBranch: null,
          outputPrUrl: null,
          outputSummary: null,
          finalizedAt: null,
          taskMode: 'conversation',
          agentProfileHint: 'codex-fast',
        },
      }),
    });
    await page.goto('/projects/proj-agent-1/chat/chat-session-1');
    await expandHeader(page);
    await screenshot(page, 'session-header-agent-codex-conversation-mobile');

    await expect(page.getByText('OpenAI Codex')).toBeVisible();
    await expect(page.getByText('Conversation')).toBeVisible();
    await expect(page.getByText('codex-fast')).toBeVisible();
    await assertNoOverflow(page);
  });

  test('no agent info section when all fields are null', async ({ page }) => {
    await setupApiMocks(page, {
      session: makeSession({
        agentType: null,
        task: {
          id: 'task-1',
          status: 'in_progress',
          executionStep: 'agent_session',
          errorMessage: null,
          outputBranch: null,
          outputPrUrl: null,
          outputSummary: null,
          finalizedAt: null,
          taskMode: null,
          agentProfileHint: null,
        },
      }),
    });
    await page.goto('/projects/proj-agent-1/chat/chat-session-1');
    await expandHeader(page);
    await screenshot(page, 'session-header-no-agent-info-mobile');

    // The agent info row should not render at all — no Bot icon visible in details
    const detailsPanel = page.locator('.bg-inset');
    // "Claude Code" and "OpenAI Codex" should not appear in the details panel
    await expect(detailsPanel.getByText('Claude Code')).not.toBeVisible();
    await expect(detailsPanel.getByText('OpenAI Codex')).not.toBeVisible();
    await assertNoOverflow(page);
  });

  test('long profile hint wraps without overflow', async ({ page }) => {
    await setupApiMocks(page, {
      session: makeSession({
        agentType: 'claude-code',
        task: {
          id: 'task-1',
          status: 'in_progress',
          executionStep: 'agent_session',
          errorMessage: null,
          outputBranch: null,
          outputPrUrl: null,
          outputSummary: null,
          finalizedAt: null,
          taskMode: 'task',
          agentProfileHint:
            'custom-profile-with-very-long-name-that-might-overflow-on-mobile-viewport',
        },
      }),
    });
    await page.goto('/projects/proj-agent-1/chat/chat-session-1');
    await expandHeader(page);
    await screenshot(page, 'session-header-long-profile-hint-mobile');
    await assertNoOverflow(page);
  });

  test('fork source context wraps without overflow', async ({ page }) => {
    const parentSession = makeSession({
      id: 'parent-session-with-a-long-id-1234567890',
      taskId: 'parent-task-with-a-long-id-1234567890',
      topic:
        'Parent session title with a very long description, unicode Ω, and escaped-looking text <script>alert(1)</script> that must stay readable',
      startedAt: NOW - 900000,
    });
    const childSession = makeSession({
      id: 'chat-session-1',
      taskId: 'task-1',
      topic: 'Forked follow-up session',
    });

    await setupApiMocks(page, {
      session: childSession,
      sessions: [parentSession, childSession],
      tasks: [
        makeTask({
          id: 'parent-task-with-a-long-id-1234567890',
          title: 'Parent task title fallback',
          parentTaskId: null,
        }),
        makeTask({
          id: 'task-1',
          title: 'Forked follow-up session',
          parentTaskId: 'parent-task-with-a-long-id-1234567890',
        }),
      ],
    });

    await page.goto('/projects/proj-agent-1/chat/chat-session-1');
    await expandHeader(page);
    await screenshot(page, 'session-header-source-context-mobile');

    await expect(page.getByText('Source')).toBeVisible();
    await expect(page.getByRole('link', { name: /Parent session title with a very long description/ })).toBeVisible();
    await expect(page.getByTitle(/Parent task:/)).toBeVisible();
    await expect(page.getByTitle(/Parent session:/)).toBeVisible();
    await assertNoOverflow(page);
  });

  test('title-led header handles long title, initial prompt, and many ports', async ({ page }) => {
    await setupApiMocks(page, {
      session: makeSession({
        topic: STRESS_TITLE,
        messageCount: 75,
      }),
      detailHasMore: true,
      messageLookupMessages: [
        makeStressInitialMessage(),
        {
          id: 'msg-followup',
          sessionId: 'chat-session-1',
          role: 'user',
          content: 'Follow-up prompt',
          toolMetadata: null,
          createdAt: NOW - 100000,
        },
      ],
      ports: makeStressPorts(),
      workspace: { portsPublicEnabled: false },
    });

    await page.goto('/projects/proj-agent-1/chat/chat-session-1');
    await expect(page.getByRole('button', { name: 'Show 49 more forwarded ports' })).toBeVisible();
    await expandHeader(page);
    await expect(page.getByText('Initial prompt', { exact: true })).toBeVisible();
    await expect(page.getByText(/Please review the production conversation header/)).toBeVisible();
    await expect(page.getByText('Ports (50)')).toBeVisible();
    await screenshot(page, 'session-header-title-led-stress-mobile');
    await assertNoOverflow(page);
  });
});

test.describe('SessionHeader Agent Info — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('agent info displays on desktop', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-agent-1/chat/chat-session-1');
    await expandHeader(page);
    await screenshot(page, 'session-header-agent-info-desktop');

    await expect(page.getByText('Claude Code')).toBeVisible();
    await assertNoOverflow(page);
  });

  test('fork source context displays on desktop', async ({ page }) => {
    const parentSession = makeSession({
      id: 'parent-session-1',
      taskId: 'parent-task-1',
      topic: 'Parent implementation session',
      startedAt: NOW - 900000,
    });
    const childSession = makeSession({
      id: 'chat-session-1',
      taskId: 'task-1',
      topic: 'Forked implementation session',
    });

    await setupApiMocks(page, {
      session: childSession,
      sessions: [parentSession, childSession],
      tasks: [
        makeTask({ id: 'parent-task-1', title: 'Parent implementation task' }),
        makeTask({ id: 'task-1', title: 'Forked implementation task', parentTaskId: 'parent-task-1' }),
      ],
    });

    await page.goto('/projects/proj-agent-1/chat/chat-session-1');
    await expandHeader(page);
    await screenshot(page, 'session-header-source-context-desktop');

    await expect(page.getByText('Source')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Parent implementation session' })).toBeVisible();
    await assertNoOverflow(page);
  });

  test('title-led stress scenario displays on desktop', async ({ page }) => {
    await setupApiMocks(page, {
      session: makeSession({
        topic: STRESS_TITLE,
        messageCount: 75,
      }),
      detailHasMore: true,
      messageLookupMessages: [makeStressInitialMessage()],
      ports: makeStressPorts(),
      workspace: { portsPublicEnabled: true },
    });

    await page.goto('/projects/proj-agent-1/chat/chat-session-1');
    await expect(page.getByRole('button', { name: 'Show 49 more forwarded ports' })).toBeVisible();
    await expandHeader(page);
    await expect(page.getByText(/Please review the production conversation header/)).toBeVisible();
    await expect(page.getByText('Ports (50)')).toBeVisible();
    await screenshot(page, 'session-header-title-led-stress-desktop');
    await assertNoOverflow(page);
  });
});

test.describe('SessionHeader Public Ports', () => {
  const ports = [
    {
      port: 5173,
      address: '127.0.0.1',
      label: 'Vite',
      url: 'https://ws-ws-1--5173.workspaces.example.com',
      detectedAt: new Date(NOW - 1000).toISOString(),
    },
    {
      port: 3000,
      address: '127.0.0.1',
      label: 'Next.js preview server with a long descriptive label',
      url: 'https://ws-ws-1--3000.workspaces.example.com',
      detectedAt: new Date(NOW - 2000).toISOString(),
    },
  ];

  test('mobile switch toggles without overflow', async ({ page }) => {
    await setupApiMocks(page, { ports, workspace: { portsPublicEnabled: false } });
    await page.goto('/projects/proj-agent-1/chat/chat-session-1');

    const toggle = page.getByRole('switch', { name: 'Enable public forwarded ports' });
    await expect(toggle).toBeVisible();
    await expect(page.getByText('Forwarded port URLs require a SAM access token.')).toBeVisible();
    await toggle.click();
    await expect(page.getByRole('switch', { name: 'Disable public forwarded ports' })).toBeVisible();
    await expect(page.getByText('Forwarded port URLs are open to anyone with the link.')).toBeVisible();

    await screenshot(page, 'session-header-public-ports-mobile');
    await assertNoOverflow(page);
  });

  test('desktop switch shows enabled state without overflow', async ({ page }) => {
    await setupApiMocks(page, { ports, workspace: { portsPublicEnabled: true } });
    await page.goto('/projects/proj-agent-1/chat/chat-session-1');

    await expect(page.getByRole('switch', { name: 'Disable public forwarded ports' })).toBeVisible();
    await expect(page.getByText('Forwarded port URLs are open to anyone with the link.')).toBeVisible();
    await screenshot(page, 'session-header-public-ports-desktop');
    await assertNoOverflow(page);
  });
});
