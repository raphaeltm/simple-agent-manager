import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Visual audit for the VM size-fallback downgrade annotation in the
// ProvisioningIndicator.
//
// When auto-provisioning a node fails on transient capacity and the task
// descends to a smaller VM size, the task records `provisionedVmSize`
// (smaller) alongside `requestedVmSize` (original). The provisioning panel
// surfaces a caption explaining the downgrade. This audit drives the project
// chat into a non-terminal provisioning state with a recorded downgrade and
// verifies the annotation renders without horizontal overflow.
// ---------------------------------------------------------------------------

const NOW = Date.now();
const PROJECT_ID = 'proj-downgrade-1';
const SESSION_ID = 'chat-session-1';
const TASK_ID = 'task-1';

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
  id: PROJECT_ID,
  name: 'Size Fallback Test Project',
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

const MOCK_SESSION = {
  id: SESSION_ID,
  workspaceId: null,
  taskId: TASK_ID,
  topic: 'Provision a large machine',
  status: 'active',
  messageCount: 0,
  startedAt: NOW - 60000,
  endedAt: null,
  createdAt: NOW - 60000,
  lastMessageAt: null,
  isIdle: false,
  isTerminated: false,
  agentSessionId: null,
  agentType: 'claude-code',
  task: {
    id: TASK_ID,
    status: 'queued',
    executionStep: 'node_provisioning',
    errorMessage: null,
    outputBranch: 'sam/feature-branch',
    outputPrUrl: null,
    outputSummary: null,
    finalizedAt: null,
    taskMode: 'task',
    agentProfileHint: 'default',
  },
};

// The task-detail payload consumed by getProjectTask() in useProjectChatState.
// A non-terminal, non-in_progress status keeps the provisioning panel visible.
function makeTaskDetail(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TASK_ID,
    projectId: PROJECT_ID,
    title: 'Provision a large machine',
    description: 'Provision a large machine',
    status: 'queued',
    executionStep: 'node_provisioning',
    errorMessage: null,
    outputBranch: 'sam/feature-branch',
    outputPrUrl: null,
    outputSummary: null,
    finalizedAt: null,
    startedAt: new Date(NOW - 60000).toISOString(),
    workspaceId: null,
    requestedVmSize: 'large',
    requestedVmSizeSource: 'project',
    provisionedVmSize: 'medium',
    createdAt: new Date(NOW - 60000).toISOString(),
    updatedAt: new Date(NOW - 10000).toISOString(),
    ...overrides,
  };
}

async function setupApiMocks(page: Page, taskDetail: Record<string, unknown>) {
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

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '/sessions') {
        return respond(200, { sessions: [MOCK_SESSION], total: 1 });
      }
      if (subPath.match(/\/sessions\/[^/]+$/) && !subPath.includes('/messages')) {
        return respond(200, { session: MOCK_SESSION, messages: [], hasMore: false });
      }
      if (subPath.match(/\/sessions\/[^/]+\/messages/)) return respond(200, { messages: [], hasMore: false });
      if (subPath === '/tasks') return respond(200, { tasks: [taskDetail], nextCursor: null });
      if (subPath.match(/\/tasks\//)) return respond(200, taskDetail);
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

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflow).toBe(false);
}

test.describe('ProvisioningIndicator size-fallback downgrade — Mobile', () => {
  test('surfaces known-size downgrade annotation', async ({ page }) => {
    await setupApiMocks(page, makeTaskDetail({ requestedVmSize: 'large', provisionedVmSize: 'medium' }));
    await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

    await expect(
      page.getByText('No large machines were available — provisioned a medium node instead.')
    ).toBeVisible({ timeout: 10000 });
    await screenshot(page, 'provisioning-downgrade-known-size-mobile');
    await assertNoOverflow(page);
  });

  test('surfaces unknown-requested-size downgrade annotation', async ({ page }) => {
    await setupApiMocks(page, makeTaskDetail({ requestedVmSize: null, provisionedVmSize: 'medium' }));
    await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

    await expect(
      page.getByText('Provisioned a medium node (a larger size was unavailable).')
    ).toBeVisible({ timeout: 10000 });
    await screenshot(page, 'provisioning-downgrade-unknown-size-mobile');
    await assertNoOverflow(page);
  });
});

test.describe('ProvisioningIndicator size-fallback downgrade — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('surfaces known-size downgrade annotation', async ({ page }) => {
    await setupApiMocks(page, makeTaskDetail({ requestedVmSize: 'large', provisionedVmSize: 'medium' }));
    await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

    await expect(
      page.getByText('No large machines were available — provisioned a medium node instead.')
    ).toBeVisible({ timeout: 10000 });
    await screenshot(page, 'provisioning-downgrade-known-size-desktop');
    await assertNoOverflow(page);
  });
});
