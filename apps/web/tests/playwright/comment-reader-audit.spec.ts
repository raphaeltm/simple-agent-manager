/**
 * Visual audit for the comment reader (`/projects/:id/comments/:sessionId/:threadId`).
 *
 * Drives the real app — real routes, real chat item renderer, real `CommentThread` — with
 * every `/api/**` call intercepted. Each scenario checks that the quoted words are painted
 * (CSS Custom Highlight API) AND on screen, not merely in the DOM, plus layout overflow.
 *
 *   npx playwright test tests/playwright/comment-reader-audit.spec.ts \
 *     --project='iPhone SE (375x667)' --project='Desktop (1280x800)'
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
} from './audit-helpers';

const PROJECT_ID = 'proj-reader-1';
const SESSION_ID = 'cs-reader-1';
const VIEWER_ID = 'user-raphael';
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;

const MOCK_USER = makeMockUser({
  email: 'raphael@example.com',
  name: 'Raphaël Titsworth-Morin',
  role: 'superadmin',
  sessionId: 'session-reader-1',
  userId: VIEWER_ID,
});
const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'SAM',
  repository: 'raphaeltm/simple-agent-manager',
  defaultBranch: 'main',
  userId: VIEWER_ID,
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const VIEWER = { id: VIEWER_ID, kind: 'human' as const, name: 'Raphaël Titsworth-Morin' };
const AGENT = { id: 'agent-sam', kind: 'agent' as const, name: 'SAM' };
const DANA = { id: 'user-dana', kind: 'human' as const, name: 'Dana Okonkwo' };

type Row = {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolMetadata: Record<string, unknown> | null;
  createdAt: number;
  sequence: number;
};

let seq = 0;
function row(
  id: string,
  role: string,
  content: string,
  at: number,
  toolMetadata: Record<string, unknown> | null = null
): Row {
  seq += 1;
  return { id, sessionId: SESSION_ID, role, content, toolMetadata, createdAt: at, sequence: seq };
}

/** An agent reply stored the way the VM agent stores it: one row per streamed chunk. */
function streamed(prefix: string, text: string, at: number): Row[] {
  const words = text.split(/(?<= )/);
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += 4) chunks.push(words.slice(i, i + 4).join(''));
  return chunks.map((chunk, index) =>
    row(`${prefix}-${index + 1}`, 'assistant', chunk, at + index)
  );
}

const REPLY_TEXT = [
  'I traced the retry storm to the webhook handler. ',
  'When a delivery arrives twice in quick succession, the first request takes the ledger lock and the second one waits. ',
  'The problem is ordering: the ledger write happens before the idempotency check, so the second request writes a duplicate row and then fails the uniqueness constraint. ',
  'The handler maps that failure to a 500, and the sender retries every 500 with exponential backoff, which is why the same event shows up nine times in the logs.\n\n',
  'I recommend returning 200 for a duplicate delivery and moving the idempotency check in front of the write. ',
  'That keeps the sender happy and makes the handler safe to call twice.',
].join('');

function conversation(): Row[] {
  seq = 0;
  return [
    row('u-1', 'user', 'Why is the payments webhook retrying so much?', NOW - 3 * HOUR),
    row('t-1', 'tool', '', NOW - 3 * HOUR + MIN, {
      toolCallId: 'call-1',
      title: 'Read apps/api/src/routes/webhooks.ts',
      kind: 'read',
      status: 'completed',
    }),
    ...streamed('a-1', REPLY_TEXT, NOW - 3 * HOUR + 2 * MIN),
    row('u-2', 'user', 'Go with 200 for duplicates. Also check the refund path.', NOW - 2 * HOUR),
    ...streamed(
      'a-2',
      'The refund path has the same shape, so I moved its check too. Tests cover both now: a duplicate delivery returns 200 and writes nothing.',
      NOW - 2 * HOUR + 5 * MIN
    ),
    row('u-3', 'user', 'Ship it.', NOW - HOUR),
  ];
}

interface ThreadFixture {
  id: string;
  messageId: string;
  quote: string | null;
  author: typeof VIEWER | typeof AGENT | typeof DANA;
  body: string;
  status?: 'open' | 'sent' | 'resolved';
  createdAt?: number;
  replies?: Array<{
    id: string;
    author: typeof VIEWER | typeof AGENT | typeof DANA;
    body: string;
    createdAt: number;
  }>;
}

function thread(fixture: ThreadFixture) {
  return {
    id: fixture.id,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    anchor: { kind: 'message' as const, messageId: fixture.messageId, quote: fixture.quote },
    author: fixture.author,
    body: fixture.body,
    status: fixture.status ?? 'open',
    createdAt: fixture.createdAt ?? NOW - 50 * MIN,
    updatedAt: fixture.createdAt ?? NOW - 50 * MIN,
    replies: fixture.replies ?? [],
  };
}

const MAIN_THREAD = thread({
  id: 'ct-main',
  // The reply's tenth streamed row: the chat only knows the reply by its first.
  messageId: 'a-1-10',
  quote: 'the ledger write happens before the idempotency check',
  author: DANA,
  body: 'Is moving the check enough, or do we also need a unique index on the delivery id? Two writers could still race.',
  createdAt: NOW - 40 * MIN,
  replies: [
    {
      id: 'cr-1',
      author: AGENT,
      body: 'The unique index already exists; the check just has to run first so the duplicate never reaches it.',
      createdAt: NOW - 30 * MIN,
    },
  ],
});
const SECOND_THREAD = thread({
  id: 'ct-second',
  messageId: 'a-1-1',
  quote: 'I recommend returning 200 for a duplicate delivery',
  author: VIEWER,
  body: 'Agreed — 200 is right for duplicates.',
  createdAt: NOW - 45 * MIN,
});

interface Scenario {
  topic?: string;
  rows?: Row[];
  threads?: ReturnType<typeof thread>[];
  active?: ReturnType<typeof thread>;
  hasMoreBefore?: boolean;
  hasMoreAfter?: boolean;
  earlierRows?: Row[];
  laterRows?: Row[];
  anchorFound?: boolean;
  contextStatus?: number;
  inboxThreads?: ReturnType<typeof thread>[];
  viewerAccess?: 'owner' | 'grantee' | 'reader';
}

async function setupMocks(page: Page, scenario: Scenario = {}) {
  const rows = scenario.rows ?? conversation();
  const threads = scenario.threads ?? [MAIN_THREAD, SECOND_THREAD];
  const active = scenario.active ?? MAIN_THREAD;
  const inboxThreads = scenario.inboxThreads ?? threads;
  const topic = scenario.topic ?? 'Payments webhook retries';

  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, VIEWER_ID);
  await page.routeWebSocket(/.*/, () => {
    /* accepted, never echoed */
  });
  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    const { pathname, searchParams } = new URL(url);
    const base = `/api/projects/${PROJECT_ID}`;
    const sessionBase = `${base}/sessions/${SESSION_ID}`;

    if (pathname === '/api/auth/session' || pathname === '/api/auth/get-session') {
      return route.fulfill({ json: MOCK_USER });
    }
    if (pathname === '/api/projects') {
      return route.fulfill({ json: { projects: [MOCK_PROJECT], nextCursor: null } });
    }
    if (pathname === base) return route.fulfill({ json: MOCK_PROJECT });
    if (pathname === `${base}/comments`) {
      return route.fulfill({
        json: {
          messageThreads: inboxThreads,
          fileThreads: [],
          sessions: [{ id: SESSION_ID, topic }],
          files: [],
          hasMore: false,
          totalCount: inboxThreads.length,
        },
      });
    }
    if (pathname.startsWith(`${sessionBase}/comments/`) && pathname.endsWith('/context')) {
      if (scenario.contextStatus && scenario.contextStatus !== 200) {
        return route.fulfill({
          status: scenario.contextStatus,
          json: { error: 'ERROR', message: 'Something went wrong on the server' },
        });
      }
      const found = scenario.anchorFound ?? true;
      return route.fulfill({
        json: {
          thread: active,
          session: { id: SESSION_ID, topic },
          viewerAccess: scenario.viewerAccess ?? 'owner',
          anchor: { messageId: active.anchor.messageId, found },
          messages: found ? rows : [],
          hasMoreBefore: scenario.hasMoreBefore ?? false,
          hasMoreAfter: scenario.hasMoreAfter ?? false,
        },
      });
    }
    if (pathname === `${sessionBase}/comments`) {
      return route.fulfill({ json: { comments: threads } });
    }
    if (pathname === `${sessionBase}/messages`) {
      // One page each way: the earlier or later rows, then nothing more.
      const rowsForPage = searchParams.has('after') ? scenario.laterRows : scenario.earlierRows;
      return route.fulfill({ json: { messages: rowsForPage ?? [], hasMore: false } });
    }
    if (pathname === `${base}/members`) return route.fulfill({ json: { members: [] } });
    if (pathname === '/api/notifications') {
      return route.fulfill({ json: { notifications: [], unreadCount: 0, nextCursor: null } });
    }
    if (pathname === '/api/nodes' || pathname === '/api/credentials')
      return route.fulfill({ json: [] });
    if (pathname === '/api/chats') return route.fulfill({ json: { sessions: [], total: 0 } });
    if (pathname === '/api/github/installations') return route.fulfill({ json: [] });
    if (pathname === '/api/trial-status') {
      return route.fulfill({
        json: {
          available: false,
          agentType: null,
          hasInfraCredential: false,
          hasAgentCredential: false,
          dailyTokenBudget: null,
          dailyTokenUsage: null,
        },
      });
    }
    if (pathname === '/api/agents') return route.fulfill({ json: { agents: [] } });
    if (pathname === `${base}/sessions`) return route.fulfill({ json: { sessions: [] } });
    if (searchParams.has('anchorKind')) return route.fulfill({ json: { comments: [] } });
    return route.fulfill({ json: {} });
  });
}

async function openReader(page: Page, threadId = 'ct-main') {
  await page.goto(`/projects/${PROJECT_ID}/comments/${SESSION_ID}/${threadId}`);
  await expect(page.getByTestId('comment-reader')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
}

/** The open comment's words are painted and inside the visible conversation. */
async function expectQuoteOnScreen(page: Page, quoteStart: string) {
  const result = await page.evaluate((needle) => {
    const registry = (CSS as unknown as { highlights?: Map<string, Highlight> }).highlights;
    const range = registry?.get('sam-comment-quote')?.values().next().value;
    if (!(range instanceof Range)) return 'missing';
    if (!range.toString().startsWith(needle)) return `wrong:${range.toString().slice(0, 40)}`;
    const scroller = document.querySelector('[data-reader-scroller]');
    if (!scroller) return 'no-scroller';
    const view = scroller.getBoundingClientRect();
    const box = range.getBoundingClientRect();
    const sheet = document.querySelector('section[aria-label="Comment thread"]');
    const bottom = sheet ? Math.min(view.bottom, sheet.getBoundingClientRect().top) : view.bottom;
    return box.top >= view.top && box.bottom <= bottom
      ? 'visible'
      : `offscreen:${box.top}-${box.bottom}/${view.top}-${bottom}`;
  }, quoteStart);
  expect(result).toBe('visible');
}

async function checkLayout(page: Page) {
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
}

const isDesktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

test.describe('Comment reader', () => {
  test('opens on the quoted words of a later chunk of a long reply', async ({ page }) => {
    await setupMocks(page);
    await openReader(page);
    await expectQuoteOnScreen(page, 'the ledger write happens before');
    // The latest word in the thread: in the panel on a desktop, in the sheet's peek on a phone.
    await expect(page.getByText(/The unique index already exists/).first()).toBeVisible();
    await checkLayout(page);
    await screenshot(page, 'comment-reader-normal');
  });

  test('phone sheet open shows the whole thread and other comments', async ({ page }) => {
    test.skip(!!isDesktop(page), 'The sheet is the phone layout');
    await setupMocks(page);
    await openReader(page);
    await page.getByRole('button', { name: /Show the whole thread/ }).click();
    await expect(page.getByText('Also in this chat')).toBeVisible();
    await checkLayout(page);
    await screenshot(page, 'comment-reader-sheet-open');
  });

  test('scrolling away offers a way back to the comment', async ({ page }) => {
    // Enough later conversation that the words can scroll out of view at any width.
    const rows = conversation();
    for (let index = 0; index < 12; index += 1) {
      rows.push(
        row(`u-more-${index}`, 'user', `Follow-up question ${index + 1}.`, NOW - 50 * MIN + index)
      );
    }
    await setupMocks(page, { rows });
    await openReader(page);
    const scroller = page.locator('[data-reader-scroller]');
    await scroller.hover();
    await page.mouse.wheel(0, 1600);
    await page.waitForTimeout(400);
    const back = page.getByRole('button', { name: 'Back to the comment' });
    await expect(back).toBeVisible();
    await screenshot(page, 'comment-reader-scrolled-away');
    await back.click();
    await page.waitForTimeout(300);
    await expectQuoteOnScreen(page, 'the ledger write happens before');
  });

  test('loads earlier messages above without losing the comment', async ({ page }) => {
    const rows = conversation();
    seq = 100;
    const earlier = [
      row('u-0', 'user', 'Earlier: can you look at the payments service?', NOW - 5 * HOUR),
      ...streamed(
        'a-0',
        'Sure. I will start with the webhook handler and its logs.',
        NOW - 5 * HOUR + MIN
      ),
    ];
    await setupMocks(page, { rows, hasMoreBefore: true, earlierRows: earlier });
    await openReader(page);
    const earlierButton = page.getByRole('button', { name: 'Earlier messages' });
    await earlierButton.scrollIntoViewIfNeeded();
    // What the reader is looking at must not move when older messages arrive above it.
    const question = page.getByText('Why is the payments webhook retrying so much?');
    const before = await question.boundingBox();
    await earlierButton.click();
    await expect(page.getByText('Earlier: can you look at the payments service?')).toBeAttached();
    await expect(page.getByText('Start of the chat')).toBeAttached();
    await page.waitForTimeout(300);
    const after = await question.boundingBox();
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(2);
    await checkLayout(page);
    await screenshot(page, 'comment-reader-earlier-loaded');
    // The comment is one tap away.
    const back = page.getByRole('button', { name: 'Back to the comment' });
    if (await back.isVisible()) await back.click();
    await page.waitForTimeout(300);
    await expectQuoteOnScreen(page, 'the ledger write happens before');
  });

  test('loads later messages below and keeps the comment in place', async ({ page }) => {
    const rows = conversation();
    seq = 200;
    const later = [
      row('u-9', 'user', 'Later: did the deploy go out?', NOW - 20 * MIN),
      ...streamed('a-9', 'Yes. The deploy finished and the retries stopped.', NOW - 19 * MIN),
    ];
    await setupMocks(page, { rows, hasMoreAfter: true, laterRows: later });
    await openReader(page);
    const anchorRow = page.locator('[data-reader-anchor="true"]');
    const before = await anchorRow.boundingBox();
    const laterButton = page.getByRole('button', { name: 'Later messages' });
    await laterButton.click();
    await expect(page.getByText('Later: did the deploy go out?')).toBeAttached();
    await expect(page.getByText('Latest message')).toBeAttached();
    await expect(laterButton).toHaveCount(0);
    // Clicking scrolled the button into view; bring the comment back and check it is intact.
    const back = page.getByRole('button', { name: 'Back to the comment' });
    if (await back.isVisible()) await back.click();
    await page.waitForTimeout(300);
    await expectQuoteOnScreen(page, 'the ledger write happens before');
    expect(before).not.toBeNull();
    await checkLayout(page);
    await screenshot(page, 'comment-reader-later-loaded');
  });

  test('long title, long comment and an unbroken URL wrap without overflow', async ({ page }) => {
    const longUrl = `https://example.com/${'very-long-path-segment-'.repeat(12)}end`;
    const rows = conversation();
    rows.push(row('u-4', 'user', `See ${longUrl} for the full trace.`, NOW - 30 * MIN));
    const longThread = thread({
      ...MAIN_THREAD,
      messageId: 'a-1-10',
      quote: MAIN_THREAD.anchor.quote,
      author: DANA,
      body: `${'This is a deliberately long comment that keeps going to stress the panel layout. '.repeat(7)} ${longUrl}`,
    });
    await setupMocks(page, {
      rows,
      topic: `Investigate the payments webhook retry storm across staging and production — ${'with a very long topic '.repeat(8)}`,
      threads: [longThread, SECOND_THREAD],
      active: longThread,
    });
    await openReader(page);
    await expectQuoteOnScreen(page, 'the ledger write happens before');
    await checkLayout(page);
    await screenshot(page, 'comment-reader-long-text');
  });

  test('a quote that no longer matches marks the whole message and says so', async ({ page }) => {
    const missing = thread({
      ...MAIN_THREAD,
      messageId: 'a-2-1',
      quote: 'words that are not in this message anywhere at all',
      author: DANA,
      body: 'This quote was edited away.',
    });
    await setupMocks(page, { threads: [missing], active: missing });
    await openReader(page, missing.id);
    const notice = page.getByText(/exact words of this comment are not in the message/);
    await expect(notice).toBeVisible();
    // The notice is on screen below the header, not scrolled under it.
    const noticeBox = await notice.boundingBox();
    const scrollerBox = await page.locator('[data-reader-scroller]').boundingBox();
    expect(noticeBox?.y ?? 0).toBeGreaterThanOrEqual(scrollerBox?.y ?? 0);
    await checkLayout(page);
    await screenshot(page, 'comment-reader-quote-not-found');
  });

  test('a message that is gone shows the stored quote', async ({ page }) => {
    await setupMocks(page, { anchorFound: false });
    await openReader(page);
    await expect(
      page.getByText('The message this comment is on is no longer in the chat.')
    ).toBeVisible();
    await checkLayout(page);
    await screenshot(page, 'comment-reader-message-gone');
  });

  test('many comments: navigation position and a long other-comments list', async ({ page }) => {
    const many = Array.from({ length: 34 }, (_, index) =>
      thread({
        id: `ct-many-${index}`,
        messageId: index % 2 === 0 ? 'a-1-1' : 'u-2',
        quote: index % 2 === 0 ? 'I traced the retry storm' : 'Go with 200 for duplicates',
        author: index % 3 === 0 ? VIEWER : index % 3 === 1 ? DANA : AGENT,
        body: `Comment number ${index + 1} about this chat.`,
        createdAt: NOW - index * MIN,
      })
    );
    const threads = [MAIN_THREAD, ...many];
    await setupMocks(page, { threads, inboxThreads: threads });
    await openReader(page);
    await expect(page.getByRole('link', { name: 'Next comment' })).toBeVisible();
    // Eighteen comments on one reply fold into a few chips and "+N more".
    await expect(page.getByRole('button', { name: /^\+\d+ more$/ }).first()).toBeVisible();
    if (!isDesktop(page)) await page.getByRole('button', { name: /Show the whole thread/ }).click();
    await expect(page.getByText('Comment number 34 about this chat.')).toBeAttached();
    await checkLayout(page);
    await screenshot(page, 'comment-reader-many');
  });

  test('special characters render as text', async ({ page }) => {
    const rows = conversation();
    rows.push(
      row('u-5', 'user', '<script>alert("x")</script> & emoji 🚀 — naïve café ✓', NOW - 10 * MIN)
    );
    const special = thread({
      id: 'ct-special',
      messageId: 'u-5',
      quote: '<script>alert("x")</script>',
      author: DANA,
      body: 'Escaped? <b>bold</b> &amp; 🚀',
    });
    await setupMocks(page, { rows, threads: [special], active: special });
    await openReader(page, special.id);
    await expect(page.getByText('Escaped? <b>bold</b> &amp; 🚀').first()).toBeVisible();
    await checkLayout(page);
    await screenshot(page, 'comment-reader-special-chars');
  });

  test('error: the server fails to load the conversation', async ({ page }) => {
    await setupMocks(page, { contextStatus: 500 });
    await openReader(page);
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    // No thread actions next to a conversation that failed to load.
    await expect(page.getByLabel('Comment thread')).toHaveCount(0);
    await checkLayout(page);
    await screenshot(page, 'comment-reader-error');
  });

  test('not found: the comment is gone', async ({ page }) => {
    await setupMocks(page, { contextStatus: 404 });
    await openReader(page);
    await expect(page.getByText('This comment is no longer available.')).toBeVisible();
    await expect(page.getByLabel('Comment thread')).toHaveCount(0);
    await checkLayout(page);
    await screenshot(page, 'comment-reader-not-found');
  });

  test('Comments page row opens the reader', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/comments`);
    await page
      .getByRole('button', { name: /Is moving the check enough/ })
      .first()
      .click();
    await expect(page).toHaveURL(new RegExp(`/comments/${SESSION_ID}/ct-main$`));
    await page.waitForTimeout(500);
    await expectQuoteOnScreen(page, 'the ledger write happens before');
  });
});
