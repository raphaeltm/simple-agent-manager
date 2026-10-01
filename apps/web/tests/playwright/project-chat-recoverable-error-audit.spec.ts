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

async function setupApiMocks(page: Page, task = MOCK_TASK, isMine = true, messages = MOCK_MESSAGES) {
  await page.addInitScript(() => {
    localStorage.setItem('sam-onboarding-wizard-dismissed-user-test-1', 'true');
  });
  const isTerminalLifecycle =
    task.status === 'failed' && task.executionStep === 'awaiting_human_input';
  const session = {
    ...MOCK_SESSION,
    ...(isTerminalLifecycle
      ? {
          status: 'stopped',
          endedAt: NOW - 20_000,
          isIdle: false,
          isTerminated: true,
        }
      : {}),
    taskId: task.id,
    task,
    isMine,
    messageCount: messages.length,
  };
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
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
        status: isTerminalLifecycle ? 'stopped' : 'running',
        url: 'https://ws-recoverable.example.test',
        errorMessage: null,
      });
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';

      if (subPath === '/sessions') {
        return respond(200, { sessions: [session], total: 1, hasMore: false });
      }

      if (subPath === `/sessions/${MOCK_SESSION.id}`) {
        return respond(200, { session, messages, hasMore: false });
      }

      if (subPath.match(/\/sessions\/[^/]+\/messages/)) {
        return respond(200, { messages, hasMore: false });
      }

      if (subPath === '/tasks') return respond(200, { tasks: [task], total: 1, nextCursor: null });
      if (subPath === `/tasks/${task.id}/events`) return respond(200, { events: [] });
      if (subPath === `/tasks/${task.id}`) return respond(200, task);
      if (subPath === '/agent-profiles') return respond(200, { items: [] });
      if (subPath.match(/\/commands/)) return respond(200, { commands: [] });
      if (subPath === '/activity') return respond(200, { events: [], total: 0 });

      return respond(200, MOCK_PROJECT);
    }

    if (path === '/api/projects')
      return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });

    return respond(200, {});
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  const viewport = page.viewportSize();
  const suffix = viewport ? `${viewport.width}x${viewport.height}` : 'unknown';
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}-${suffix}.png`,
    fullPage: true,
  });
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflow).toBe(false);
}

test.describe('Project chat recoverable error banner', () => {
  test('startup missing credential reaches existing agent connections', async ({ page }, testInfo) => {
    const systemMessage = {
      ...MOCK_MESSAGES[0],
      id: 'msg-system-auth',
      role: 'system',
      content: 'Agent startup failed because its provider connection is missing.',
    };
    await setupApiMocks(page, { ...MOCK_TASK, errorMessage: 'model_provider_credential_missing' }, true, [
      systemMessage,
      { ...systemMessage, id: 'msg-system-later', content: 'Workspace is preparing.' },
    ]);
    await page.goto('/projects/proj-test-1/chat/session-recoverable-1');
    const banner = page.getByTestId('agent-connection-guidance');
    await expect(banner).toBeVisible();
    const link = banner.getByRole('link', { name: 'Open agent connections' });
    await expect(link).toHaveAttribute('href', '/settings/connections');
    await assertNoHorizontalOverflow(page);
    await screenshot(page, `acp-agent-auth-${testInfo.project.name.includes('Desktop') ? 'desktop' : 'mobile'}`);
    await link.click();
    await expect(page).toHaveURL(/\/settings\/connections$/);
  });

  test('startup auth banner offers no personal settings action to another member', async ({ page }) => {
    const systemMessage = {
      ...MOCK_MESSAGES[0],
      id: 'msg-system-auth',
      role: 'system',
      content: 'Agent startup failed because its provider connection is missing.',
    };
    await setupApiMocks(page, { ...MOCK_TASK, errorMessage: null }, false, [systemMessage]);
    await page.goto('/projects/proj-test-1/chat/session-recoverable-1');
    const banner = page.getByTestId('agent-connection-guidance');
    await expect(banner).toBeVisible();
    await expect(banner.getByRole('link', { name: 'Open agent connections' })).toHaveCount(0);
  });

  test('assistant or tool text cannot impersonate the startup system diagnosis', async ({ page }) => {
    const content = 'Agent startup failed because its provider connection is missing.';
    await setupApiMocks(page, { ...MOCK_TASK, errorMessage: null }, true, [
      { ...MOCK_MESSAGES[0], id: 'msg-assistant-spoof', role: 'assistant', content },
      { ...MOCK_MESSAGES[0], id: 'msg-tool-spoof', role: 'tool', content },
    ]);
    await page.goto('/projects/proj-test-1/chat/session-recoverable-1');
    await expect(page.getByTestId('agent-connection-guidance')).toHaveCount(0);
  });

  test('successful retry turn clears stale startup guidance even after a later system row', async ({ page }) => {
    const systemMessage = {
      ...MOCK_MESSAGES[0],
      id: 'msg-system-auth',
      role: 'system',
      content: 'Agent startup failed because its provider connection is missing.',
    };
    await setupApiMocks(page, { ...MOCK_TASK, errorMessage: null }, true, [
      systemMessage,
      { ...systemMessage, id: 'msg-user-later', role: 'user', content: 'I connected the agent.' },
      { ...systemMessage, id: 'msg-assistant-later', role: 'assistant', content: 'Connection restored.' },
      { ...systemMessage, id: 'msg-system-later', content: 'Workspace is preparing.' },
    ]);
    await page.goto('/projects/proj-test-1/chat/session-recoverable-1');
    await expect(page.getByTestId('agent-connection-guidance')).toHaveCount(0);
  });

  test('creator can open existing auth settings from a classified chat failure', async ({ page }, testInfo) => {
    await setupApiMocks(page, {
      ...MOCK_TASK,
      errorMessage: 'mcp_endpoint_needs_auth',
    }, true);
    await page.goto('/projects/proj-test-1/chat/session-recoverable-1');
    const card = page.locator('[data-failure-kind="diagnosable"]');
    await expect(card.getByText('Tool connection needs sign-in')).toBeVisible();
    await card.getByRole('button', { name: /Tool connection needs sign-in/ }).click();
    const link = card.getByRole('link', { name: 'Review personal MCP settings' });
    await expect(link).toHaveAttribute('href', '/settings/mcp-servers');
    await expect(card.getByRole('link', { name: 'View project MCP settings' })).toHaveAttribute('href', '/projects/proj-test-1/settings/runtime');
    await assertNoHorizontalOverflow(page);
    await screenshot(page, `acp-auth-chat-${testInfo.project.name.includes('Desktop') ? 'desktop' : 'mobile'}`);
    await link.click();
    await expect(page).toHaveURL(/\/settings\/mcp-servers$/);
  });

  test('another project member sees the diagnosis without a credential action', async ({ page }) => {
    await setupApiMocks(page, {
      ...MOCK_TASK,
      errorMessage: 'model_provider_credential_missing',
    }, false);
    await page.goto('/projects/proj-test-1/chat/session-recoverable-1');
    const card = page.locator('[data-failure-kind="diagnosable"]');
    await expect(card.getByText('Agent connection missing')).toBeVisible();
    await card.getByRole('button', { name: /Agent connection missing/ }).click();
    await expect(card.getByRole('link', { name: 'Open agent connections' })).toHaveCount(0);
  });

  test('generic prompt failure does not prescribe credential changes', async ({ page }) => {
    await setupApiMocks(page, { ...MOCK_TASK, errorMessage: 'agent_prompt_failed' }, true);
    await page.goto('/projects/proj-test-1/chat/session-recoverable-1');
    const card = page.locator('[data-failure-kind="diagnosable"]');
    await expect(card.getByText('Agent request failed')).toBeVisible();
    await card.getByRole('button', { name: /Agent request failed/ }).click();
    await expect(card.getByRole('link', { name: /connections|MCP settings/i })).toHaveCount(0);
  });

  test('renders recoverable error guidance and keeps the composer enabled', async ({
    page,
  }, testInfo) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-test-1/chat/session-recoverable-1');
    await page.waitForTimeout(1200);

    const recoverableCard = page.locator('[data-failure-kind="diagnosable"]');
    await expect(recoverableCard.getByText('Cloud capacity')).toBeVisible();
    await expect(recoverableCard.getByText('Recoverable')).toBeVisible();

    const composer = page.getByRole('combobox');
    await expect(composer).toBeVisible();
    await expect(composer).toBeEnabled();

    await assertNoHorizontalOverflow(page);
    await screenshot(
      page,
      testInfo.project.name.includes('Desktop')
        ? 'project-chat-recoverable-error-desktop'
        : 'project-chat-recoverable-error-mobile'
    );
  });

  test('renders input expiry as a neutral lifecycle outcome in the real chat shell', async ({
    page,
  }, testInfo) => {
    await setupApiMocks(page, {
      ...MOCK_TASK,
      status: 'failed',
      executionStep: 'awaiting_human_input',
      errorMessage: 'Human input request expired after timeout',
      taskMode: 'task',
    });
    await page.goto('/projects/proj-test-1/chat/session-recoverable-1');

    const lifecycleCard = page.locator('[data-failure-kind="lifecycle"]');
    await expect(lifecycleCard).toBeVisible();
    await expect(lifecycleCard.getByText('Input request expired')).toBeVisible();
    await expect(lifecycleCard.getByText('Retryable')).toHaveCount(0);
    await expect(lifecycleCard.getByText('Recoverable')).toHaveCount(0);
    await expect(
      page.getByLabel('Conversation').getByText('Stopped', { exact: true })
    ).toBeVisible();
    if ((page.viewportSize()?.width ?? 0) >= 768) {
      await expect(page.getByTitle('Stopped')).toBeVisible();
      await expect(page.getByTitle('Failed')).toHaveCount(0);
    }
    await expect(page.getByTestId('failure-card-shell')).not.toHaveClass(/after:bg/);
    await expect(page.getByTestId('failure-card-shell')).toHaveCSS(
      'box-shadow',
      'rgba(0, 0, 0, 0.4) 0px 4px 24px 0px'
    );

    await lifecycleCard.getByRole('button').click();
    await expect(page.getByText(/No debugging is needed/i)).toBeVisible();
    await expect(lifecycleCard.getByText('Reason')).toBeVisible();
    await expect(lifecycleCard.getByText('Error', { exact: true })).toHaveCount(0);
    await expect(lifecycleCard.getByText('Copy debug report')).toHaveCount(0);
    await expect(lifecycleCard.getByText('View in admin errors')).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
    await screenshot(
      page,
      testInfo.project.name.includes('Desktop')
        ? 'project-chat-input-expired-desktop'
        : 'project-chat-input-expired-mobile'
    );
  });
});
