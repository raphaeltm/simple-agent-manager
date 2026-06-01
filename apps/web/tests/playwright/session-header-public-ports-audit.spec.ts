import { expect, type Page, type Route, test } from '@playwright/test';

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
  id: 'proj-public-ports',
  name: 'Public Ports Test Project',
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

function makeWorkspace(portsPublicEnabled: boolean) {
  return {
    id: 'ws-1',
    nodeId: 'node-1',
    projectId: MOCK_PROJECT.id,
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
    portsPublicEnabled,
    lastActivityAt: new Date(NOW - 30000).toISOString(),
    errorMessage: null,
    createdAt: new Date(NOW - 600000).toISOString(),
    updatedAt: new Date(NOW - 30000).toISOString(),
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

const MOCK_SESSION = {
  id: 'chat-session-1',
  workspaceId: 'ws-1',
  taskId: 'task-1',
  topic: 'Preview server with active forwarded ports',
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
    outputBranch: 'sam/public-ports',
    outputPrUrl: null,
    outputSummary: null,
    finalizedAt: null,
    taskMode: 'task',
    agentProfileHint: 'default',
  },
};

const MOCK_PORTS = [
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

async function setupApiMocks(page: Page, initialPublic = false) {
  const workspace = makeWorkspace(initialPublic);

  await page.route('**/*', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/workspaces/ws-1/ports') return respond(200, { ports: MOCK_PORTS });
    if (!path.startsWith('/api/')) return route.continue();

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
    if (path === '/api/workspaces/ws-1') return respond(200, workspace);
    if (path === '/api/workspaces/ws-1/ports-public') {
      const body = route.request().postDataJSON() as { enabled?: boolean };
      workspace.portsPublicEnabled = Boolean(body.enabled);
      return respond(200, workspace);
    }
    if (path === '/api/nodes/node-1') return respond(200, MOCK_NODE);

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '/sessions') return respond(200, { sessions: [MOCK_SESSION], total: 1 });
      if (subPath.match(/\/sessions\/[^/]+$/) && !subPath.includes('/messages')) {
        return respond(200, { session: MOCK_SESSION, messages: [], hasMore: false });
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
  await page.waitForTimeout(500);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
}

test.describe('SessionHeader public ports switch', () => {
  test('mobile switch toggles without overflow', async ({ page }) => {
    await setupApiMocks(page, false);
    await page.goto('/projects/proj-public-ports/chat/chat-session-1');

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
    await setupApiMocks(page, true);
    await page.goto('/projects/proj-public-ports/chat/chat-session-1');

    await expect(page.getByRole('switch', { name: 'Disable public forwarded ports' })).toBeVisible();
    await expect(page.getByText('Forwarded port URLs are open to anyone with the link.')).toBeVisible();
    await screenshot(page, 'session-header-public-ports-desktop');
    await assertNoOverflow(page);
  });
});
