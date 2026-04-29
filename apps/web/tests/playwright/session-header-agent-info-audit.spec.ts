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

const MOCK_WORKSPACE = {
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
  lastActivityAt: new Date(NOW - 30000).toISOString(),
  errorMessage: null,
  createdAt: new Date(NOW - 600000).toISOString(),
  updatedAt: new Date(NOW - 30000).toISOString(),
};

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

async function setupApiMocks(
  page: Page,
  opts: { session?: Record<string, unknown> } = {}
) {
  const session = opts.session ?? makeSession();

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

    // Workspace and node routes
    if (path === '/api/workspaces/ws-1') return respond(200, MOCK_WORKSPACE);
    if (path.startsWith('/api/workspaces/ws-1/ports')) return respond(200, { ports: [] });
    if (path === '/api/nodes/node-1') return respond(200, MOCK_NODE);

    // Project routes
    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '/sessions') {
        return respond(200, { sessions: [session], total: 1 });
      }
      // Session detail
      if (subPath.match(/\/sessions\/[^/]+$/) && !subPath.includes('/messages')) {
        return respond(200, { session, messages: [], hasMore: false });
      }
      if (subPath.match(/\/sessions\/[^/]+\/messages/)) return respond(200, { messages: [], hasMore: false });
      if (subPath === '/tasks') return respond(200, { tasks: [], nextCursor: null });
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

test.describe('SessionHeader Agent Info — Mobile', () => {
  test('claude-code agent with task mode', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-agent-1/chat/chat-session-1');
    await expandHeader(page);
    await screenshot(page, 'session-header-agent-claude-code-mobile');

    // Verify agent info is visible in the expanded details panel
    const detailsPanel = page.locator('.bg-inset');
    await expect(detailsPanel.getByText('Claude Code')).toBeVisible();
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

    const detailsPanel = page.locator('.bg-inset');
    await expect(detailsPanel.getByText('OpenAI Codex')).toBeVisible();
    await expect(detailsPanel.getByText('Conversation')).toBeVisible();
    await expect(detailsPanel.getByText('codex-fast')).toBeVisible();
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
});

test.describe('SessionHeader Agent Info — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('agent info displays on desktop', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-agent-1/chat/chat-session-1');
    await expandHeader(page);
    await screenshot(page, 'session-header-agent-info-desktop');

    const detailsPanel = page.locator('.bg-inset');
    await expect(detailsPanel.getByText('Claude Code')).toBeVisible();
    await assertNoOverflow(page);
  });
});
