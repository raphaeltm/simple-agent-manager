/**
 * Documentation screenshots for reading a comment in its conversation (Collaboration guide,
 * "Read a comment in its conversation"), on a desktop and a phone.
 *
 * Drives the REAL comment reader (`/projects/:id/comments/:sessionId/:threadId`) with mocked
 * API data and asserts that the quoted words are painted and on screen before capturing
 * (`.claude/rules/62-tests-must-observe-the-real-trigger.md`). The stress and failure cases live
 * in `comment-reader-audit.spec.ts`; this fixture uses ordinary, fictional data.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-comment-reader \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { makeMockUser, seedTheme } from './audit-helpers';
import { expectQuoteOnScreen, type MessageRow, messageRowsFor } from './comment-reader-helpers';
import { docsShot } from './docs-shot';

const PROJECT_ID = 'proj-docs-comments';
const SESSION_ID = 'cs-docs-webhooks';
const VIEWER_ID = 'user-ana';
const NOW = Date.parse('2026-10-23T15:00:00Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

const MOCK_USER = makeMockUser({
  email: 'ana@example.com',
  name: 'Ana Ruiz',
  role: 'user',
  sessionId: 'session-docs-comments',
  userId: VIEWER_ID,
});
const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'acme/payments-api',
  repository: 'acme/payments-api',
  defaultBranch: 'main',
  userId: VIEWER_ID,
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

const ANA = { id: VIEWER_ID, kind: 'human' as const, name: 'Ana Ruiz' };
const BEN = { id: 'user-ben', kind: 'human' as const, name: 'Ben Okafor' };
const AGENT = { id: 'agent-docs', kind: 'agent' as const, name: 'SAM agent' };

const { row, streamed, startAt } = messageRowsFor(SESSION_ID);

const REPLY = [
  'I traced the retry storm to the webhook handler. ',
  'When a delivery arrives twice in quick succession, the first request takes the ledger lock and the second one waits. ',
  'The problem is ordering: the ledger write happens before the idempotency check, so the second request writes a duplicate row and then fails the uniqueness constraint. ',
  'The handler maps that failure to a 500, and the sender retries every 500 with exponential backoff, which is why the same event shows up nine times in the logs.\n\n',
  'I recommend returning 200 for a duplicate delivery and moving the idempotency check in front of the write. ',
  'That keeps the sender happy and makes the handler safe to call twice.',
].join('');

function conversation(): MessageRow[] {
  startAt(0);
  return [
    row('u-1', 'user', 'Why is the payments webhook retrying so much?', NOW - 3 * HOUR),
    row('t-1', 'tool', '', NOW - 3 * HOUR + MIN, {
      toolCallId: 'call-1',
      title: 'Read src/routes/webhooks.ts',
      kind: 'read',
      status: 'completed',
    }),
    ...streamed('a-1', REPLY, NOW - 3 * HOUR + 2 * MIN),
    row('u-2', 'user', 'Go with 200 for duplicates. Also check the refund path.', NOW - 2 * HOUR),
    ...streamed(
      'a-2',
      'The refund path has the same shape, so I moved its check too. Tests cover both now: a duplicate delivery returns 200 and writes nothing.',
      NOW - 2 * HOUR + 5 * MIN
    ),
  ];
}

function thread(fixture: {
  id: string;
  messageId: string;
  quote: string;
  author: typeof ANA | typeof BEN;
  body: string;
  createdAt: number;
  replies?: Array<{
    id: string;
    author: typeof ANA | typeof AGENT;
    body: string;
    createdAt: number;
  }>;
}) {
  return {
    id: fixture.id,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    anchor: { kind: 'message' as const, messageId: fixture.messageId, quote: fixture.quote },
    author: fixture.author,
    body: fixture.body,
    status: 'open' as const,
    createdAt: fixture.createdAt,
    updatedAt: fixture.createdAt,
    replies: fixture.replies ?? [],
  };
}

const MAIN_THREAD = thread({
  id: 'ct-main',
  // The reply's tenth streamed row: the chat only knows the reply by its first.
  messageId: 'a-1-10',
  quote: 'the ledger write happens before the idempotency check',
  author: BEN,
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
  author: ANA,
  body: 'Agreed: 200 is right for duplicates.',
  createdAt: NOW - 45 * MIN,
});

const TOPIC = 'Payments webhook retries';

async function setupMocks(page: Page) {
  const threads = [MAIN_THREAD, SECOND_THREAD];
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, VIEWER_ID);
  await page.routeWebSocket(/.*/, () => {
    /* accepted, never echoed */
  });
  await page.route('**/api/**', async (route: Route) => {
    const { pathname, searchParams } = new URL(route.request().url());
    const base = `/api/projects/${PROJECT_ID}`;
    const sessionBase = `${base}/sessions/${SESSION_ID}`;
    const json = (body: unknown) => route.fulfill({ json: body });

    if (pathname === '/api/auth/session' || pathname === '/api/auth/get-session')
      return json(MOCK_USER);
    if (pathname === '/api/projects') return json({ projects: [MOCK_PROJECT], nextCursor: null });
    if (pathname === base) return json(MOCK_PROJECT);
    if (pathname === `${base}/comments`)
      return json({
        messageThreads: threads,
        fileThreads: [],
        sessions: [{ id: SESSION_ID, topic: TOPIC }],
        files: [],
        hasMore: false,
        totalCount: threads.length,
      });
    if (pathname.startsWith(`${sessionBase}/comments/`) && pathname.endsWith('/context'))
      return json({
        thread: MAIN_THREAD,
        session: { id: SESSION_ID, topic: TOPIC },
        viewerAccess: 'owner',
        anchor: { messageId: MAIN_THREAD.anchor.messageId, found: true },
        messages: conversation(),
        hasMoreBefore: false,
        hasMoreAfter: false,
      });
    if (pathname === `${sessionBase}/comments`) return json({ comments: threads });
    if (pathname === `${sessionBase}/messages`) return json({ messages: [], hasMore: false });
    if (pathname === `${base}/members`) return json({ members: [] });
    if (pathname === '/api/notifications')
      return json({ notifications: [], unreadCount: 0, nextCursor: null });
    if (pathname === '/api/nodes' || pathname === '/api/credentials') return json([]);
    if (pathname === '/api/chats') return json({ sessions: [], total: 0 });
    if (pathname === '/api/github/installations') return json([]);
    if (pathname === '/api/trial-status')
      return json({
        available: false,
        agentType: null,
        hasInfraCredential: false,
        hasAgentCredential: false,
        dailyTokenBudget: null,
        dailyTokenUsage: null,
      });
    if (pathname === '/api/agents') return json({ agents: [] });
    if (pathname === `${base}/sessions`) return json({ sessions: [] });
    if (searchParams.has('anchorKind')) return json({ comments: [] });
    return json({});
  });
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

test('docs: a comment read in its conversation', async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await seedTheme(page, 'dark');
  if (isMobile(page)) await page.setViewportSize({ width: 375, height: 812 });
  await setupMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/comments/${SESSION_ID}/${MAIN_THREAD.id}`);
  await expect(page.getByTestId('comment-reader')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await expectQuoteOnScreen(page, 'the ledger write happens before');
  // The latest word in the thread: in the panel on a desktop, in the sheet's peek on a phone.
  await expect(page.getByText(/The unique index already exists/).first()).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await page.mouse.move(2, 2);
  if (isMobile(page)) {
    await docsShot(page, 'comment-reader-mobile');
    return;
  }
  // The reader and its thread panel, without the project sidebar.
  await docsShot(page, 'comment-reader', page.getByTestId('comment-reader'));
});
