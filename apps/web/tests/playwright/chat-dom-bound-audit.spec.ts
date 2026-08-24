/**
 * DOM bounds for a LONG project-chat conversation, in a real browser.
 *
 * This has to be a browser test, not jsdom: jsdom has no layout engine, so the
 * react-virtuoso test double renders every row and any windowing assertion made
 * against it passes whether virtualization works or not (.claude/rules/17,
 * .claude/rules/56). Only a real browser can prove the rendered row count stays
 * bounded while the data set grows.
 *
 * Covers both scrollers on the surface:
 *  - the conversation list, which was already virtualized
 *  - the timeline drawer, which rendered EVERY entry until this change
 *
 * The counts these tests capture are the before/after evidence reported in the PR.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

// These specs deliberately mount the heaviest fixture in the suite (400 chat
// messages with markdown + code blocks, plus a 400-entry timeline), then take a
// full-page screenshot and walk the DOM for clipped overflow. That is well past
// the default 30s per-test budget on a loaded machine — the measurements
// themselves are fast, the fixture is what is slow.
test.describe.configure({ timeout: 120_000 });

const PROJECT_ID = 'proj-bound-1';
const SESSION_ID = 'cs-bound-1';
const NOW = Date.now();

/** Large enough that "bounded" and "renders everything" cannot be confused. */
const MESSAGE_COUNT = 400;
const TIMELINE_USER_MESSAGE_COUNT = 300;
const ACTIVITY_EVENT_COUNT = 100;

const MOCK_USER = makeMockUser({
  email: 'bound@example.com',
  name: 'Bound Tester',
  role: 'user',
  sessionId: 'session-bound-1',
  userId: 'user-bound-1',
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'DOM Bound Project',
  repository: 'testuser/bound-repo',
  defaultBranch: 'main',
  userId: 'user-bound-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function makeChatSession() {
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    status: 'active',
    topic: 'A very long conversation used to measure rendered DOM weight',
    workspaceId: 'ws-bound-1',
    agentSessionId: 'as-1',
    isIdle: false,
    agentCompletedAt: null,
    createdAt: '2026-03-20T10:00:00Z',
    updatedAt: '2026-03-20T10:00:00Z',
  };
}

/**
 * A long conversation. Alternates user/assistant so the items do not collapse
 * into one another — `chatMessagesToConversationItems` merges consecutive
 * assistant rows, which would otherwise shrink the list under us.
 */
function makeLongConversation() {
  return Array.from({ length: MESSAGE_COUNT }, (_, i) => ({
    id: `msg-${i}`,
    sessionId: SESSION_ID,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content:
      i % 2 === 0
        ? `User request number ${i}: please refactor the module and explain the tradeoffs involved.`
        : `Assistant reply number ${i}. Here is a reasonably long paragraph of prose so each bubble carries realistic DOM weight rather than a single short word, plus a code sample:\n\n\`\`\`ts\nconst value${i} = compute(${i});\n\`\`\``,
    toolMetadata: null,
    createdAt: NOW - (MESSAGE_COUNT - i) * 60_000,
  }));
}

function makeTimelineMessages() {
  return {
    messages: Array.from({ length: TIMELINE_USER_MESSAGE_COUNT }, (_, i) => ({
      id: `tl-msg-${i}`,
      sessionId: SESSION_ID,
      role: 'user',
      content: `Timeline user message ${i} — a request long enough to wrap onto a second line in the drawer.`,
      toolMetadata: null,
      createdAt: NOW - (TIMELINE_USER_MESSAGE_COUNT - i) * 60_000,
    })),
    hasMore: false,
  };
}

function makeActivityEvents() {
  return {
    events: Array.from({ length: ACTIVITY_EVENT_COUNT }, (_, i) => ({
      id: `evt-${i}`,
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      eventType: 'workspace.updated',
      title: `Activity event ${i}`,
      severity: 'info',
      createdAt: NOW - (ACTIVITY_EVENT_COUNT - i) * 90_000,
    })),
  };
}

async function setupApiMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const pathname = new URL(route.request().url()).pathname;

    if (pathname === '/api/auth/get-session') {
      await route.fulfill({ json: MOCK_USER });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}`) {
      await route.fulfill({
        json: {
          session: makeChatSession(),
          messages: makeLongConversation(),
          hasMore: false,
          state: { activity: 'idle', activityAt: NOW, statusError: null, currentPlan: null },
        },
      });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/messages`) {
      await route.fulfill({ json: makeTimelineMessages() });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/state`) {
      await route.fulfill({
        json: { activity: 'idle', activityAt: NOW, statusError: null, currentPlan: null },
      });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions`) {
      await route.fulfill({ json: { sessions: [makeChatSession()], total: 1 } });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/activity`) {
      await route.fulfill({ json: makeActivityEvents() });
      return;
    }
    if (pathname === '/api/notifications') {
      await route.fulfill({ json: { notifications: [], nextCursor: null } });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}`) {
      await route.fulfill({ json: MOCK_PROJECT });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/tasks`) {
      await route.fulfill({ json: { tasks: [], nextCursor: null } });
      return;
    }
    if (pathname === '/api/projects') {
      await route.fulfill({ json: { projects: [MOCK_PROJECT], total: 1 } });
      return;
    }
    if (pathname === '/api/agents') {
      await route.fulfill({ json: { agents: [] } });
      return;
    }
    if (pathname === '/api/chats' || pathname === '/api/chats/recent') {
      await route.fulfill({ json: { sessions: [], total: 0, totalActive: 0 } });
      return;
    }

    await route.fulfill({ json: {} });
  });
}

/**
 * Total timeline entries the drawer is fed: user messages from the loaded
 * conversation (half of MESSAGE_COUNT) plus the activity events. The drawer also
 * merges its own paginated user-message fetch, so this is a conservative floor
 * on the real entry count — fine, since it only bounds the "not everything"
 * ceiling.
 */
const TOTAL_TIMELINE_ENTRIES = MESSAGE_COUNT / 2 + ACTIVITY_EVENT_COUNT;

/**
 * Fewest entry rows a working drawer must mount. A correctly measured Virtuoso
 * fills its viewport; a broken one renders one row into an empty panel. Set low
 * enough for the 375px viewport to stay stable across font/CSS tweaks.
 */
const MIN_VISIBLE_TIMELINE_ROWS = 4;

/** Count message rows currently mounted in the conversation list. */
async function countMessageRows(page: Page): Promise<number> {
  return page.locator('.sam-message-entry').count();
}

/**
 * Count entry rows mounted in the timeline drawer. Scoped to the jump buttons so
 * the drawer's two header controls (Context, Close) are excluded.
 */
async function countTimelineRows(page: Page): Promise<number> {
  return page
    .getByRole('dialog', { name: 'Session timeline' })
    .locator('button')
    .filter({ hasText: /:\d\d\s*(AM|PM)?/ })
    .count();
}

async function openChat(page: Page) {
  await setupApiMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  await page.locator('.sam-message-entry').first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(600);
}

async function openTimeline(page: Page) {
  const timelineBtn = page.getByRole('button', { name: /^Timeline$/ });
  if (
    !(await timelineBtn
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    const detailsBtn = page.getByLabel('Show session details').first();
    if (await detailsBtn.isVisible().catch(() => false)) {
      await detailsBtn.click();
    }
  }
  await timelineBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await timelineBtn.click();
  await page.getByRole('dialog', { name: 'Session timeline' }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
}

test.describe('Chat DOM bounds — Mobile', () => {
  test('conversation list stays bounded with 400 messages', async ({ page }) => {
    await openChat(page);

    const rendered = await countMessageRows(page);
    console.log(`[dom-bound] mobile conversation rows rendered: ${rendered} / ${MESSAGE_COUNT}`);

    expect(rendered).toBeGreaterThan(0);
    // Bounded to roughly viewport + 200px overscan. The ceiling is deliberately
    // loose — the assertion that matters is "not O(messages)".
    expect(rendered).toBeLessThan(MESSAGE_COUNT / 2);

    await assertNoOverflow(page);
    await screenshot(page, 'chat-dom-bound-conversation-mobile');
  });

  test('timeline drawer stays bounded with 400 entries', async ({ page }) => {
    await openChat(page);
    await openTimeline(page);

    const dialog = page.getByRole('dialog', { name: 'Session timeline' });
    const rendered = await countTimelineRows(page);
    console.log(`[dom-bound] mobile timeline rows rendered: ${rendered}`);

    // Lower bound FIRST. An early version of this change wrapped the rows in an
    // extra element inside Virtuoso's `components.List`, which broke height
    // measurement so the drawer rendered a SINGLE row into a full-height panel.
    // A bare `> 0` assertion passed on that — the drawer was visibly broken and
    // the test was green. The floor is what makes this test discriminating.
    expect(rendered).toBeGreaterThanOrEqual(MIN_VISIBLE_TIMELINE_ROWS);
    // Before virtualization the drawer rendered every entry, so the count tracked
    // the data set exactly.
    expect(rendered).toBeLessThan(TOTAL_TIMELINE_ENTRIES / 2);

    await expect(dialog).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'chat-dom-bound-timeline-mobile');
  });

  test('timeline entries remain clickable and jump into the conversation', async ({ page }) => {
    // Virtualizing the drawer must not break the jump — the drawer closes and
    // the target message flashes. Guards against the DOM bound being achieved by
    // simply breaking the list.
    await openChat(page);
    await openTimeline(page);

    const dialog = page.getByRole('dialog', { name: 'Session timeline' });
    // Click whatever entry is actually windowed in, not a specific one — under
    // virtualization only the first screenful is mounted, so targeting a
    // particular entry would just be testing which rows happen to render.
    const target = dialog
      .getByRole('button')
      .filter({ hasText: /User request number/ })
      .first();
    const targetText = ((await target.innerText()).match(/User request number \d+/) ?? [])[0];
    expect(targetText).toBeTruthy();

    await target.click();

    await expect(dialog).toBeHidden({ timeout: 5_000 });
    // Assert the message is actually SCROLLED INTO VIEW, not that the flash class
    // is present. `.sam-message-highlight` auto-clears 2200ms after the click
    // (coupled to the animation duration), while a smooth scroll across hundreds
    // of virtualized rows can still be in flight at that point — so the class is
    // a race, whereas "the target is on screen" is the durable outcome the user
    // cares about and the one rule 17 asks a real browser to confirm.
    await expect(page.getByText(targetText!, { exact: false }).first()).toBeInViewport({
      timeout: 15_000,
    });

    await assertNoOverflow(page);
    await screenshot(page, 'chat-dom-bound-timeline-jump-mobile');
  });
});

test.describe('Chat DOM bounds — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('conversation list stays bounded with 400 messages', async ({ page }) => {
    await openChat(page);

    const rendered = await countMessageRows(page);
    console.log(`[dom-bound] desktop conversation rows rendered: ${rendered} / ${MESSAGE_COUNT}`);

    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(MESSAGE_COUNT / 2);

    await assertNoOverflow(page);
    await screenshot(page, 'chat-dom-bound-conversation-desktop');
  });

  test('timeline drawer stays bounded with 400 entries', async ({ page }) => {
    await openChat(page);
    await openTimeline(page);

    const dialog = page.getByRole('dialog', { name: 'Session timeline' });
    const rendered = await countTimelineRows(page);
    console.log(`[dom-bound] desktop timeline rows rendered: ${rendered}`);

    expect(rendered).toBeGreaterThanOrEqual(MIN_VISIBLE_TIMELINE_ROWS);
    expect(rendered).toBeLessThan(TOTAL_TIMELINE_ENTRIES / 2);

    await expect(dialog).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'chat-dom-bound-timeline-desktop');
  });

  test('scrolling the conversation keeps the rendered row count bounded', async ({ page }) => {
    // The windowing claim is about the STEADY STATE, not just the first paint —
    // a list that grew its DOM as you scrolled would pass a first-paint-only check.
    await openChat(page);
    const initial = await countMessageRows(page);

    const scroller = page.locator('[data-testid="virtuoso-scroller"], .sam-message-entry').first();
    for (let i = 0; i < 5; i++) {
      await scroller.evaluate(() => window.scrollBy(0, 2000));
      await page.mouse.wheel(0, 2000);
      await page.waitForTimeout(250);
    }

    const afterScroll = await countMessageRows(page);
    console.log(`[dom-bound] desktop rows after scrolling: ${afterScroll} (initial ${initial})`);

    expect(afterScroll).toBeLessThan(MESSAGE_COUNT / 2);
    await assertNoOverflow(page);
    await screenshot(page, 'chat-dom-bound-after-scroll-desktop');
  });
});
