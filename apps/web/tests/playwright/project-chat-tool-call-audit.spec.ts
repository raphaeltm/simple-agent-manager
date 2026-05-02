import { expect, type Page, type Route, test } from '@playwright/test';

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
}

const PROJECT_ID = 'proj-test-1';
const SESSION_ID = 'sess-tool-details';
const TOOL_TITLE = 'Bash: pnpm --filter @simple-agent-manager/web test -- chatMessagesToConversationItems.test.ts';

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Tool Call Audit',
  repository: 'user/tool-call-audit',
  repoProvider: 'github',
  createdAt: '2026-05-02T00:00:00Z',
  updatedAt: '2026-05-02T00:00:00Z',
};

const MOCK_SESSION = {
  id: SESSION_ID,
  workspaceId: null,
  taskId: null,
  topic: 'Persisted tool call display parity',
  status: 'stopped',
  messageCount: 4,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 5_000,
  endedAt: Date.now() - 5_000,
  cleanupAt: null,
  isIdle: false,
  agentCompletedAt: null,
  agentSessionId: null,
  agentType: 'claude-code',
};

const MOCK_MESSAGES = [
  {
    id: 'msg-user-1',
    sessionId: SESSION_ID,
    role: 'user',
    content: 'Run the focused conversion test and tell me what happens.',
    toolMetadata: null,
    createdAt: Date.now() - 50_000,
    sequence: 1,
  },
  {
    id: 'msg-tool-start',
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: 'tc-focused-test',
      title: TOOL_TITLE,
      kind: 'execute',
      status: 'in_progress',
      content: [{ type: 'terminal', terminalId: 'term-focused-test' }],
    },
    createdAt: Date.now() - 40_000,
    sequence: 2,
  },
  {
    id: 'msg-tool-done',
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool update)',
    toolMetadata: {
      toolCallId: 'tc-focused-test',
      status: 'completed',
    },
    createdAt: Date.now() - 30_000,
    sequence: 3,
  },
  {
    id: 'msg-assistant-1',
    sessionId: SESSION_ID,
    role: 'assistant',
    content: 'The focused conversion test passed.',
    toolMetadata: null,
    createdAt: Date.now() - 20_000,
    sequence: 4,
  },
];

async function setupMocks(page: Page) {
  await page.route('**/api/auth/get-session', (route: Route) =>
    route.fulfill({
      status: 200,
      json: { user: { id: 'test-user', name: 'Test User', email: 'test@example.com' } },
    }),
  );

  await page.route('**/api/github/installations', (route: Route) =>
    route.fulfill({ status: 200, json: [] }),
  );

  await page.route(`**/api/projects/${PROJECT_ID}`, (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, json: MOCK_PROJECT });
    }
    return route.continue();
  });

  await page.route(`**/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}*`, (route: Route) =>
    route.fulfill({
      status: 200,
      json: {
        session: MOCK_SESSION,
        messages: MOCK_MESSAGES,
        hasMore: false,
      },
    }),
  );

  await page.route(`**/api/projects/${PROJECT_ID}/sessions*`, (route: Route) =>
    route.fulfill({
      status: 200,
      json: { sessions: [MOCK_SESSION], total: 1 },
    }),
  );

  await page.route(`**/api/projects/${PROJECT_ID}/tasks*`, (route: Route) =>
    route.fulfill({ status: 200, json: { tasks: [], total: 0 } }),
  );

  await page.route(`**/api/projects/${PROJECT_ID}/agent-profiles`, (route: Route) =>
    route.fulfill({ status: 200, json: { items: [] } }),
  );

  await page.route('**/api/credentials', (route: Route) =>
    route.fulfill({ status: 200, json: [{ provider: 'hetzner', status: 'valid' }] }),
  );

  await page.route('**/api/trial/status', (route: Route) =>
    route.fulfill({ status: 200, json: { available: false } }),
  );

  await page.route('**/api/agents', (route: Route) =>
    route.fulfill({ status: 200, json: { agents: [] } }),
  );

  await page.route(`**/api/projects/${PROJECT_ID}/commands*`, (route: Route) =>
    route.fulfill({ status: 200, json: { commands: [] } }),
  );
}

test.describe('Project Chat Persisted Tool Calls — Mobile', () => {
  test('keeps rich tool title after status-only persisted update', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

    await expect(page.getByText(TOOL_TITLE)).toBeVisible();
    await expect(page.getByText('execute')).toBeVisible();
    await expect(page.getByText('The focused conversion test passed.')).toBeVisible();

    await screenshot(page, 'project-chat-tool-call-persisted-mobile');
    await assertNoOverflow(page);
  });
});

test.describe('Project Chat Persisted Tool Calls — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('keeps rich tool title after status-only persisted update', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

    await expect(page.getByText(TOOL_TITLE)).toBeVisible();
    await expect(page.getByText('execute')).toBeVisible();
    await expect(page.getByText('The focused conversion test passed.')).toBeVisible();

    await screenshot(page, 'project-chat-tool-call-persisted-desktop');
    await assertNoOverflow(page);
  });
});
