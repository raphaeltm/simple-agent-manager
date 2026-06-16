import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

// Visual audit for the graduated markdown rendering fixes in project chat:
//   1. List markers (ol=decimal, ul=disc, nested circle/square, task lists none)
//   2. Green-glow agent bubble treatment
//   3. Readable tables (grid lines, header tint, zebra, min-width, horizontal scroll)
//   4. Language-less fenced code blocks render as <pre> (line breaks preserved)
// Rendered through the real project chat chain (ProjectMessageView ->
// AcpConversationItemView -> acp-client MessageBubble) so acp-chat.css and
// index.css apply exactly as in production.

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
  'Nested bullets:',
  '',
  '- top level bullet',
  '  - second level bullet',
  '    - third level bullet',
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

const WIDE_MERMAID_MARKDOWN = [
  'Architecture diagram:',
  '',
  '```mermaid',
  'flowchart LR',
  '  Start([User asks for architecture review]) --> Gather[Gather repository context and recent task history]',
  '  Gather --> Analyze{Can the agent explain the system without a diagram?}',
  '  Analyze -->|No| Diagram[Render a Mermaid diagram inside the chat bubble]',
  '  Diagram --> Inspect[Open fullscreen view and inspect pan zoom reset controls]',
  '  Inspect --> Done([Readable audit trail])',
  '  Analyze -->|Yes| Done',
  '```',
].join('\n');

const INVALID_MERMAID_MARKDOWN = [
  'Broken diagram:',
  '',
  '```mermaid',
  'flowchart LR',
  '  A -->',
  '```',
].join('\n');

const MERMAID_MESSAGES = [
  {
    id: 'msg-user-mermaid',
    sessionId: SESSION_ID,
    role: 'user',
    content: 'Show the architecture as a diagram.',
    toolMetadata: null,
    createdAt: Date.now() - 50_000,
    sequence: 1,
  },
  {
    id: 'msg-assistant-mermaid',
    sessionId: SESSION_ID,
    role: 'assistant',
    content: WIDE_MERMAID_MARKDOWN,
    toolMetadata: null,
    createdAt: Date.now() - 20_000,
    sequence: 2,
  },
];

const INVALID_MERMAID_MESSAGES = [
  {
    id: 'msg-user-invalid-mermaid',
    sessionId: SESSION_ID,
    role: 'user',
    content: 'Show a broken diagram.',
    toolMetadata: null,
    createdAt: Date.now() - 50_000,
    sequence: 1,
  },
  {
    id: 'msg-assistant-invalid-mermaid',
    sessionId: SESSION_ID,
    role: 'assistant',
    content: INVALID_MERMAID_MARKDOWN,
    toolMetadata: null,
    createdAt: Date.now() - 20_000,
    sequence: 2,
  },
];

async function setupMocks(page: Page) {
  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: MOCK_SESSION,
    messages: MOCK_MESSAGES,
  });
}

async function setupMessages(page: Page, messages: typeof MOCK_MESSAGES) {
  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: MOCK_SESSION,
    messages,
  });
}

async function openChat(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('sam-onboarding-wizard-dismissed-test-user', 'true');
  });
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
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

  // Nested unordered markers: second level = circle, third level = square.
  const nestedUlStyle = await page
    .locator('.prose ul ul')
    .first()
    .evaluate((el) => getComputedStyle(el).listStyleType);
  expect(nestedUlStyle).toBe('circle');

  const deepUlStyle = await page
    .locator('.prose ul ul ul')
    .first()
    .evaluate((el) => getComputedStyle(el).listStyleType);
  expect(deepUlStyle).toBe('square');

  // Task list has no bullet markers.
  const taskListStyle = await page
    .locator('.prose ul.contains-task-list')
    .first()
    .evaluate((el) => getComputedStyle(el).listStyleType);
  expect(taskListStyle).toBe('none');

  // 2. Agent bubble has the green-glow treatment (green border + box-shadow).
  const assistantBubble = page.locator('.glass-msg-assistant').first();
  await expect(assistantBubble).toBeVisible();
  const glow = await assistantBubble.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { borderColor: cs.borderColor, boxShadow: cs.boxShadow };
  });
  // Green channel dominant in the border (rgb 34, 197, 94 → green > red, green > blue).
  const channels = glow.borderColor.match(/(\d{1,3}),\s{0,2}(\d{1,3}),\s{0,2}(\d{1,3})/);
  expect(channels).not.toBeNull();
  const [r, g, b] = [Number(channels![1]), Number(channels![2]), Number(channels![3])];
  expect(g).toBeGreaterThan(r);
  expect(g).toBeGreaterThan(b);
  // A multi-layer box-shadow is present (not "none").
  expect(glow.boxShadow).not.toBe('none');

  // 3. Table renders with bordered cells (grid lines).
  const table = page.locator('.prose table').first();
  await expect(table).toBeVisible();
  const cellBorder = await page
    .locator('.prose td')
    .first()
    .evaluate((el) => getComputedStyle(el).borderBottomWidth);
  expect(cellBorder).not.toBe('0px');

  // 4. Two code blocks render as <pre> (typed highlighted + language-less plain).
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
  const langlessColors = await page
    .locator('.prose pre', { hasText: 'On branch main' })
    .first()
    .evaluate((el) => {
      const style = getComputedStyle(el);
      return { backgroundColor: style.backgroundColor, color: style.color };
    });
  expect(langlessColors.backgroundColor).toBe('rgb(1, 22, 39)');
  expect(langlessColors.color).toBe('rgb(214, 222, 235)');

  await screenshot(page, screenshotName);
  await assertNoOverflow(page);
}

async function assertMermaidRendering(page: Page, screenshotName: string) {
  await openChat(page);

  const diagram = page.getByTestId('mermaid-diagram');
  await expect(diagram).toBeVisible({ timeout: 15_000 });
  const svg = page.locator('[data-testid="mermaid-diagram-svg"] svg').first();
  await expect(svg).toBeVisible({ timeout: 15_000 });

  const svgInfo = await svg.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return {
      text: node.textContent ?? '',
      width: rect.width,
      height: rect.height,
      viewBox: node.getAttribute('viewBox'),
    };
  });
  expect(svgInfo.text).toContain('Render a Mermaid diagram');
  expect(svgInfo.width).toBeGreaterThan(40);
  expect(svgInfo.height).toBeGreaterThan(40);
  expect(svgInfo.viewBox).toBeTruthy();

  await screenshot(page, `${screenshotName}-inline`);
  await assertNoOverflow(page);

  await page.getByRole('button', { name: 'Expand Mermaid diagram' }).click();
  const fullscreen = page.getByTestId('mermaid-diagram-fullscreen');
  await expect(fullscreen).toBeVisible();
  const fullscreenViewport = page.getByTestId('mermaid-diagram-fullscreen-svg');
  const fullscreenSvg = page.locator('[data-testid="mermaid-diagram-fullscreen-svg"] svg');
  await expect(fullscreenSvg).toBeVisible();
  await page.getByRole('button', { name: 'Reset diagram view' }).last().click();
  const viewBoxBeforePinch = await fullscreenSvg.getAttribute('viewBox');
  const viewportBox = await fullscreenViewport.boundingBox();
  if (!viewportBox) {
    throw new Error('Expected fullscreen Mermaid viewport to have a bounding box');
  }
  await fullscreenViewport.dispatchEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    pointerId: 101,
    pointerType: 'touch',
    clientX: viewportBox.x + viewportBox.width * 0.35,
    clientY: viewportBox.y + viewportBox.height * 0.5,
  });
  await fullscreenViewport.dispatchEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    pointerId: 102,
    pointerType: 'touch',
    clientX: viewportBox.x + viewportBox.width * 0.65,
    clientY: viewportBox.y + viewportBox.height * 0.5,
  });
  await fullscreenViewport.dispatchEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    pointerId: 102,
    pointerType: 'touch',
    clientX: viewportBox.x + viewportBox.width * 0.78,
    clientY: viewportBox.y + viewportBox.height * 0.5,
  });
  await expect.poll(() => fullscreenSvg.getAttribute('viewBox')).not.toBe(viewBoxBeforePinch);
  await fullscreenViewport.dispatchEvent('pointerup', {
    bubbles: true,
    cancelable: true,
    pointerId: 101,
    pointerType: 'touch',
  });
  await fullscreenViewport.dispatchEvent('pointerup', {
    bubbles: true,
    cancelable: true,
    pointerId: 102,
    pointerType: 'touch',
  });
  await screenshot(page, `${screenshotName}-fullscreen`);
  await assertNoOverflow(page);

  await page.keyboard.press('Escape');
  await expect(fullscreen).toBeHidden();
  await expect(page.getByRole('button', { name: 'Expand Mermaid diagram' })).toBeFocused();
}

async function assertInvalidMermaid(page: Page, screenshotName: string) {
  await openChat(page);

  const error = page.getByTestId('mermaid-diagram-error');
  await expect(error).toBeVisible({ timeout: 15_000 });
  await expect(error).toContainText('Mermaid diagram error');
  await expect(error.getByRole('button', { name: 'Copy source' })).toBeVisible();
  await screenshot(page, screenshotName);
  await assertNoOverflow(page);
}

test.describe('Project Chat Markdown Rendering — Mobile', () => {
  // Pin the mobile viewport so the stored screenshot reflects 375px regardless
  // of which Playwright project runs this block (otherwise the Desktop project
  // run overwrites the file with a 1280px capture).
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('lists, tables, and language-less code blocks render correctly', async ({ page }) => {
    await setupMocks(page);
    await assertMarkdownRendering(page, 'markdown-chat-rendering-mobile');
  });

  test('mermaid diagrams render inline and fullscreen without overflow', async ({ page }) => {
    await setupMessages(page, MERMAID_MESSAGES);
    await assertMermaidRendering(page, 'markdown-chat-mermaid-mobile');
  });

  test('invalid mermaid diagrams fail gracefully', async ({ page }) => {
    await setupMessages(page, INVALID_MERMAID_MESSAGES);
    await assertInvalidMermaid(page, 'markdown-chat-mermaid-invalid-mobile');
  });
});

test.describe('Project Chat Markdown Rendering — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('lists, tables, and language-less code blocks render correctly', async ({ page }) => {
    await setupMocks(page);
    await assertMarkdownRendering(page, 'markdown-chat-rendering-desktop');
  });

  test('mermaid diagrams render inline and fullscreen without overflow', async ({ page }) => {
    await setupMessages(page, MERMAID_MESSAGES);
    await assertMermaidRendering(page, 'markdown-chat-mermaid-desktop');
  });

  test('invalid mermaid diagrams fail gracefully', async ({ page }) => {
    await setupMessages(page, INVALID_MERMAID_MESSAGES);
    await assertInvalidMermaid(page, 'markdown-chat-mermaid-invalid-desktop');
  });
});
