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
  userId: 'user-test-1',
  name: 'Fork Retry Audit',
  description: null,
  repository: 'testuser/test-repo',
  installationId: 'inst-1',
  defaultBranch: 'main',
  defaultWorkspaceProfile: 'full',
  defaultDevcontainerConfigName: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const MOCK_TASK = {
  id: 'task-1',
  projectId: 'proj-test-1',
  title: 'Fix the login bug',
  description: 'Original task description',
  status: 'failed',
  executionStep: null,
  errorMessage: 'Agent crashed unexpectedly',
  outputBranch: 'sam/fix-login-bug',
  parentTaskId: null,
  triggeredBy: 'user',
  dispatchDepth: 0,
  startedAt: '2026-01-01T00:05:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:10:00Z',
};

const MOCK_SESSION = {
  id: 'session-1',
  workspaceId: 'ws-1',
  taskId: 'task-1',
  topic: 'Fix the login bug',
  status: 'stopped',
  messageCount: 2,
  startedAt: Date.now() - 120000,
  endedAt: Date.now() - 60000,
  createdAt: Date.now() - 120000,
  task: {
    id: 'task-1',
    status: 'failed',
    errorMessage: 'Agent crashed unexpectedly',
    outputBranch: 'sam/fix-login-bug',
  },
};

const MOCK_MESSAGES = [
  {
    id: 'message-1',
    sessionId: 'session-1',
    role: 'user',
    content: 'Fix the login bug',
    toolMetadata: null,
    createdAt: Date.now() - 110000,
  },
  {
    id: 'message-2',
    sessionId: 'session-1',
    role: 'assistant',
    content: 'I found a problem but crashed before finishing.',
    toolMetadata: null,
    createdAt: Date.now() - 90000,
  },
];

async function setupApiMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/credentials')
      return respond(200, [{ id: 'cred-1', provider: 'hetzner', name: 'Hetzner' }]);
    if (path === '/api/trial-status') return respond(200, { available: false });
    if (path === '/api/agents') {
      return respond(200, {
        agents: [{ id: 'claude-code', name: 'Claude Code', configured: true, supportsAcp: true }],
      });
    }
    if (path === '/api/projects')
      return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (!projectMatch) return respond(200, {});

    const subPath = projectMatch[2] || '';
    if (subPath === '') return respond(200, MOCK_PROJECT);
    if (subPath === '/agent-profiles')
      return respond(200, {
        items: [
          {
            id: 'profile-codex',
            projectId: 'proj-test-1',
            userId: 'user-test-1',
            name: 'Codex',
            description: 'Focused implementation profile',
            agentType: 'openai-codex',
            runtime: 'cf-container',
            taskMode: 'task',
            isBuiltin: false,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });
    if (subPath === '/sessions') return respond(200, { sessions: [MOCK_SESSION], total: 1 });
    if (subPath === '/tasks') return respond(200, { tasks: [MOCK_TASK], nextCursor: null });
    if (subPath === '/tasks/task-1') return respond(200, MOCK_TASK);
    if (subPath === '/sessions/session-1/fork-prepare') {
      return respond(200, {
        parentTaskId: 'task-1',
        parentSessionId: 'session-1',
        parentBranch: 'sam/fix-login-bug',
        sessionLabel: 'Fix the login bug',
        summary: 'Summary of previous session',
        messageCount: 2,
        repaired: false,
      });
    }
    if (subPath === '/sessions/session-1/summarize') {
      return respond(200, {
        summary: 'Summary of previous session',
        messageCount: 2,
        filteredCount: 2,
        method: 'heuristic',
      });
    }
    if (subPath === '/sessions/session-1') {
      return respond(200, { session: MOCK_SESSION, messages: MOCK_MESSAGES, hasMore: false });
    }
    if (subPath === '/sessions/session-1/messages') return respond(200, MOCK_MESSAGES);

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

test.describe('Fork/retry new chat screen audit', () => {
  test('fork returns to the new chat screen with lineage banner and settings controls', async ({
    page,
  }, testInfo) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat/session-1');

    await expect(page.getByLabel('Fork session')).toBeVisible();
    await page.getByLabel('Fork session').click();

    await expect(page.getByText('What do you want to build?')).toBeVisible();
    await expect(page.getByText('Forking from: Fix the login bug')).toBeVisible();
    await expect(page.getByText('Branch: sam/fix-login-bug')).toBeVisible();

    const textareaValue = await page
      .getByPlaceholder('Describe what you want the agent to do...')
      .inputValue();
    expect(textareaValue).toContain('SAM MCP tools');
    expect(textareaValue).toContain('Previous session: "Fix the login bug"');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(overflow).toBe(false);

    await screenshot(
      page,
      `fork-new-chat-${testInfo.project.name.replaceAll(/\W+/g, '-').toLowerCase()}`
    );
  });

  test('retry returns to the new chat screen with original task text and error context', async ({
    page,
  }, testInfo) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat/session-1');

    await expect(page.getByLabel('Retry task')).toBeVisible();
    await page.getByLabel('Retry task').click();

    await expect(page.getByText('What do you want to build?')).toBeVisible();
    await expect(page.getByText('Retrying: Fix the login bug')).toBeVisible();
    await expect(page.getByText('Error: Agent crashed unexpectedly')).toBeVisible();
    await expect(page.getByPlaceholder('Describe what you want the agent to do...')).toHaveValue(
      'Original task description'
    );

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(overflow).toBe(false);

    await screenshot(
      page,
      `retry-new-chat-${testInfo.project.name.replaceAll(/\W+/g, '-').toLowerCase()}`
    );
  });
});
