/**
 * Visual + behavioural audit for the collapsed tool-call activity card.
 *
 * Every scenario runs at both project viewports, calls `assertNoOverflow`
 * (which includes the clipped-overflow walk, rule 56) and captures a screenshot.
 * The coordinate assertion in `assertCardWithinBubbleColumn` is the load-bearing
 * one: the card must not reach past the assistant bubble column it sits in
 * (rule 17, "a layout relationship must be asserted as measured coordinates").
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

/**
 * Captures are prefixed with the Playwright project name. Both describes pin a
 * viewport, so the width/height suffix is identical across projects and two
 * projects would otherwise overwrite each other's screenshots.
 */
function shot(page: Page, name: string) {
  return screenshot(page, name, { scopeToProject: true });
}

const PROJECT_ID = 'proj-test-1';
const SESSION_ID = 'sess-tool-groups';

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Tool Group Audit',
  repository: 'user/tool-group-audit',
  repoProvider: 'github',
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

const MOCK_SESSION = {
  id: SESSION_ID,
  workspaceId: null,
  taskId: null,
  topic: 'Grouped tool activity',
  status: 'stopped',
  messageCount: 5,
  createdAt: Date.now() - 600_000,
  updatedAt: Date.now() - 5_000,
  endedAt: Date.now() - 5_000,
  cleanupAt: null,
  isIdle: false,
  agentCompletedAt: null,
  agentSessionId: null,
  agentType: 'claude-code',
};

/** A 254-char title carrying an unbroken 120-char token — the overflow stressor. */
const LONG_LIVE_TITLE =
  'Bash: pnpm --filter @simple-agent-manager/web exec playwright test --grep ' +
  'x'.repeat(120) +
  ' --reporter=line --project="iPhone SE (375x667)" --retries=0';

const TOOL_CONTENT = [{ type: 'terminal', output: 'SAM_GROUP_TOOL_OUTPUT_77\nexit status: 0 ✅' }];

let clock = Date.now() - 500_000;
function nextTs(): number {
  clock += 1_000;
  return clock;
}

function textMessage(id: string, role: 'user' | 'assistant', content: string) {
  return { id, sessionId: SESSION_ID, role, content, toolMetadata: null, createdAt: nextTs() };
}

function toolMessage(
  id: string,
  title: string,
  status: 'pending' | 'in_progress' | 'completed' | 'failed' = 'completed',
  extra: Record<string, unknown> = {}
) {
  return {
    id,
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: `tc-${id}`,
      title,
      kind: 'execute',
      status,
      contentSize: 128,
      ...extra,
    },
    createdAt: nextTs(),
  };
}

function documentMessage(id: string) {
  return {
    id,
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: `tc-${id}`,
      title: 'display_from_library',
      toolName: 'mcp__sam-mcp__display_from_library',
      kind: 'fetch',
      status: 'completed',
      rawInput: { fileId: 'file-group-1' },
      rawOutput: [
        {
          type: 'text',
          text: JSON.stringify({
            id: 'file-group-1',
            filename: 'architecture-review.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 48_128,
          }),
        },
      ],
    },
    createdAt: nextTs(),
  };
}

function resetClock() {
  clock = Date.now() - 500_000;
}

/** (a) text → 3 calls, one of them failed → text. */
function threeCallsOneFailed() {
  resetClock();
  return [
    textMessage('msg-user-1', 'user', 'Run lint, typecheck and the tests.'),
    toolMessage('msg-tool-1', 'Bash: pnpm lint', 'completed'),
    toolMessage('msg-tool-2', 'Bash: pnpm typecheck', 'failed'),
    toolMessage('msg-tool-3', 'Bash: pnpm test', 'completed'),
    textMessage('msg-assistant-1', 'assistant', 'Typecheck failed; the rest passed.'),
  ];
}

/** (b) a 40-call run between two text blocks. */
function fortyCallRun() {
  resetClock();
  return [
    textMessage('msg-user-1', 'user', 'Audit every package.'),
    ...Array.from({ length: 40 }, (_, i) =>
      toolMessage(
        `msg-tool-${i + 1}`,
        `Read: packages/module-${i + 1}/src/index.ts`,
        i % 9 === 0 ? 'failed' : 'completed'
      )
    ),
    textMessage('msg-assistant-1', 'assistant', 'Audited all forty modules.'),
  ];
}

/** (c) a run still in progress whose live title is 254 chars with a long token. */
function runningLongTitle() {
  resetClock();
  return [
    textMessage('msg-user-1', 'user', 'Reproduce the flake.'),
    toolMessage('msg-tool-1', 'Read: apps/web/playwright.config.ts', 'completed'),
    toolMessage('msg-tool-2', LONG_LIVE_TITLE, 'in_progress'),
  ];
}

/** (d) a single call. */
function singleCall() {
  resetClock();
  return [
    textMessage('msg-user-1', 'user', 'What is in the readme?'),
    toolMessage('msg-tool-1', 'Read: README.md', 'completed'),
    textMessage('msg-assistant-1', 'assistant', 'It documents the install steps.'),
  ];
}

/**
 * (h) hostile / non-ASCII content. The `<script>` string must reach the DOM as
 * TEXT: the tool title renders in a plain span and the agent text goes through
 * react-markdown with no `rehype-raw`, so neither may execute.
 */
const XSS_TOOL_TITLE =
  'Bash: echo "<script>alert(1)</script>" &amp; &lt;b&gt;bold&lt;/b&gt; — ✅🚀 日本語 «quoted»';
const UNICODE_TOOL_TITLE = 'Read: packages/ünïcödé/файл-测试-🧪.ts';
const XSS_AGENT_TEXT =
  'Rendered literally: <script>alert(1)</script> plus ✅🚀 日本語 «quoted» and &amp; entities.';
/**
 * What the markdown renderer is expected to SHOW: the script markup escaped to
 * text and the `&amp;` entity decoded to `&`. Asserting the rendered form rather
 * than the source pins both behaviours — a renderer that started executing raw
 * HTML would drop the literal markup and fail this.
 */
const XSS_AGENT_TEXT_RENDERED =
  'Rendered literally: <script>alert(1)</script> plus ✅🚀 日本語 «quoted» and & entities.';

function specialCharacters() {
  resetClock();
  return [
    textMessage(
      'msg-user-1',
      'user',
      'Echo the weird string ✅🚀 日本語 <script>alert(1)</script>'
    ),
    toolMessage('msg-tool-1', XSS_TOOL_TITLE, 'in_progress'),
    toolMessage('msg-tool-2', UNICODE_TOOL_TITLE, 'completed'),
    textMessage('msg-assistant-1', 'assistant', XSS_AGENT_TEXT),
  ];
}

/** (e) a document card between two runs. */
function documentBetweenRuns() {
  resetClock();
  return [
    textMessage('msg-user-1', 'user', 'Summarise the architecture doc.'),
    toolMessage('msg-tool-1', 'Read: docs/architecture.md', 'completed'),
    documentMessage('msg-doc-1'),
    toolMessage('msg-tool-2', 'Bash: wc -l docs/architecture.md', 'completed'),
    textMessage('msg-assistant-1', 'assistant', 'Shared the document above.'),
  ];
}

async function setupMocks(page: Page, messages: unknown[]) {
  const toolContentRequests: string[] = [];

  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: MOCK_SESSION,
    messages,
  });

  // Registered after the shared mocks so it wins precedence for its specific
  // URL (the shared session regex cannot match the deeper tool-content path).
  await page.route(
    `**/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/messages/*/tool-content`,
    (route: Route) => {
      toolContentRequests.push(route.request().url());
      return route.fulfill({ status: 200, json: { content: TOOL_CONTENT } });
    }
  );

  return { toolContentRequests };
}

function groupCard(page: Page) {
  return page.getByTestId('tool-call-group').first();
}

/**
 * The card must occupy the same column as the assistant bubble, capped at the
 * same 80% of the message row.
 *
 * Measured across elements, not read back from the card alone. The bubble itself
 * shrinks to its content, so its RENDERED right edge is not the column edge —
 * the comparison is against the bubble's own flex wrapper, which spans the row's
 * content box, times the shared 80% cap. Removing `max-w-[80%]` from the card
 * makes `card.width === wrapper.width` and fails this.
 *
 * The assistant bubble is the reference, falling back to the user bubble when a
 * scenario has no assistant message yet (a still-running turn). Either wrapper
 * spans the same row content box — `justify-start` vs `justify-end` moves the
 * bubble inside the wrapper, not the wrapper.
 */
async function assertCardWithinBubbleColumn(page: Page) {
  await expect(groupCard(page)).toBeVisible();
  await expect(page.locator('.glass-msg-assistant, .glass-msg-user').first()).toBeVisible();

  const geometry = await page.evaluate(() => {
    const rect = (el: Element | null | undefined) => {
      if (!el) return null;
      const box = el.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width };
    };
    const card = document.querySelector('[data-testid="tool-call-group"]');
    const bubble =
      document.querySelector('.glass-msg-assistant') ?? document.querySelector('.glass-msg-user');
    return {
      card: rect(card),
      cardColumn: rect(card?.parentElement),
      bubbleColumn: rect(bubble?.parentElement),
      viewportWidth: window.innerWidth,
    };
  });

  expect(geometry.card, 'group card must be laid out').not.toBeNull();
  expect(geometry.cardColumn, 'group card column must be laid out').not.toBeNull();
  expect(geometry.bubbleColumn, 'assistant bubble column must be laid out').not.toBeNull();

  // Same column: identical content box, identical left-aligned start.
  expect(Math.abs(geometry.cardColumn!.width - geometry.bubbleColumn!.width)).toBeLessThanOrEqual(
    1
  );
  expect(Math.abs(geometry.card!.left - geometry.bubbleColumn!.left)).toBeLessThanOrEqual(1);

  // Never past the agent bubble column edge (the shared 80% cap).
  const columnEdge = geometry.bubbleColumn!.left + geometry.bubbleColumn!.width * 0.8;
  expect(geometry.card!.right).toBeLessThanOrEqual(columnEdge + 1);
  expect(geometry.card!.right).toBeLessThanOrEqual(geometry.viewportWidth);
}

async function open(page: Page, query = '') {
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}${query}`);
}

function suite(label: string) {
  test(`${label} — text → 3 calls (one failed) → text collapses to one card`, async ({ page }) => {
    await setupMocks(page, threeCallsOneFailed());
    await open(page);

    const header = page.getByRole('button', { name: /3 tool calls/ });
    await expect(header).toHaveAttribute('aria-expanded', 'false');
    // Failures are announced in text on the collapsed card.
    await expect(page.getByText('· 1 failed')).toBeVisible();
    // The prose on both sides stays visible — that is the point of the feature.
    await expect(page.getByText('Run lint, typecheck and the tests.')).toBeVisible();
    await expect(page.getByText('Typecheck failed; the rest passed.')).toBeVisible();
    // No per-call titles until it is expanded.
    await expect(page.getByText('Bash: pnpm typecheck')).toHaveCount(0);

    await assertCardWithinBubbleColumn(page);
    await shot(page, 'tool-group-three-calls-one-failed');
    await assertNoOverflow(page);

    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Bash: pnpm typecheck')).toBeVisible();
    await shot(page, 'tool-group-three-calls-expanded');
    await assertNoOverflow(page);
  });

  test(`${label} — a 40-call run stays one compact card`, async ({ page }) => {
    await setupMocks(page, fortyCallRun());
    await open(page);

    const header = page.getByRole('button', { name: /40 tool calls/ });
    await expect(header).toBeVisible();
    await expect(page.getByText('· 5 failed')).toBeVisible();
    await expect(page.getByText('Audited all forty modules.')).toBeVisible();
    await expect(page.getByTestId('tool-call-group')).toHaveCount(1);

    await assertCardWithinBubbleColumn(page);
    await shot(page, 'tool-group-forty-calls');
    await assertNoOverflow(page);

    await header.click();
    await expect(page.getByText('Read: packages/module-40/src/index.ts')).toBeVisible();
    await shot(page, 'tool-group-forty-calls-expanded');
    await assertNoOverflow(page);
  });

  test(`${label} — a 254-char running title truncates without overflowing`, async ({ page }) => {
    await setupMocks(page, runningLongTitle());
    await open(page);

    const card = groupCard(page);
    await expect(card).toBeVisible();
    // Motion indicator + the currently running tool, without expanding.
    await expect(page.getByTestId('tool-group-glyph')).toHaveAttribute('data-state', 'running');
    const liveLine = card.getByText(/· running Bash: pnpm --filter/);
    await expect(liveLine).toBeVisible();

    // The long title is truncated inside the card, not pushed past its box.
    const box = (await card.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    await assertCardWithinBubbleColumn(page);

    await shot(page, 'tool-group-running-long-title');
    await assertNoOverflow(page);
  });

  test(`${label} — a single call reads "1 tool call"`, async ({ page }) => {
    await setupMocks(page, singleCall());
    await open(page);

    await expect(page.getByRole('button', { name: /1 tool call/ })).toBeVisible();
    await expect(page.getByTestId('tool-group-glyph')).toHaveAttribute('data-state', 'done');

    await assertCardWithinBubbleColumn(page);
    await shot(page, 'tool-group-single-call');
    await assertNoOverflow(page);
  });

  test(`${label} — a document card between two runs stays standalone`, async ({ page }) => {
    await setupMocks(page, documentBetweenRuns());
    await open(page);

    // One single-call group on each side of the document card.
    await expect(page.getByRole('button', { name: /1 tool call/ })).toHaveCount(2);
    const doc = page.getByText('architecture-review.pdf').first();
    await expect(doc).toBeVisible();
    // The document card is NOT inside a group container.
    expect(await doc.evaluate((el) => el.closest('[data-testid="tool-call-group"]') !== null)).toBe(
      false
    );

    await shot(page, 'tool-group-document-standalone');
    await assertNoOverflow(page);
  });

  test(`${label} — expanding then tapping a call lazy-loads its output`, async ({ page }) => {
    const { toolContentRequests } = await setupMocks(page, threeCallsOneFailed());
    await open(page);

    await page.getByRole('button', { name: /3 tool calls/ }).click();
    // Nothing is fetched just by expanding the group.
    expect(toolContentRequests).toEqual([]);

    const callButton = page.getByRole('button', { name: /Bash: pnpm test/ });
    await expect(callButton).toHaveAttribute('aria-expanded', 'false');
    await callButton.click();

    await expect(page.getByText(/SAM_GROUP_TOOL_OUTPUT_77/)).toBeVisible();
    expect(toolContentRequests).toEqual([
      expect.stringContaining('/messages/msg-tool-3/tool-content'),
    ]);

    await shot(page, 'tool-group-call-output-loaded');
    await assertNoOverflow(page);
  });

  test(`${label} — unicode, entities and a literal <script> render as text`, async ({ page }) => {
    // Registered before navigation: an executed `alert(1)` would open a dialog,
    // and an unhandled dialog would hang the page rather than fail loudly.
    const dialogs: string[] = [];
    page.on('dialog', (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });

    await setupMocks(page, specialCharacters());
    await open(page);

    const header = page.getByRole('button', { name: /2 tool calls/ });
    await expect(header).toBeVisible();
    // The live line carries the hostile title while collapsed, as text.
    await expect(page.getByTestId('tool-group-glyph')).toHaveAttribute('data-state', 'running');
    await expect(page.getByText(XSS_TOOL_TITLE).first()).toBeVisible();
    await expect(page.getByText(XSS_AGENT_TEXT_RENDERED)).toBeVisible();

    await assertCardWithinBubbleColumn(page);
    await shot(page, 'tool-group-special-characters');
    await assertNoOverflow(page);

    await header.click();
    /*
     * Both titles are present as TEXT, script markup included. `.last()` because
     * the hostile title now legitimately appears twice — the collapsed live line
     * keeps it while the group is open — and unlike the markdown bubble a plain
     * title span does NOT decode `&amp;`, so the raw string is what must show.
     */
    await expect(page.getByText(XSS_TOOL_TITLE).last()).toBeVisible();
    await expect(page.getByText(UNICODE_TOOL_TITLE).last()).toBeVisible();

    // Nothing executed, and no script element was injected into the conversation.
    expect(dialogs, 'a dialog means the injected script executed').toEqual([]);
    expect(await page.locator('.sam-message-entry script').count()).toBe(0);

    await shot(page, 'tool-group-special-characters-expanded');
    await assertNoOverflow(page);
  });

  test(`${label} — ?tools=expanded seeds every group open`, async ({ page }) => {
    await setupMocks(page, documentBetweenRuns());
    await open(page, '?tools=expanded');

    const headers = page.getByRole('button', { name: /1 tool call/ });
    await expect(headers).toHaveCount(2);
    await expect(headers.nth(0)).toHaveAttribute('aria-expanded', 'true');
    await expect(headers.nth(1)).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByText('Read: docs/architecture.md')).toBeVisible();
    await expect(page.getByText('Bash: wc -l docs/architecture.md')).toBeVisible();

    // Still collapsible from the seeded state.
    await headers.nth(0).click();
    await expect(headers.nth(0)).toHaveAttribute('aria-expanded', 'false');

    await shot(page, 'tool-group-tools-expanded-flag');
    await assertNoOverflow(page);
  });
}

/*
 * Both describes pin their viewport so a scenario's geometry is a property of the
 * describe, not of whichever Playwright project happens to run it. Under
 * `iPhone 14 (390x844)` the mobile describe therefore still renders at 375x667 —
 * intended: 375 is the narrowest supported width and the one the layout
 * assertions were written against.
 */
test.describe('Project Chat Tool Activity Cards — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  suite('mobile');
});

test.describe('Project Chat Tool Activity Cards — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });
  suite('desktop');
});
