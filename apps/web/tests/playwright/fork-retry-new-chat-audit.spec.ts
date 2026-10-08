import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoClippedOverflow, assertNoOverflow, screenshot } from './audit-helpers';

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

const LONG_TITLE =
  'Investigate why the checkout flow intermittently double-charges customers when the payment provider webhook arrives before the redirect, then fix the race without breaking idempotency keys or the retry queue behaviour';
const LONG_BRANCH = 'sam/investigate-why-the-checkout-flow-intermittently-double-charges-01m4epn5x';
const LONG_DESCRIPTION = `${LONG_TITLE}. Reproduce with https://example.com/very/long/path/that/keeps/going/and/never/breaks/naturally/because-it-is-one-token?with=query&params=everywhere first, then add a regression test that fails before the fix.`;
const LONG_ERROR =
  'Agent crashed unexpectedly after the workspace ran out of memory while installing dependencies for the third time in a row';
const SPECIAL_TITLE = `Fix "quotes" & <script>alert('xss')</script> 🚀 ünïcødé — 日本語`;

type Scenario = { long?: boolean; special?: boolean; failTaskLoad?: boolean };

function makeTask({ long, special }: Scenario) {
  return {
    id: 'task-1',
    projectId: 'proj-test-1',
    title: special ? SPECIAL_TITLE : long ? LONG_TITLE : 'Fix the login bug',
    description: long ? LONG_DESCRIPTION : 'Original task description',
    status: 'failed',
    executionStep: null,
    errorMessage: long ? LONG_ERROR : 'Agent crashed unexpectedly',
    outputBranch: long ? LONG_BRANCH : 'sam/fix-login-bug',
    parentTaskId: null,
    triggeredBy: 'user',
    dispatchDepth: 0,
    startedAt: '2026-01-01T00:05:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:10:00Z',
  };
}

function makeSession(scenario: Scenario) {
  const task = makeTask(scenario);
  return {
    id: 'session-1',
    workspaceId: 'ws-1',
    taskId: 'task-1',
    topic: task.title,
    status: 'stopped',
    messageCount: 2,
    startedAt: Date.now() - 120000,
    endedAt: Date.now() - 60000,
    createdAt: Date.now() - 120000,
    task: {
      id: 'task-1',
      status: 'failed',
      errorMessage: task.errorMessage,
      outputBranch: task.outputBranch,
    },
  };
}

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

interface Recorded {
  /** Paths of any request to the removed summarization endpoints. */
  summaryRequests: string[];
  submitBodies: Record<string, unknown>[];
}

async function setupApiMocks(page: Page, scenario: Scenario): Promise<Recorded> {
  const recorded: Recorded = { summaryRequests: [], submitBodies: [] };
  const task = makeTask(scenario);
  const session = makeSession(scenario);

  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.endsWith('/fork-prepare') || path.endsWith('/summarize')) {
      recorded.summaryRequests.push(path);
      return respond(404, { error: 'NOT_FOUND', message: 'Route removed' });
    }
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
            id: 'profile-claude',
            projectId: 'proj-test-1',
            userId: 'user-test-1',
            name: 'Claude',
            description: 'Focused implementation profile',
            agentType: 'claude-code',
            runtime: 'vm',
            taskMode: 'task',
            isBuiltin: false,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });
    if (subPath === '/sessions') return respond(200, { sessions: [session], total: 1 });
    if (subPath === '/tasks') return respond(200, { tasks: [task], nextCursor: null });
    if (subPath === '/tasks/submit' && route.request().method() === 'POST') {
      recorded.submitBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      return respond(202, {
        taskId: 'task-2',
        sessionId: 'session-2',
        branchName: 'sam/fork',
        status: 'queued',
      });
    }
    if (subPath === '/tasks/task-1') {
      if (scenario.failTaskLoad) {
        return respond(500, { error: 'INTERNAL_ERROR', message: 'Task lookup failed' });
      }
      return respond(200, task);
    }
    if (subPath === '/sessions/session-1') {
      return respond(200, { session, messages: MOCK_MESSAGES, hasMore: false });
    }
    if (subPath === '/sessions/session-1/messages') return respond(200, MOCK_MESSAGES);

    return respond(200, {});
  });

  return recorded;
}

const COMPOSER_PLACEHOLDER = 'Describe what you want the agent to do...';

async function expectLaidOutCleanly(page: Page) {
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
}

test.describe('Fork/retry new chat screen audit', () => {
  test('fork fills the composer with the IDs at once and submits lineage without a summary', async ({
    page,
  }) => {
    const recorded = await setupApiMocks(page, {});
    await page.goto('/projects/proj-test-1/chat/session-1');

    await page.getByTestId('session-tool-fork').first().click();

    await expect(page.getByText('What do you want to build?')).toBeVisible();
    await expect(page.getByText('Forking from: Fix the login bug')).toBeVisible();
    await expect(page.getByText('Branch: sam/fix-login-bug')).toBeVisible();
    const textarea = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await expect(textarea).toHaveValue(/Parent task ID: task-1/);
    const prompt = await textarea.inputValue();
    expect(prompt).toContain('SAM MCP tools');
    expect(prompt).toContain('Previous session: "Fix the login bug"');
    expect(prompt).toContain('Parent project ID: proj-test-1');
    expect(prompt).toContain('Parent session ID: session-1');
    await expect(page.getByText('Loading original prompt...')).toHaveCount(0);
    await expectLaidOutCleanly(page);
    await screenshot(page, 'fork-new-chat');

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => recorded.submitBodies.length).toBe(1);
    expect(recorded.submitBodies[0]).toMatchObject({
      parentTaskId: 'task-1',
      message: expect.stringContaining('Parent session ID: session-1'),
    });
    expect(recorded.submitBodies[0]).not.toHaveProperty('contextSummary');
    expect(recorded.summaryRequests).toEqual([]);
  });

  test('fork with a very long title and branch stays inside the viewport', async ({ page }) => {
    const recorded = await setupApiMocks(page, { long: true });
    await page.goto('/projects/proj-test-1/chat/session-1');

    await page.getByTestId('session-tool-fork').first().click();

    await expect(page.getByText(`Forking from: ${LONG_TITLE}`)).toBeVisible();
    await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toHaveValue(
      /Parent session ID: session-1/
    );
    await expectLaidOutCleanly(page);
    await screenshot(page, 'fork-new-chat-long-title');
    expect(recorded.summaryRequests).toEqual([]);
  });

  test('fork renders special characters in the title as plain text', async ({ page }) => {
    const recorded = await setupApiMocks(page, { special: true });
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await page.goto('/projects/proj-test-1/chat/session-1');

    await page.getByTestId('session-tool-fork').first().click();

    await expect(page.getByText(`Forking from: ${SPECIAL_TITLE}`)).toBeVisible();
    const textarea = page.getByPlaceholder(COMPOSER_PLACEHOLDER);
    await expect(textarea).toHaveValue(/Parent session ID: session-1/);
    expect(await textarea.inputValue()).toContain(`Previous session: "${SPECIAL_TITLE}"`);
    expect(dialogs).toEqual([]);
    expect(
      await page.evaluate(() =>
        Array.from(document.querySelectorAll('script')).some((script) =>
          script.textContent?.includes("alert('xss')")
        )
      )
    ).toBe(false);
    await expectLaidOutCleanly(page);
    await screenshot(page, 'fork-new-chat-special-chars');
    expect(recorded.summaryRequests).toEqual([]);
  });

  test('retry re-adds the original prompt with the previous error', async ({ page }) => {
    const recorded = await setupApiMocks(page, {});
    await page.goto('/projects/proj-test-1/chat/session-1');

    await page.getByTestId('session-tool-retry').first().click();

    await expect(page.getByText('What do you want to build?')).toBeVisible();
    await expect(page.getByText('Retrying: Fix the login bug')).toBeVisible();
    await expect(page.getByText('Error: Agent crashed unexpectedly')).toBeVisible();
    await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toHaveValue(
      'Original task description'
    );
    await expect(page.getByText('Loading original prompt...')).toHaveCount(0);
    await expectLaidOutCleanly(page);
    await screenshot(page, 'retry-new-chat');

    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => recorded.submitBodies.length).toBe(1);
    expect(recorded.submitBodies[0]).toMatchObject({
      message: 'Original task description',
      parentTaskId: 'task-1',
    });
    expect(recorded.submitBodies[0]).not.toHaveProperty('contextSummary');
    expect(recorded.summaryRequests).toEqual([]);
  });

  test('retry with a long prompt and error wraps inside the viewport', async ({ page }) => {
    await setupApiMocks(page, { long: true });
    await page.goto('/projects/proj-test-1/chat/session-1');

    await page.getByTestId('session-tool-retry').first().click();

    await expect(page.getByText(`Error: ${LONG_ERROR}`)).toBeVisible();
    await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toHaveValue(LONG_DESCRIPTION);
    await expectLaidOutCleanly(page);
    await screenshot(page, 'retry-new-chat-long-text');
  });

  test('retry explains a failed prompt load and leaves Send usable', async ({ page }) => {
    await setupApiMocks(page, { failTaskLoad: true });
    await page.goto('/projects/proj-test-1/chat/session-1');

    await page.getByTestId('session-tool-retry').first().click();

    await expect(page.getByText(/Could not load the original prompt/)).toBeVisible();
    await expect(page.getByText('Retrying: Fix the login bug')).toBeVisible();
    await expect(page.getByText('Loading original prompt...')).toHaveCount(0);
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).fill('Try the smaller fix first');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await expectLaidOutCleanly(page);
    await screenshot(page, 'retry-new-chat-load-error');
  });
});
