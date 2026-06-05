import { expect, type Page, type Route, test } from '@playwright/test';

// Visual audit for the graduated markdown rendering fixes in project chat:
//   1. List markers (ol=decimal, ul=disc, nested circle/square, task lists none)
//   2. Green-glow agent bubble treatment
//   3. Readable tables (grid lines, header tint, zebra, min-width, horizontal scroll)
//   4. Language-less fenced code blocks render as <pre> (line breaks preserved)
// Rendered through the real project chat chain (ProjectMessageView ->
// AcpConversationItemView -> acp-client MessageBubble) so acp-chat.css and
// index.css apply exactly as in production.

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
const SESSION_ID = 'sess-markdown-render';

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Markdown Render Audit',
  repository: 'user/markdown-render-audit',
  repoProvider: 'github',
  createdAt: '2026-06-05T00:00:00Z',
  updatedAt: '2026-06-05T00:00:00Z',
};

const MOCK_SESSION = {
  id: SESSION_ID,
  workspaceId: null,
  taskId: null,
  topic: 'Markdown rendering',
  status: 'stopped',
  messageCount: 2,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 5_000,
  endedAt: Date.now() - 5_000,
  cleanupAt: null,
  isIdle: false,
  agentCompletedAt: null,
  agentSessionId: null,
  agentType: 'claude-code',
};

const USER_MARKDOWN = [
  'Please render this:',
  '',
  '1. ordered one',
  '2. ordered two',
  '',
  '- bullet a',
  '- bullet b',
].join('\n');

const AGENT_MARKDOWN = [
  'Here is the breakdown:',
  '',
  '1. First step in the plan',
  '2. Second step in the plan',
  '   - nested bullet item',
  '   - another nested bullet',
  '     - deeper nested item',
  '3. Third step in the plan',
  '',
  'Checklist:',
  '',
  '- [ ] unchecked task item',
  '- [x] completed task item',
  '',
  '| Column A | Column B with longer header text | Status |',
  '|----------|----------------------------------|--------|',
  '| Row one  | some descriptive cell content    | Yes    |',
  '| Row two  | x                                | No     |',
  '| Row three with a fairly long label | another value | Maybe |',
  '',
  'Typed code block:',
  '',
  '```ts',
  'const greeting = "hello";',
  'console.log(greeting);',
  '```',
  '',
  'Command output (no language):',
  '',
  '```',
  'On branch main',
  'Your branch is up to date with origin/main.',
  'nothing to commit, working tree clean',
  '```',
].join('\n');

const MOCK_MESSAGES = [
  {
    id: 'msg-user-1',
    sessionId: SESSION_ID,
    role: 'user',
    content: USER_MARKDOWN,
    toolMetadata: null,
    createdAt: Date.now() - 50_000,
    sequence: 1,
  },
  {
    id: 'msg-assistant-1',
    sessionId: SESSION_ID,
    role: 'assistant',
    content: AGENT_MARKDOWN,
    toolMetadata: null,
    createdAt: Date.now() - 20_000,
    sequence: 2,
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

  await page.route(new RegExp(`/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}(?:\\?.*)?$`), (route: Route) =>
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

async function assertMarkdownRendering(page: Page, screenshotName: string) {
  // Dismiss the first-run onboarding wizard so it doesn't overlay the chat in
  // the screenshot. The wizard auto-opens for users with incomplete setup.
  await page.addInitScript(() => {
    localStorage.setItem('sam-onboarding-wizard-dismissed-test-user', 'true');
  });
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

  // Wait for the agent message to render.
  await expect(page.getByText('First step in the plan')).toBeVisible();

  // 1. Ordered list markers restored (decimal), unordered restored (disc).
  const olStyle = await page
    .locator('.prose ol')
    .first()
    .evaluate((el) => getComputedStyle(el).listStyleType);
  expect(olStyle).toBe('decimal');

  const ulStyle = await page
    .locator('.prose ul:not(.contains-task-list)')
    .first()
    .evaluate((el) => getComputedStyle(el).listStyleType);
  expect(ulStyle).toBe('disc');

  // Task list has no bullet markers.
  const taskListStyle = await page
    .locator('.prose ul.contains-task-list')
    .first()
    .evaluate((el) => getComputedStyle(el).listStyleType);
  expect(taskListStyle).toBe('none');

  // 2. Table renders with bordered cells (grid lines).
  const table = page.locator('.prose table').first();
  await expect(table).toBeVisible();
  const cellBorder = await page
    .locator('.prose td')
    .first()
    .evaluate((el) => getComputedStyle(el).borderBottomWidth);
  expect(cellBorder).not.toBe('0px');

  // 3. Two code blocks render as <pre> (typed highlighted + language-less plain).
  const preCount = await page.locator('.prose pre').count();
  expect(preCount).toBeGreaterThanOrEqual(2);

  // Language-less block preserves line breaks inside a <pre>.
  const langlessText = await page
    .locator('.prose pre', { hasText: 'On branch main' })
    .first()
    .innerText();
  expect(langlessText).toContain('On branch main');
  expect(langlessText).toContain('nothing to commit');
  expect(langlessText).toContain('\n');

  await screenshot(page, screenshotName);
  await assertNoOverflow(page);
}

test.describe('Project Chat Markdown Rendering — Mobile', () => {
  test('lists, tables, and language-less code blocks render correctly', async ({ page }) => {
    await setupMocks(page);
    await assertMarkdownRendering(page, 'markdown-chat-rendering-mobile');
  });
});

test.describe('Project Chat Markdown Rendering — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('lists, tables, and language-less code blocks render correctly', async ({ page }) => {
    await setupMocks(page);
    await assertMarkdownRendering(page, 'markdown-chat-rendering-desktop');
  });
});
