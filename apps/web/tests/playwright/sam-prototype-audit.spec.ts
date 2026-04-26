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
    chatResponse?: 'text' | 'tool_use' | 'error' | 'long_text';
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
    } else {
      // long_text
      const longContent = 'Here is a detailed analysis of your project status. '.repeat(20);
      events = [
        { type: 'conversation_started', conversationId: 'conv-test-4' },
        { type: 'text_delta', content: longContent },
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

// ---------------------------------------------------------------------------
// Mobile Tests (default viewport from playwright.config.ts)
// ---------------------------------------------------------------------------

test.describe('SAM Prototype — Mobile', () => {
  test('empty state renders chat input', async ({ page }) => {
    await setupSamMocks(page);
    await page.goto('/sam');
    await page.waitForTimeout(500);

    // Chat input should be visible
    const input = page.locator('input[placeholder="Ask SAM anything..."]');
    await expect(input).toBeVisible();

    await screenshot(page, 'sam-empty-state-mobile');
    await assertNoOverflow(page);
  });

  test('chat with text response', async ({ page }) => {
    await setupSamMocks(page, { chatResponse: 'text' });
    await page.goto('/sam');
    await page.waitForTimeout(500);

    // Type a message
    const input = page.locator('input[placeholder="Ask SAM anything..."]');
    await input.fill('Hello SAM');

    // Send button should be enabled
    const sendButton = page.locator('button').filter({ has: page.locator('svg.lucide-send') });
    await expect(sendButton).toBeEnabled();

    // Click send
    await sendButton.click();
    await page.waitForTimeout(1000);

    await screenshot(page, 'sam-text-response-mobile');
    await assertNoOverflow(page);
  });

  test('chat with tool use response', async ({ page }) => {
    await setupSamMocks(page, { chatResponse: 'tool_use' });
    await page.goto('/sam');
    await page.waitForTimeout(500);

    const input = page.locator('input[placeholder="Ask SAM anything..."]');
    await input.fill('Show my projects');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    await screenshot(page, 'sam-tool-use-mobile');
    await assertNoOverflow(page);
  });

  test('chat with error response', async ({ page }) => {
    await setupSamMocks(page, { chatResponse: 'error' });
    await page.goto('/sam');
    await page.waitForTimeout(500);

    const input = page.locator('input[placeholder="Ask SAM anything..."]');
    await input.fill('Break things');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    await screenshot(page, 'sam-error-response-mobile');
    await assertNoOverflow(page);
  });

  test('long text wraps correctly', async ({ page }) => {
    await setupSamMocks(page, { chatResponse: 'long_text' });
    await page.goto('/sam');
    await page.waitForTimeout(500);

    const input = page.locator('input[placeholder="Ask SAM anything..."]');
    await input.fill('Give me a detailed analysis');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    await screenshot(page, 'sam-long-text-mobile');
    await assertNoOverflow(page);
  });

  test('overview tab shows project cards', async ({ page }) => {
    await setupSamMocks(page);
    await page.goto('/sam');
    await page.waitForTimeout(500);

    // Click Overview tab
    const overviewTab = page.getByText('Overview', { exact: true });
    await overviewTab.click();
    await page.waitForTimeout(500);

    await screenshot(page, 'sam-overview-mobile');
    await assertNoOverflow(page);
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
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('empty state renders chat input', async ({ page }) => {
    await setupSamMocks(page);
    await page.goto('/sam');
    await page.waitForTimeout(500);

    const input = page.locator('input[placeholder="Ask SAM anything..."]');
    await expect(input).toBeVisible();

    await screenshot(page, 'sam-empty-state-desktop');
    await assertNoOverflow(page);
  });

  test('chat with text response', async ({ page }) => {
    await setupSamMocks(page, { chatResponse: 'text' });
    await page.goto('/sam');
    await page.waitForTimeout(500);

    const input = page.locator('input[placeholder="Ask SAM anything..."]');
    await input.fill('Hello SAM');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    await screenshot(page, 'sam-text-response-desktop');
    await assertNoOverflow(page);
  });

  test('chat with tool use response', async ({ page }) => {
    await setupSamMocks(page, { chatResponse: 'tool_use' });
    await page.goto('/sam');
    await page.waitForTimeout(500);

    const input = page.locator('input[placeholder="Ask SAM anything..."]');
    await input.fill('Show my projects');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    await screenshot(page, 'sam-tool-use-desktop');
    await assertNoOverflow(page);
  });

  test('long text wraps correctly', async ({ page }) => {
    await setupSamMocks(page, { chatResponse: 'long_text' });
    await page.goto('/sam');
    await page.waitForTimeout(500);

    const input = page.locator('input[placeholder="Ask SAM anything..."]');
    await input.fill('Give me a detailed analysis');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    await screenshot(page, 'sam-long-text-desktop');
    await assertNoOverflow(page);
  });

  test('overview tab shows project cards', async ({ page }) => {
    await setupSamMocks(page);
    await page.goto('/sam');
    await page.waitForTimeout(500);

    const overviewTab = page.getByText('Overview', { exact: true });
    await overviewTab.click();
    await page.waitForTimeout(500);

    await screenshot(page, 'sam-overview-desktop');
    await assertNoOverflow(page);
  });
});
