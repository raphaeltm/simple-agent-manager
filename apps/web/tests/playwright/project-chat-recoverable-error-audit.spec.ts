import { expect, type Page, type Route, test } from '@playwright/test';

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
  name: 'Recoverable Error Project',
  repository: 'testuser/recoverable-error-repo',
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
const LONG_RECOVERABLE_ERROR = [
  'Provider request failed after retry: account credits are exhausted for the selected model.',
  'The upstream response included request_id=req_01KWKDYXNB97J4Z5Q9RGS8APPF and status=402.',
  'Add credits or choose a different configured provider, then send another message in this same chat.',
  'This deliberately long diagnostic keeps going to verify wrapping on narrow screens without horizontal overflow, clipping, or covering the composer.',
  'Repeated detail: unavailable balance, quota limit, billing threshold, retry_after unavailable, workspace state preserved.',
  'LongUnbrokenDiagnosticSegment_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
].join(' ');

const MOCK_TASK = {
  id: 'task-recoverable-1',
  status: 'in_progress',
  executionStep: 'awaiting_followup',
  errorMessage: LONG_RECOVERABLE_ERROR,
  outputBranch: 'sam/recoverable-error-audit',
  outputPrUrl: null,
  outputSummary: null,
  finalizedAt: null,
  taskMode: 'conversation',
  agentProfileHint: 'Codex Chat',
};

const MOCK_SESSION = {
  id: 'session-recoverable-1',
  workspaceId: 'workspace-recoverable-1',
  taskId: MOCK_TASK.id,
  topic: 'Recoverable error chat',
  status: 'active',
  messageCount: 2,
  startedAt: NOW - 120000,
  endedAt: null,
  createdAt: NOW - 120000,
  lastMessageAt: NOW - 30000,
  isIdle: true,
  agentCompletedAt: NOW - 30000,
  isTerminated: false,
  workspaceUrl: 'https://ws-recoverable.example.test',
  cleanupAt: null,
  agentSessionId: 'agent-session-recoverable',
  agentType: 'openai-codex',
  task: MOCK_TASK,
};

const MOCK_MESSAGES = [
  {
    id: 'msg-user-1',
    sessionId: MOCK_SESSION.id,
    role: 'user',
    content: 'Please continue working on the implementation.',
    toolMetadata: null,
    createdAt: NOW - 90000,
    sequence: 1,
  },
  {
    id: 'msg-assistant-1',
    sessionId: MOCK_SESSION.id,
    role: 'assistant',
    content: 'I hit a provider error before completing the next step.',
    toolMetadata: null,
    createdAt: NOW - 30000,
    sequence: 2,
  },
];

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
    if (path === '/api/workspaces/workspace-recoverable-1') {
      return respond(200, {
        id: 'workspace-recoverable-1',
        projectId: MOCK_PROJECT.id,
        status: 'running',
        url: 'https://ws-recoverable.example.test',
        errorMessage: null,
      });
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';

      if (subPath === '/sessions') {
        return respond(200, { sessions: [MOCK_SESSION], total: 1, hasMore: false });
      }

      if (subPath === `/sessions/${MOCK_SESSION.id}`) {
        return respond(200, { session: MOCK_SESSION, messages: MOCK_MESSAGES, hasMore: false });
      }

      if (subPath.match(/\/sessions\/[^/]+\/messages/)) {
        return respond(200, { messages: MOCK_MESSAGES, hasMore: false });
      }

      if (subPath === '/tasks') return respond(200, { tasks: [MOCK_TASK], total: 1, nextCursor: null });
      if (subPath === `/tasks/${MOCK_TASK.id}`) return respond(200, MOCK_TASK);
      if (subPath === '/agent-profiles') return respond(200, { items: [] });
      if (subPath.match(/\/commands/)) return respond(200, { commands: [] });
      if (subPath === '/activity') return respond(200, { events: [], total: 0 });

      return respond(200, MOCK_PROJECT);
    }

    if (path === '/api/projects') return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });

    return respond(200, {});
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
}

test.describe('Project chat recoverable error banner', () => {
  test('renders recoverable error guidance and keeps the composer enabled', async ({ page }, testInfo) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat/session-recoverable-1');
    await page.waitForTimeout(1200);

    await expect(page.getByText('Agent error:')).toBeVisible();
    await expect(page.getByText('You can send another message to retry')).toBeVisible();

    const composer = page.getByPlaceholder('Send a message to resume the agent...');
    await expect(composer).toBeVisible();
    await expect(composer).toBeEnabled();

    await assertNoHorizontalOverflow(page);
    await screenshot(
      page,
      testInfo.project.name.includes('Desktop')
        ? 'project-chat-recoverable-error-desktop'
        : 'project-chat-recoverable-error-mobile',
    );
  });
});
