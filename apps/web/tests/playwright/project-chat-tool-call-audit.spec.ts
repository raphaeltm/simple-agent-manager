import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

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

const TOOL_CONTENT = [{ type: 'terminal', output: 'SAM_DURABLE_COMMAND_OUTPUT_112\nexit status: 0 ✅' }];
const TOOL_BUTTON_NAME = new RegExp(TOOL_TITLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

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
      contentSize: 128,
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
  const toolContentRequests: string[] = [];

  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: MOCK_SESSION,
    messages: MOCK_MESSAGES,
  });

  // Registered after the shared mocks so it wins precedence for its specific
  // URL (the shared session regex cannot match the deeper tool-content path).
  await page.route(`**/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/messages/*/tool-content`, (route: Route) => {
    toolContentRequests.push(route.request().url());
    return route.fulfill({ status: 200, json: { content: TOOL_CONTENT } });
  });

  return { toolContentRequests };
}

async function assertPersistedToolCallLazyLoads(
  page: Page,
  toolContentRequests: string[],
  screenshotName: string
) {
  // Dismiss the first-run onboarding wizard so its modal overlay doesn't
  // intercept pointer events on the tool-call disclosure button. The wizard
  // auto-opens for users with incomplete setup (no GitHub installation).
  await page.addInitScript(() => {
    localStorage.setItem('sam-onboarding-wizard-dismissed-test-user', 'true');
  });
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

  await expect(page.getByText(TOOL_TITLE)).toBeVisible();
  await expect(page.getByText('execute')).toBeVisible();
  await expect(page.getByText('The focused conversion test passed.')).toBeVisible();
  await expect(page.getByText('128 B')).toBeVisible();

  const toolButton = page.getByRole('button', { name: TOOL_BUTTON_NAME });
  await expect(toolButton).toHaveAttribute('aria-expanded', 'false');
  await toolButton.click();

  await expect(page.getByText(/SAM_DURABLE_COMMAND_OUTPUT_112/)).toBeVisible();
  expect(toolContentRequests).toEqual([
    expect.stringContaining('/messages/msg-tool-done/tool-content'),
  ]);

  await screenshot(page, screenshotName);
  await assertNoOverflow(page);
}

test.describe('Project Chat Persisted Tool Calls — Mobile', () => {
  test('keeps rich tool title after status-only persisted update', async ({ page }) => {
    const { toolContentRequests } = await setupMocks(page);
    await assertPersistedToolCallLazyLoads(page, toolContentRequests, 'project-chat-tool-call-persisted-mobile');
  });
});

test.describe('Project Chat Persisted Tool Calls — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('keeps rich tool title after status-only persisted update', async ({ page }) => {
    const { toolContentRequests } = await setupMocks(page);
    await assertPersistedToolCallLazyLoads(page, toolContentRequests, 'project-chat-tool-call-persisted-desktop');
  });
});
