/**
 * Visual + behavioural audit for the collapsed tool-call count card.
 *
 * Stress data per `.claude/rules/17`: a 40-call run, a 1-call run (which must
 * NOT collapse), a failed call, a still-running call, a 200+ character tool
 * title, long thinking, and interleaved text.
 */
import { expect, type Locator, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot, setupProjectChatMocks } from './audit-helpers';

const PROJECT_ID = 'proj-tool-group';
const SESSION_ID = 'sess-tool-group';

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Tool Group Audit',
  repository: 'user/tool-group-audit',
  repoProvider: 'github',
  createdAt: '2026-09-13T00:00:00Z',
  updatedAt: '2026-09-13T00:00:00Z',
};

const MOCK_SESSION = {
  id: SESSION_ID,
  workspaceId: null,
  taskId: null,
  topic: 'Collapsed tool runs',
  status: 'stopped',
  messageCount: 50,
  createdAt: Date.now() - 600_000,
  updatedAt: Date.now() - 5_000,
  endedAt: Date.now() - 5_000,
  cleanupAt: null,
  isIdle: false,
  agentCompletedAt: null,
  agentSessionId: null,
  agentType: 'claude-code',
};

const LONG_TITLE =
  'Bash: pnpm --filter @simple-agent-manager/api test -- tests/workers/project-data-message-grouping.test.ts --reporter=verbose --no-color --run --silent=false ' +
  'AND THEN some/very/deeply/nested/path/that/keeps/going/without/any/spaces/at/all/to/force/a/wrap-or-truncate-decision.ts';

const TOOL_NAMES = ['Read', 'Grep', 'Bash', 'Edit', 'Write'];

let sequence = 0;
let clock = Date.now() - 600_000;

function nextSequence() {
  sequence += 1;
  clock += 1_000;
  return { sequence, createdAt: clock };
}

function textMessage(id: string, role: 'user' | 'assistant' | 'thinking', content: string) {
  return { id, sessionId: SESSION_ID, role, content, toolMetadata: null, ...nextSequence() };
}

function toolMessage(
  id: string,
  options: { title?: string; status?: string; contentSize?: number } = {}
) {
  const title = options.title ?? `${TOOL_NAMES[sequence % TOOL_NAMES.length]}: src/index.ts`;
  return {
    id,
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: `tc-${id}`,
      title,
      kind: 'execute',
      status: options.status ?? 'completed',
      contentSize: options.contentSize ?? 256,
    },
    ...nextSequence(),
  };
}

/**
 * One conversation exercising every shape the card has to survive:
 * a 3-call run, a 1-call run, a 40-call run, a run containing a failure and a
 * still-running call, a 200+ char title, and long thinking between text blocks.
 */
function buildStressMessages() {
  sequence = 0;
  clock = Date.now() - 600_000;
  return [
    textMessage('m-user-1', 'user', 'Investigate the payload size of this chat session.'),
    textMessage(
      'm-assistant-1',
      'assistant',
      'I will start by reading the persistence path and the read path.'
    ),

    // A normal run of three.
    toolMessage('m-tool-a1'),
    toolMessage('m-tool-a2'),
    toolMessage('m-tool-a3'),

    textMessage(
      'm-assistant-2',
      'assistant',
      'Every streaming token is persisted as its own row. Next I will check how the client renders them.'
    ),

    // A lone call — must render standalone, not as a "1 tool call" card.
    toolMessage('m-tool-solo', { title: 'Read: apps/web/src/components/project-message-view/types.ts' }),

    textMessage(
      'm-thinking-1',
      'thinking',
      'The client already merges consecutive assistant rows on receipt, so the fragmentation is discarded at render time. '.repeat(
        6
      )
    ),

    // A run with a failure and a still-running call.
    toolMessage('m-tool-b1'),
    toolMessage('m-tool-b2', { status: 'failed' }),
    toolMessage('m-tool-b3', { status: 'in_progress' }),
    toolMessage('m-tool-b4', { title: LONG_TITLE }),

    textMessage('m-assistant-3', 'assistant', 'Now the wide sweep.'),

    // 40 calls in one run.
    ...Array.from({ length: 40 }, (_, i) =>
      toolMessage(`m-tool-many-${i}`, { contentSize: 1024 * (i + 1) })
    ),

    textMessage(
      'm-assistant-4',
      'assistant',
      'Grouping the deltas server-side cuts the payload by roughly 85%.'
    ),
  ];
}

async function setupMocks(page: Page) {
  const toolContentRequests: string[] = [];
  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: MOCK_SESSION,
    messages: buildStressMessages(),
  });

  await page.route(
    `**/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/messages/*/tool-content`,
    (route: Route) => {
      toolContentRequests.push(route.request().url());
      return route.fulfill({
        status: 200,
        json: { content: [{ type: 'content', text: 'TOOL_OUTPUT_MARKER_42' }] },
      });
    }
  );

  await page.addInitScript(() => {
    localStorage.setItem('sam-onboarding-wizard-dismissed-test-user', 'true');
  });

  return { toolContentRequests };
}

async function openChat(page: Page, query = '') {
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}${query}`);
  // The list mounts scrolled to the newest message.
  await expect(
    page.getByText('Grouping the deltas server-side cuts the payload by roughly 85%.')
  ).toBeVisible();
}

async function scrollChatTo(page: Page, position: 'top' | number) {
  await page.evaluate((target) => {
    const scroller = document.querySelector('[data-virtuoso-scroller]');
    if (!(scroller instanceof HTMLElement)) return;
    scroller.scrollTop = target === 'top' ? 0 : target;
  }, position);
  await page.waitForTimeout(220);
}

/**
 * Scroll the virtualized conversation until `locator` mounts, then assert it is
 * visible.
 *
 * Virtuoso only mounts the rows inside its scroll window, so `getByText(...)` on
 * an off-window row fails with "element not found" — which is indistinguishable
 * from the row not existing at all. Walking the scroller from the top and
 * asserting only once the row has mounted is what makes these assertions mean
 * "this is on screen for a user" rather than "this happened to be in the window".
 */
async function revealInChat(page: Page, locator: Locator) {
  await scrollChatTo(page, 'top');
  for (let step = 0; step < 60; step += 1) {
    if (await locator.count()) break;
    const atBottom = await page.evaluate(() => {
      const scroller = document.querySelector('[data-virtuoso-scroller]');
      if (!(scroller instanceof HTMLElement)) return true;
      const max = scroller.scrollHeight - scroller.clientHeight;
      if (scroller.scrollTop >= max - 1) return true;
      scroller.scrollTop = Math.min(max, scroller.scrollTop + scroller.clientHeight * 0.6);
      return false;
    });
    await page.waitForTimeout(180);
    if (atBottom) break;
  }
  await locator.first().scrollIntoViewIfNeeded();
  await expect(locator.first()).toBeVisible();
}

async function auditCollapsed(page: Page, name: string) {
  const { toolContentRequests } = await setupMocks(page);
  await openChat(page);

  // The 40-call run is one card at the bottom of the conversation.
  await expect(page.getByRole('button', { name: /^40 tool calls/ })).toBeVisible();
  await screenshot(page, `${name}-tail`);
  await assertNoOverflow(page);

  await revealInChat(page, page.getByRole('button', { name: /^3 tool calls/ }));
  await screenshot(page, `${name}-head`);
  await assertNoOverflow(page);

  // The lone call is still its own card, never a "1 tool call" wrapper. This is
  // also the liveness assertion for the absence checks below, which would
  // otherwise pass just as well if nothing had rendered.
  await revealInChat(
    page,
    page.getByText('Read: apps/web/src/components/project-message-view/types.ts')
  );
  await expect(page.getByRole('button', { name: /^1 tool call$/ })).toHaveCount(0);
  // A collapsed run hides its members' titles until expanded — checked after
  // scrolling the run into view, so "not found" cannot mean "not mounted".
  await revealInChat(page, page.getByRole('button', { name: /^4 tool calls/ }));
  await expect(page.getByText(LONG_TITLE)).toHaveCount(0);
  // Failure state is surfaced without expanding.
  await expect(page.getByText('1 failed')).toBeVisible();
  await screenshot(page, `${name}-mixed-status`);
  await assertNoOverflow(page);

  // Nothing was fetched: the collapsed card costs zero tool-content requests.
  expect(toolContentRequests).toEqual([]);
}

async function auditExpansion(page: Page, name: string) {
  const { toolContentRequests } = await setupMocks(page);
  await openChat(page);

  // Level one: reveal the list. This run carries a failure, a still-running
  // call, and a 200+ character title.
  const group = page.getByRole('button', { name: /^4 tool calls/ });
  await revealInChat(page, group);
  await expect(page.getByText('1 failed')).toBeVisible();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await group.click();
  await expect(group).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText(LONG_TITLE)).toBeVisible();
  // Bring the revealed list into frame. `fullPage` cannot capture content that
  // lives below the fold of the chat's own scroll container, so without this the
  // screenshot shows only the (now open) header and proves nothing.
  await page.getByText(LONG_TITLE).scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await screenshot(page, `${name}-list`);
  await assertNoOverflow(page);

  // Level two: load one call's output.
  expect(toolContentRequests).toEqual([]);
  await page.getByRole('button', { name: new RegExp(escapeRegExp(LONG_TITLE)) }).click();
  await expect(page.getByText('TOOL_OUTPUT_MARKER_42')).toBeVisible();
  expect(toolContentRequests).toEqual([
    expect.stringContaining('/messages/m-tool-b4/tool-content'),
  ]);

  await page.getByText('TOOL_OUTPUT_MARKER_42').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await screenshot(page, `${name}-output`);
  await assertNoOverflow(page);
}

async function auditExpandAllFlag(page: Page, name: string) {
  await setupMocks(page);
  await openChat(page, '?tools=expanded');

  // The escape hatch opens every run without any clicking: the member titles of
  // the first run are on screen straight away.
  await revealInChat(page, page.getByRole('button', { name: /^3 tool calls/ }));
  const groups = await page.getByTestId('tool-call-group').all();
  expect(groups.length).toBeGreaterThan(0);
  for (const group of groups) {
    await expect(group.getByRole('button').first()).toHaveAttribute('aria-expanded', 'true');
  }
  // Member titles are on screen, i.e. the list really is open rather than just
  // reporting aria-expanded.
  await expect(page.getByText(/src\/index\.ts/).first()).toBeVisible();

  await page.getByText(/src\/index\.ts/).first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await screenshot(page, name);
  await assertNoOverflow(page);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe('Project Chat Tool Call Group — Mobile', () => {
  test('collapses runs into a count card', async ({ page }) => {
    await auditCollapsed(page, 'tool-call-group-collapsed-mobile');
  });

  test('expands to the list and then to a single call output', async ({ page }) => {
    await auditExpansion(page, 'tool-call-group-expanded-mobile');
  });

  test('?tools=expanded opens every run', async ({ page }) => {
    await auditExpandAllFlag(page, 'tool-call-group-expand-all-mobile');
  });
});

test.describe('Project Chat Tool Call Group — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('collapses runs into a count card', async ({ page }) => {
    await auditCollapsed(page, 'tool-call-group-collapsed-desktop');
  });

  test('expands to the list and then to a single call output', async ({ page }) => {
    await auditExpansion(page, 'tool-call-group-expanded-desktop');
  });

  test('?tools=expanded opens every run', async ({ page }) => {
    await auditExpandAllFlag(page, 'tool-call-group-expand-all-desktop');
  });
});
