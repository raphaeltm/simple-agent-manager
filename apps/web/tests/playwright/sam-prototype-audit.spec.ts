import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// Mock auth so the page can load without redirect
async function setupAuthMock(page: Page) {
  await page.route('**/api/auth/get-session', (route: Route) =>
    route.fulfill({
      status: 200,
      json: { user: { id: 'test-user', name: 'Test User', email: 'test@example.com' } },
    }),
  );
}

// Mock the SAM chat endpoint to return SSE stream
function buildSseResponse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

async function setupSamMocks(
  page: Page,
  opts: {
    chatResponse?: 'text' | 'tool_use' | 'error' | 'long_text' | 'onboarding_cards';
    conversations?: Array<{ id: string; title: string; updated_at: string }>;
  } = {},
) {
  const { chatResponse = 'text', conversations = [] } = opts;

  await setupAuthMock(page);

  // Mock conversations list
  await page.route('**/api/sam/conversations', (route: Route) =>
    route.fulfill({
      status: 200,
      json: { conversations },
    }),
  );

  // Mock chat endpoint
  await page.route('**/api/sam/chat', async (route: Route) => {
    let events: Array<Record<string, unknown>>;

    if (chatResponse === 'text') {
      events = [
        { type: 'conversation_started', conversationId: 'conv-test-1' },
        { type: 'text_delta', content: 'Hello! I\'m SAM, your engineering manager. ' },
        { type: 'text_delta', content: 'I can help you manage projects, check on agents, and coordinate work across your organization.' },
        { type: 'done' },
      ];
    } else if (chatResponse === 'tool_use') {
      events = [
        { type: 'conversation_started', conversationId: 'conv-test-2' },
        { type: 'tool_start', tool: 'list_projects', input: {} },
        { type: 'tool_result', tool: 'list_projects', result: { projects: [{ name: 'SAM', status: 'active' }] } },
        { type: 'text_delta', content: 'You have 1 active project: **SAM**.' },
        { type: 'done' },
      ];
    } else if (chatResponse === 'error') {
      events = [
        { type: 'conversation_started', conversationId: 'conv-test-3' },
        { type: 'error', message: 'Claude API error (500). Please try again.' },
        { type: 'done' },
      ];
    } else if (chatResponse === 'long_text') {
      const longContent = 'Here is a detailed analysis of your project status. '.repeat(20);
      events = [
        { type: 'conversation_started', conversationId: 'conv-test-4' },
        { type: 'text_delta', content: longContent },
        { type: 'done' },
      ];
    } else {
      const longLabel =
        'Connect the repository with a long owner name and an intentionally verbose repository name that should wrap cleanly on narrow screens';
      const cardContent = [
        'Let me check your setup.',
        '',
        '```onboarding-card',
        '{"type":"welcome","title":"Welcome to SAM","message":"I can help you finish setup and then coordinate work across your projects."}',
        '```',
        '',
        '```onboarding-card',
        `{"type":"setup-checklist","steps":[{"key":"cloud_provider","label":"Cloud credentials configured","done":true},{"key":"agent_key","label":"${longLabel}","done":false},{"key":"github_app","label":"GitHub App installed","done":false},{"key":"project","label":"First project created","done":false}]}`,
        '```',
        '',
        '```onboarding-card',
        '{"type":"action","title":"Add an agent key","message":"Add an Anthropic or OpenAI key so SAM can run coding agents for you.","action":"navigate","href":"/settings","buttonLabel":"Open Settings"}',
        '```',
        '',
        '```onboarding-card',
        '{"type":"celebration","title":"Ready for work","message":"Your account is configured and SAM can start coordinating tasks."}',
        '```',
      ].join('\n');
      events = [
        { type: 'conversation_started', conversationId: 'conv-test-5' },
        { type: 'text_delta', content: cardContent },
        { type: 'done' },
      ];
    }

    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: buildSseResponse(events),
    });
  });
}

const chatInput = (page: Page) => page.locator('textarea[placeholder="Ask SAM anything..."]');

async function openSam(page: Page, options?: Parameters<typeof setupSamMocks>[1]) {
  await setupSamMocks(page, options);
  await page.goto('/sam');
  await page.waitForTimeout(500);
}

async function sendChatMessage(page: Page, message: string, viaButton = false) {
  const input = chatInput(page);
  await input.fill(message);

  if (viaButton) {
    const sendButton = page.locator('button').filter({ has: page.locator('svg.lucide-send') });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();
  } else {
    await page.keyboard.press('Enter');
  }

  await page.waitForTimeout(1000);
}

async function captureChatScenario(
  page: Page,
  options: {
    chatResponse: NonNullable<Parameters<typeof setupSamMocks>[1]>['chatResponse'];
    message: string;
    screenshotName: string;
    viaButton?: boolean;
    expectedButton?: string;
  },
) {
  await openSam(page, { chatResponse: options.chatResponse });
  await sendChatMessage(page, options.message, options.viaButton);
  if (options.expectedButton) {
    await expect(page.getByRole('button', { name: options.expectedButton })).toBeVisible();
  }
  await screenshot(page, options.screenshotName);
  await assertNoOverflow(page);
}

async function captureOverview(page: Page, screenshotName: string) {
  await openSam(page);
  await page.getByText('Overview', { exact: true }).click();
  await page.waitForTimeout(500);
  await screenshot(page, screenshotName);
  await assertNoOverflow(page);
}

// ---------------------------------------------------------------------------
// Mobile Tests (default viewport from playwright.config.ts)
// ---------------------------------------------------------------------------

test.describe('SAM Prototype — Mobile', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    void _page;
    test.skip(!testInfo.project.name.includes('iPhone SE'), 'Mobile suite only runs in the mobile project');
  });

  test('empty state renders chat input', async ({ page }) => {
    await openSam(page);

    await expect(chatInput(page)).toBeVisible();

    await screenshot(page, 'sam-empty-state-mobile');
    await assertNoOverflow(page);
  });

  test('chat with text response', async ({ page }) => {
    await captureChatScenario(page, {
      chatResponse: 'text',
      message: 'Hello SAM',
      screenshotName: 'sam-text-response-mobile',
      viaButton: true,
    });
  });

  test('chat with tool use response', async ({ page }) => {
    await captureChatScenario(page, {
      chatResponse: 'tool_use',
      message: 'Show my projects',
      screenshotName: 'sam-tool-use-mobile',
    });
  });

  test('chat with error response', async ({ page }) => {
    await captureChatScenario(page, {
      chatResponse: 'error',
      message: 'Break things',
      screenshotName: 'sam-error-response-mobile',
    });
  });

  test('long text wraps correctly', async ({ page }) => {
    await captureChatScenario(page, {
      chatResponse: 'long_text',
      message: 'Give me a detailed analysis',
      screenshotName: 'sam-long-text-mobile',
    });
  });

  test('onboarding cards render and wrap correctly', async ({ page }) => {
    await captureChatScenario(page, {
      chatResponse: 'onboarding_cards',
      message: 'Help me get started',
      screenshotName: 'sam-onboarding-cards-mobile',
      expectedButton: 'Open Settings',
    });
  });

  test('overview tab shows project cards', async ({ page }) => {
    await captureOverview(page, 'sam-overview-mobile');
  });

  test('project detail drawer', async ({ page }) => {
    await setupSamMocks(page);
    await page.goto('/sam');
    await page.waitForTimeout(500);

    // Switch to Overview
    const overviewTab = page.getByText('Overview', { exact: true });
    await overviewTab.click();
    await page.waitForTimeout(300);

    // Click first project card
    const firstProject = page.locator('button').filter({ hasText: 'SAM' }).first();
    await firstProject.click();
    await page.waitForTimeout(500);

    await screenshot(page, 'sam-project-detail-mobile');
    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Desktop Tests
// ---------------------------------------------------------------------------

test.describe('SAM Prototype — Desktop', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    void _page;
    test.skip(!testInfo.project.name.includes('Desktop'), 'Desktop suite only runs in the desktop project');
  });
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('empty state renders chat input', async ({ page }) => {
    await openSam(page);

    await expect(chatInput(page)).toBeVisible();

    await screenshot(page, 'sam-empty-state-desktop');
    await assertNoOverflow(page);
  });

  test('chat with text response', async ({ page }) => {
    await captureChatScenario(page, {
      chatResponse: 'text',
      message: 'Hello SAM',
      screenshotName: 'sam-text-response-desktop',
    });
  });

  test('chat with tool use response', async ({ page }) => {
    await captureChatScenario(page, {
      chatResponse: 'tool_use',
      message: 'Show my projects',
      screenshotName: 'sam-tool-use-desktop',
    });
  });

  test('long text wraps correctly', async ({ page }) => {
    await captureChatScenario(page, {
      chatResponse: 'long_text',
      message: 'Give me a detailed analysis',
      screenshotName: 'sam-long-text-desktop',
    });
  });

  test('onboarding cards render and wrap correctly', async ({ page }) => {
    await captureChatScenario(page, {
      chatResponse: 'onboarding_cards',
      message: 'Help me get started',
      screenshotName: 'sam-onboarding-cards-desktop',
      expectedButton: 'Open Settings',
    });
  });

  test('overview tab shows project cards', async ({ page }) => {
    await captureOverview(page, 'sam-overview-desktop');
  });
});
