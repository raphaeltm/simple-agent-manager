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

const MOCK_PROJECT = {
  id: 'proj-test-1',
  name: 'Test Project',
  repository: 'user/test-repo',
  repoProvider: 'github',
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-29T00:00:00Z',
};

function buildSseResponse(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

async function setupMocks(
  page: Page,
  opts: { chatResponse?: 'text' | 'long_text' | 'error' } = {},
) {
  const { chatResponse = 'text' } = opts;

  // Auth mock
  await page.route('**/api/auth/get-session', (route: Route) =>
    route.fulfill({
      status: 200,
      json: { user: { id: 'test-user', name: 'Test User', email: 'test@example.com' } },
    }),
  );

  // Project detail
  await page.route('**/api/projects/proj-test-1', (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, json: MOCK_PROJECT });
    }
    return route.continue();
  });

  // Project sessions, tasks, ideas, knowledge — empty lists
  await page.route('**/api/projects/proj-test-1/sessions*', (route: Route) =>
    route.fulfill({ status: 200, json: { sessions: [] } }),
  );
  await page.route('**/api/projects/proj-test-1/tasks*', (route: Route) =>
    route.fulfill({ status: 200, json: { tasks: [], total: 0 } }),
  );
  await page.route('**/api/projects/proj-test-1/ideas*', (route: Route) =>
    route.fulfill({ status: 200, json: { ideas: [], total: 0 } }),
  );
  await page.route('**/api/projects/proj-test-1/knowledge*', (route: Route) =>
    route.fulfill({ status: 200, json: { entities: [], total: 0 } }),
  );
  await page.route('**/api/projects/proj-test-1/activity*', (route: Route) =>
    route.fulfill({ status: 200, json: { events: [] } }),
  );

  // Agent chat endpoint
  await page.route('**/api/projects/proj-test-1/agent/chat', async (route: Route) => {
    let events: Array<Record<string, unknown>>;
    if (chatResponse === 'text') {
      events = [
        { type: 'conversation_started', conversationId: 'conv-agent-1' },
        { type: 'text_delta', content: 'I can help you with this project. What would you like to work on?' },
        { type: 'done' },
      ];
    } else if (chatResponse === 'long_text') {
      const longContent = 'This is a detailed project analysis covering multiple aspects of the codebase. '.repeat(20);
      events = [
        { type: 'conversation_started', conversationId: 'conv-agent-2' },
        { type: 'text_delta', content: longContent },
        { type: 'done' },
      ];
    } else {
      events = [
        { type: 'conversation_started', conversationId: 'conv-agent-3' },
        { type: 'error', message: 'Agent API error (500). Please try again.' },
        { type: 'done' },
      ];
    }
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: buildSseResponse(events),
    });
  });

  // Agent history
  await page.route('**/api/projects/proj-test-1/agent/history*', (route: Route) =>
    route.fulfill({ status: 200, json: { messages: [] } }),
  );
}

// ---------------------------------------------------------------------------
// Mobile Tests
// ---------------------------------------------------------------------------

test.describe('Project Agent Chat — Mobile', () => {
  test('empty state renders with WebGL canvas and mic button', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/agent');
    await page.waitForTimeout(800);

    // Canvas should exist for WebGL background
    const canvas = page.locator('canvas');
    await expect(canvas).toBeAttached();

    // Mic button should be visible
    const micButton = page.locator('button[aria-label="Start voice input"]');
    await expect(micButton).toBeVisible();

    // Send button should be visible
    const sendButton = page.locator('button[aria-label="Send message"]');
    await expect(sendButton).toBeVisible();

    await screenshot(page, 'project-agent-empty-mobile');
    await assertNoOverflow(page);
  });

  test('input area has textarea, mic, and send buttons without overflow', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/agent');
    await page.waitForTimeout(800);

    // Type in the textarea
    const textarea = page.locator('textarea[aria-label="Message Test Project"]');
    await expect(textarea).toBeVisible();
    await textarea.fill('Hello project agent, can you help me?');

    await screenshot(page, 'project-agent-input-filled-mobile');
    await assertNoOverflow(page);
  });

  test('long text wraps correctly', async ({ page }) => {
    await setupMocks(page, { chatResponse: 'long_text' });
    await page.goto('/projects/proj-test-1/agent');
    await page.waitForTimeout(800);

    const textarea = page.locator('textarea[aria-label="Message Test Project"]');
    await textarea.fill('Give me a detailed analysis');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    await screenshot(page, 'project-agent-long-text-mobile');
    await assertNoOverflow(page);
  });

  test('error state renders correctly', async ({ page }) => {
    await setupMocks(page, { chatResponse: 'error' });
    await page.goto('/projects/proj-test-1/agent');
    await page.waitForTimeout(800);

    const textarea = page.locator('textarea[aria-label="Message Test Project"]');
    await textarea.fill('Break things');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    await screenshot(page, 'project-agent-error-mobile');
    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Desktop Tests
// ---------------------------------------------------------------------------

test.describe('Project Agent Chat — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('empty state with WebGL canvas and controls', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/agent');
    await page.waitForTimeout(800);

    const canvas = page.locator('canvas');
    await expect(canvas).toBeAttached();

    const micButton = page.locator('button[aria-label="Start voice input"]');
    await expect(micButton).toBeVisible();

    await screenshot(page, 'project-agent-empty-desktop');
    await assertNoOverflow(page);
  });

  test('chat with text response', async ({ page }) => {
    await setupMocks(page, { chatResponse: 'text' });
    await page.goto('/projects/proj-test-1/agent');
    await page.waitForTimeout(800);

    const textarea = page.locator('textarea[aria-label="Message Test Project"]');
    await textarea.fill('Hello project agent');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);

    await screenshot(page, 'project-agent-text-response-desktop');
    await assertNoOverflow(page);
  });
});
