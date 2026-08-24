/**
 * Visual audit for the comment-navigation prototype.
 *
 * Drives the REAL app — real routes, real `SessionHeader`, real
 * `ChatTimelineDrawer`, real `NavSidebar` — with every `/api/**` call
 * intercepted, which is the established pattern in this directory. Nothing here
 * renders a stand-in shell, so what the screenshots show is what the production
 * components actually produce.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
} from './audit-helpers';

const PROJECT_ID = 'proj-comments-1';
const SESSION_ID = 'cs-comments-1';
const VIEWER_ID = 'user-raphael';

const MOCK_USER = makeMockUser({
  email: 'raphael@example.com',
  name: 'Raphaël Titsworth-Morin',
  role: 'superadmin',
  sessionId: 'session-comments-1',
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

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// --- Authors -----------------------------------------------------------------

const VIEWER = { id: VIEWER_ID, kind: 'human' as const, name: 'Raphaël Titsworth-Morin' };
const AGENT = { id: 'agent-sam', kind: 'agent' as const, name: 'SAM' };
const TEAMMATE = { id: 'user-dana', kind: 'human' as const, name: 'Dana Okonkwo' };

// --- Conversation ------------------------------------------------------------

const MESSAGES = [
  {
    id: 'msg-1',
    sessionId: SESSION_ID,
    role: 'user',
    content:
      'Add a comments button to the chat session header so I can quickly find unresolved comments.',
    toolMetadata: null,
    createdAt: NOW - 3 * HOUR,
  },
  {
    id: 'msg-2',
    sessionId: SESSION_ID,
    role: 'assistant',
    content:
      "I've mapped the surfaces. The action row currently lives inside the collapsed session-details disclosure, so a button there alone would not solve discovery — I'm adding a chip to the always-visible row as well.",
    toolMetadata: null,
    createdAt: NOW - 3 * HOUR + 4 * MIN,
  },
  {
    id: 'msg-3',
    sessionId: SESSION_ID,
    role: 'user',
    content: 'Good catch. Also interleave comments into the timeline drawer.',
    toolMetadata: null,
    createdAt: NOW - 2 * HOUR,
  },
  {
    id: 'msg-4',
    sessionId: SESSION_ID,
    role: 'assistant',
    content:
      'Done. Comment entries are positioned at their last activity rather than creation time, and the dot is coloured by thread state: amber for open, blue for with-agent, green for resolved.',
    toolMetadata: null,
    createdAt: NOW - 110 * MIN,
  },
  {
    id: 'msg-5',
    sessionId: SESSION_ID,
    role: 'assistant',
    content:
      ' The project-level page now reads the project-wide comments endpoint once, merges chat and library threads, and discloses the cap above the buckets when the response is truncated.',
    toolMetadata: null,
    createdAt: NOW - 40 * MIN,
  },
  {
    id: 'msg-6',
    sessionId: SESSION_ID,
    role: 'user',
    content: 'What icon are you using for the nav item?',
    toolMetadata: null,
    createdAt: NOW - 20 * MIN,
  },
];

// --- Comment threads ---------------------------------------------------------
//
// Deliberately spans every bucket, both author kinds, quoted and unquoted
// anchors, deep and shallow threads, and one deliberately oversized body — the
// list must stay uniform under all of them.

const THREADS = [
  {
    id: 'ct-1',
    sessionId: SESSION_ID,
    anchor: {
      kind: 'message' as const,
      messageId: 'msg-4',
      quote: 'amber for open, blue for with-agent, green for resolved',
    },
    author: VIEWER,
    body: 'Does this still read correctly for someone with deuteranopia? The amber and green will be close.',
    status: 'open' as const,
    createdAt: NOW - 100 * MIN,
    updatedAt: NOW - 12 * MIN,
    replies: [
      {
        id: 'cr-1',
        author: AGENT,
        body: 'Every state also carries a text label and a distinct glyph, so colour is never the only channel. I can add a pattern fill to the dots if you want belt and braces.',
        createdAt: NOW - 12 * MIN,
      },
    ],
  },
  {
    id: 'ct-2',
    sessionId: SESSION_ID,
    anchor: {
      kind: 'message' as const,
      messageId: 'msg-5',
      quote: 'one endpoint returns every thread in the project',
    },
    author: TEAMMATE,
    body: 'The project-wide endpoint makes this drawer viable for large projects. Please keep the single-request path covered.',
    status: 'open' as const,
    createdAt: NOW - 26 * MIN,
    updatedAt: NOW - 26 * MIN,
    replies: [],
  },
  {
    id: 'ct-3',
    sessionId: SESSION_ID,
    anchor: { kind: 'message' as const, messageId: 'msg-2', quote: null },
    author: VIEWER,
    body: 'Make the chip disappear entirely when everything is resolved — I do not want a permanent zero in the header.',
    status: 'sent' as const,
    createdAt: NOW - 70 * MIN,
    updatedAt: NOW - 68 * MIN,
    replies: [
      {
        id: 'cr-3',
        author: VIEWER,
        body: 'Sending this one through so you pick it up on the next turn.',
        createdAt: NOW - 68 * MIN,
        sentToAgent: true,
      },
    ],
  },
  {
    id: 'ct-4',
    sessionId: SESSION_ID,
    anchor: {
      kind: 'message' as const,
      messageId: 'msg-3',
      quote: 'interleave comments into the timeline drawer',
    },
    author: VIEWER,
    body: 'Worth checking whether this makes the timeline too noisy on a long session. Maybe comments need their own toggle next to Context.',
    status: 'open' as const,
    createdAt: NOW - 95 * MIN,
    updatedAt: NOW - 95 * MIN,
    replies: [],
  },
  {
    id: 'ct-5',
    sessionId: SESSION_ID,
    anchor: {
      kind: 'message' as const,
      messageId: 'msg-1',
      quote: 'so I can quickly find unresolved comments',
    },
    author: TEAMMATE,
    body: 'Strongly agree — I have lost track of at least three review threads this week because they were buried in sessions I had stopped scrolling.',
    status: 'resolved' as const,
    createdAt: NOW - 2.5 * HOUR,
    updatedAt: NOW - 2 * HOUR,
    replies: [
      {
        id: 'cr-5a',
        author: VIEWER,
        body: 'That is exactly the problem this is for.',
        createdAt: NOW - 2.2 * HOUR,
      },
      {
        id: 'cr-5b',
        author: AGENT,
        body: 'Tracking as the primary acceptance criterion for the prototype.',
        createdAt: NOW - 2 * HOUR,
      },
    ],
  },
  {
    id: 'ct-6',
    sessionId: SESSION_ID,
    anchor: {
      kind: 'message' as const,
      messageId: 'msg-2',
      quote:
        'The action row currently lives inside the collapsed session-details disclosure, so a button there alone would not solve discovery',
    },
    author: AGENT,
    body: 'Flagging a related decision for you: the chip is suppressed when the unresolved count is zero, which means a session in a healthy state shows no comment affordance at all. That is intentional — a permanently visible zero trains people to stop looking at the header — but it does mean there is no discoverable entry point to browse resolved threads from the collapsed state. The expanded action row keeps the full Comments button for that case, and the project-level page lists every bucket regardless. Say the word if you would rather always show the chip.',
    status: 'open' as const,
    createdAt: NOW - 55 * MIN,
    updatedAt: NOW - 55 * MIN,
    replies: [],
  },
  {
    id: 'ct-7',
    sessionId: SESSION_ID,
    anchor: { kind: 'message' as const, messageId: 'msg-6', quote: 'What icon' },
    author: VIEWER,
    body: 'MessageSquareQuote 👍 — 明確に違う。',
    status: 'resolved' as const,
    createdAt: NOW - 18 * MIN,
    updatedAt: NOW - 15 * MIN,
    replies: [
      {
        id: 'cr-7',
        author: AGENT,
        body: 'Resolved.',
        createdAt: NOW - 15 * MIN,
      },
    ],
  },
];

// A second session's worth, so the project page is genuinely cross-session.
const OTHER_SESSION_ID = 'cs-comments-2';
const OTHER_THREADS = [
  {
    id: 'ct-8',
    sessionId: OTHER_SESSION_ID,
    anchor: {
      kind: 'message' as const,
      messageId: 'msg-o1',
      quote: 'recovery_attempts is a lifetime counter',
    },
    author: AGENT,
    body: 'Answered your question here — the reset belongs on both success paths, symmetric with sleepAttempts.',
    status: 'open' as const,
    createdAt: NOW - 5 * HOUR,
    updatedAt: NOW - 45 * MIN,
    replies: [
      { id: 'cr-8', author: AGENT, body: 'Patch is on the branch.', createdAt: NOW - 45 * MIN },
    ],
  },
  {
    id: 'ct-9',
    sessionId: OTHER_SESSION_ID,
    anchor: { kind: 'message' as const, messageId: 'msg-o2', quote: null },
    author: VIEWER,
    body: 'Do not merge this until staging is green.',
    status: 'open' as const,
    createdAt: NOW - 3 * DAY,
    updatedAt: NOW - 3 * DAY,
    replies: [],
  },
];

const SESSIONS = [
  {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    status: 'active',
    topic: 'Comment navigation UI',
    workspaceId: 'ws-comments-1',
    agentSessionId: 'as-1',
    isIdle: false,
    isMine: true,
    agentCompletedAt: null,
    task: {
      id: 'task-1',
      status: 'in_progress',
      title: 'Prototype comment navigation UI',
      outputBranch: 'sam/ui-uh-looking-uh-9m7yzp',
      outputPrUrl: null,
      errorMessage: null,
      outputSummary: null,
    },
    createdAt: new Date(NOW - 3 * HOUR).toISOString(),
    updatedAt: new Date(NOW - 20 * MIN).toISOString(),
  },
  {
    id: OTHER_SESSION_ID,
    projectId: PROJECT_ID,
    status: 'sleeping',
    topic: 'Session wake recovery_attempts brick',
    workspaceId: null,
    agentSessionId: null,
    isIdle: true,
    isMine: true,
    agentCompletedAt: null,
    task: null,
    createdAt: new Date(NOW - 5 * HOUR).toISOString(),
    updatedAt: new Date(NOW - 45 * MIN).toISOString(),
  },
];

const LIBRARY_FILES = [
  {
    id: 'file-1',
    projectId: PROJECT_ID,
    filename: 'comment-navigation-design.md',
    directory: '/design/',
    mimeType: 'text/markdown',
    sizeBytes: 8_214,
    status: 'ready',
    tags: [{ tag: 'design' }],
    uploadSource: 'agent',
    createdAt: NOW - 6 * HOUR,
    updatedAt: NOW - 90 * MIN,
  },
];

const FILE_THREADS = [
  {
    id: 'ft-1',
    projectId: PROJECT_ID,
    fileId: 'file-1',
    anchor: {
      kind: 'library_file' as const,
      fileId: 'file-1',
      quote: 'the reply-notification story',
    },
    author: TEAMMATE,
    body: 'This section needs to say which channel the notification goes out on — web push, or just the bell?',
    status: 'open' as const,
    createdAt: NOW - 80 * MIN,
    updatedAt: NOW - 80 * MIN,
    replies: [],
  },
];

const FILE_PREVIEW_BODY = [
  '# Comment navigation design',
  '',
  'This markdown file records the reply-notification story and the open questions.',
  '',
  'The reply-notification story needs to say whether updates go to web push or just the bell.',
].join('\n');

/**
 * `GET /api/projects/:projectId/comments` — the whole inbox in one response.
 *
 * Spans two chat sessions and one library file on purpose, so the project page
 * is exercising the cross-source join rather than a single conversation.
 */
const PROJECT_COMMENTS_RESPONSE = {
  messageThreads: [...THREADS, ...OTHER_THREADS],
  fileThreads: FILE_THREADS,
  sessions: SESSIONS.map((session) => ({ id: session.id, topic: session.topic })),
  files: LIBRARY_FILES.map((file) => ({ id: file.id, filename: file.filename })),
  hasMore: false,
  totalCount: THREADS.length + OTHER_THREADS.length + FILE_THREADS.length,
};

// --- API mocks ---------------------------------------------------------------

async function setupMocks(page: Page) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, VIEWER_ID);

  // Hold the live-update socket open with no server behind it. Aborting it
  // instead leaves a "Reconnecting…" banner across every screenshot, which is an
  // artefact of the mock harness rather than anything the design does.
  await page.routeWebSocket(/.*/, () => {
    /* accepted, never echoed */
  });

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    const { pathname, searchParams } = new URL(url);

    if (pathname.includes('/ws') || url.includes('websocket')) {
      await route.abort();
      return;
    }

    const base = `/api/projects/${PROJECT_ID}`;

    // --- auth / shell ---
    if (pathname === '/api/auth/session' || pathname === '/api/auth/get-session') {
      await route.fulfill({ json: MOCK_USER });
      return;
    }
    if (pathname === '/api/projects') {
      await route.fulfill({ json: { projects: [MOCK_PROJECT], nextCursor: null } });
      return;
    }
    if (pathname === base) {
      await route.fulfill({ json: MOCK_PROJECT });
      return;
    }

    // --- comments ---
    // The project-wide inbox. One endpoint returns every thread in the project
    // plus the session topics and filenames needed to label them, which is what
    // replaced the per-session + per-file fan-out.
    if (pathname === `${base}/comments`) {
      await route.fulfill({ json: PROJECT_COMMENTS_RESPONSE });
      return;
    }
    if (pathname === `${base}/sessions/${SESSION_ID}/comments`) {
      await route.fulfill({ json: { comments: THREADS } });
      return;
    }
    if (pathname === `${base}/sessions/${OTHER_SESSION_ID}/comments`) {
      await route.fulfill({ json: { comments: OTHER_THREADS } });
      return;
    }
    if (pathname === `${base}/library/file-1/comments`) {
      await route.fulfill({ json: { threads: FILE_THREADS, hasMore: false } });
      return;
    }
    if (pathname === `${base}/library/file-1`) {
      const file = LIBRARY_FILES[0];
      await route.fulfill({ json: { file, tags: file.tags } });
      return;
    }
    if (pathname === `${base}/library/file-1/preview`) {
      await route.fulfill({ status: 200, contentType: 'text/markdown', body: FILE_PREVIEW_BODY });
      return;
    }
    if (pathname === `${base}/library/directories`) {
      await route.fulfill({ json: { directories: [] } });
      return;
    }
    if (pathname === `${base}/library`) {
      await route.fulfill({
        json: { files: LIBRARY_FILES, cursor: null, total: LIBRARY_FILES.length },
      });
      return;
    }

    // --- session data ---
    if (pathname === `${base}/sessions/${SESSION_ID}/messages`) {
      await route.fulfill({ json: { messages: MESSAGES, hasMore: false } });
      return;
    }
    if (pathname === `${base}/sessions/${SESSION_ID}/state`) {
      await route.fulfill({
        json: { activity: 'idle', activityAt: NOW, statusError: null, currentPlan: null },
      });
      return;
    }
    if (pathname === `${base}/sessions/${SESSION_ID}`) {
      await route.fulfill({
        json: {
          session: SESSIONS[0],
          messages: MESSAGES,
          hasMore: false,
          state: { activity: 'idle', activityAt: NOW, statusError: null, currentPlan: null },
        },
      });
      return;
    }
    if (pathname === `${base}/sessions`) {
      await route.fulfill({ json: { sessions: SESSIONS } });
      return;
    }
    if (pathname === `${base}/activity`) {
      await route.fulfill({
        json: {
          events: [
            {
              id: 'evt-1',
              eventType: 'session.started',
              actorType: 'system',
              actorId: null,
              workspaceId: 'ws-comments-1',
              sessionId: SESSION_ID,
              taskId: null,
              payload: null,
              createdAt: NOW - 3 * HOUR - MIN,
            },
          ],
          hasMore: false,
        },
      });
      return;
    }

    // --- quiet the rest of the shell ---
    if (pathname === '/api/notifications') {
      await route.fulfill({ json: { notifications: [], unreadCount: 0, nextCursor: null } });
      return;
    }
    if (pathname === '/api/nodes' || pathname === '/api/credentials') {
      await route.fulfill({ json: [] });
      return;
    }
    if (pathname === '/api/chats') {
      await route.fulfill({ json: { sessions: [], total: 0 } });
      return;
    }
    if (pathname === '/api/github/installations') {
      await route.fulfill({ json: [] });
      return;
    }
    if (pathname === '/api/trial-status') {
      await route.fulfill({
        json: {
          available: false,
          agentType: null,
          hasInfraCredential: false,
          hasAgentCredential: false,
          dailyTokenBudget: null,
          dailyTokenUsage: null,
        },
      });
      return;
    }
    if (pathname === '/api/agents') {
      await route.fulfill({ json: { agents: [] } });
      return;
    }
    if (pathname === '/api/providers/catalog') {
      await route.fulfill({ json: { catalogs: [] } });
      return;
    }
    if (pathname === `${base}/agent-profiles`) {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (pathname === `${base}/tasks`) {
      await route.fulfill({ json: { tasks: [], nextCursor: null } });
      return;
    }
    if (searchParams.has('anchorKind')) {
      await route.fulfill({ json: { comments: [] } });
      return;
    }

    await route.fulfill({ json: {} });
  });
}

async function openChat(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  // The last message, so this waits on a rendered conversation without
  // depending on how far the virtualized list has scrolled.
  await page
    .getByText('What icon are you using for the nav item?')
    .first()
    .waitFor({ timeout: 20_000 });
  await waitForUiSettled(page);
}

/** Expand the session-details disclosure so the action row is reachable. */
async function expandHeader(page: Page) {
  const details = page.getByLabel('Show session details').first();
  if (await details.isVisible().catch(() => false)) {
    await details.click();
    await expect(page.getByRole('button', { name: /^Comments/ }).first()).toBeVisible();
  }
}

async function openCommentsDrawer(page: Page) {
  // The always-visible chip is the intended entry point; fall back to the
  // action-row button so the test still passes if the chip is suppressed.
  const chip = page.getByRole('button', { name: /unresolved comment/i }).first();
  if (await chip.isVisible().catch(() => false)) {
    await chip.click();
  } else {
    await expandHeader(page);
    await page
      .getByRole('button', { name: /^Comments/ })
      .first()
      .click();
  }
  const drawer = page.getByRole('dialog', { name: 'Session comments' });
  await drawer.waitFor({ timeout: 10_000 });
  await expect(drawer.locator('[data-comment-thread-id]').first()).toBeVisible();
  await waitForUiSettled(page);
}

async function waitForUiSettled(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
}

async function assertFixedElementsInsideViewport(page: Page) {
  const offenders = await page.evaluate(() => {
    const tolerance = 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    return Array.from(document.body.querySelectorAll('*'))
      .filter((el) => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (style.position !== 'fixed') return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) return false;
        return (
          rect.left < -tolerance ||
          rect.right > width + tolerance ||
          rect.top < -tolerance ||
          rect.bottom > height + tolerance
        );
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const label =
          el.getAttribute('aria-label') ||
          el.getAttribute('role') ||
          el.textContent?.trim().slice(0, 40) ||
          el.tagName.toLowerCase();
        return `${label}: left=${Math.round(rect.left)} right=${Math.round(rect.right)} viewport=${width}`;
      });
  });
  expect(offenders, `Fixed-position elements outside viewport:\n${offenders.join('\n')}`).toEqual(
    []
  );
}

// --- Tests -------------------------------------------------------------------

for (const [label, viewport] of [
  ['mobile', { width: 375, height: 667 }],
  ['desktop', { width: 1280, height: 800 }],
] as const) {
  test.describe(`Comment navigation — ${label}`, () => {
    test.use({ viewport, isMobile: label === 'mobile', hasTouch: label === 'mobile' });

    test('header surfaces the unresolved comment count', async ({ page }) => {
      await setupMocks(page);
      await openChat(page);
      await screenshot(page, `comments-01-header-chip-${label}`);
      await expect(page.getByRole('button', { name: /unresolved comment/i }).first()).toBeVisible();
      await assertNoOverflow(page);
    });

    test('expanded action row shows the Comments button', async ({ page }) => {
      await setupMocks(page);
      await openChat(page);
      await expandHeader(page);
      await screenshot(page, `comments-02-action-row-${label}`);
      await expect(page.getByRole('button', { name: /^Comments/ }).first()).toBeVisible();
      await assertNoOverflow(page);
    });

    test('comments drawer triages by bucket', async ({ page }) => {
      await setupMocks(page);
      await openChat(page);
      await openCommentsDrawer(page);
      await assertFixedElementsInsideViewport(page);
      await screenshot(page, `comments-03-drawer-needs-you-${label}`);
      await assertNoOverflow(page);
      if (label === 'mobile') {
        await assertNoClippedOverflow(page);
      }
    });

    test('drawer All filter shows every bucket', async ({ page }) => {
      await setupMocks(page);
      await openChat(page);
      await openCommentsDrawer(page);
      const drawer = page.getByRole('dialog', { name: 'Session comments' });
      const allFilter = drawer.getByRole('button', { name: /^All/ });
      await allFilter.click();
      await expect(allFilter).toHaveAttribute('aria-pressed', 'true');
      await expect(drawer.locator('[data-comment-thread-id]').first()).toBeVisible();
      await waitForUiSettled(page);
      await assertFixedElementsInsideViewport(page);
      await screenshot(page, `comments-04-drawer-all-${label}`);
      await assertNoOverflow(page);
    });

    test('a drawer row expands into the real thread', async ({ page }) => {
      await setupMocks(page);
      await openChat(page);
      await openCommentsDrawer(page);
      const drawer = page.getByRole('dialog', { name: 'Session comments' });
      const allFilter = drawer.getByRole('button', { name: /^All/ });
      await allFilter.click();
      await expect(allFilter).toHaveAttribute('aria-pressed', 'true');
      await drawer.locator('[data-comment-thread-id="ct-1"]').click();
      await expect(page.getByRole('button', { name: 'Show in conversation' })).toBeVisible();
      await waitForUiSettled(page);
      await assertFixedElementsInsideViewport(page);
      await screenshot(page, `comments-05-drawer-thread-expanded-${label}`);
      await assertNoOverflow(page);
    });

    test('resolved filter shows what is already handled', async ({ page }) => {
      await setupMocks(page);
      await openChat(page);
      await openCommentsDrawer(page);
      const drawer = page.getByRole('dialog', { name: 'Session comments' });
      const resolvedFilter = drawer.getByRole('button', { name: /^Resolved/ });
      await resolvedFilter.click();
      await expect(resolvedFilter).toHaveAttribute('aria-pressed', 'true');
      await expect(drawer.locator('[data-comment-bucket="resolved"]').first()).toBeVisible();
      await waitForUiSettled(page);
      await screenshot(page, `comments-06-drawer-resolved-${label}`);
      await assertNoOverflow(page);
    });

    test('timeline interleaves comments with messages and activity', async ({ page }) => {
      await setupMocks(page);
      await openChat(page);
      await expandHeader(page);
      await page
        .getByRole('button', { name: /^Timeline$/ })
        .first()
        .click();
      await page.getByRole('dialog', { name: 'Session timeline' }).waitFor({ timeout: 10_000 });
      await expect(page.locator('[data-timeline-comment-id]').first()).toBeVisible();
      await waitForUiSettled(page);
      await screenshot(page, `comments-07-timeline-${label}`);
      await assertNoOverflow(page);
    });

    test('project comments page groups every thread in the project', async ({ page }) => {
      await setupMocks(page);
      await page.goto(`/projects/${PROJECT_ID}/comments`);
      await page.getByRole('heading', { name: 'Comments', level: 1 }).waitFor({ timeout: 15_000 });
      await expect(page.locator('[data-comment-thread-id]').first()).toBeVisible();
      await waitForUiSettled(page);
      await screenshot(page, `comments-08-project-page-${label}`);
      await assertNoOverflow(page);
    });

    test('project comments page filtered to what needs you', async ({ page }) => {
      await setupMocks(page);
      await page.goto(`/projects/${PROJECT_ID}/comments`);
      await page.getByRole('heading', { name: 'Comments', level: 1 }).waitFor({ timeout: 15_000 });
      await expect(page.locator('[data-comment-thread-id]').first()).toBeVisible();
      const needsYouFilter = page.getByRole('button', { name: /^Needs you/ });
      await needsYouFilter.click();
      await expect(needsYouFilter).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('[data-comment-bucket="needs_you"]').first()).toBeVisible();
      await waitForUiSettled(page);
      await screenshot(page, `comments-09-project-needs-you-${label}`);
      await assertNoOverflow(page);
    });

    test('project comments opens a library-file comment in the file preview', async ({ page }) => {
      await setupMocks(page);
      await page.goto(`/projects/${PROJECT_ID}/comments`);
      await page.getByRole('heading', { name: 'Comments', level: 1 }).waitFor({ timeout: 15_000 });

      await page
        .getByRole('button', {
          name: /This section needs to say which channel the notification goes out on/,
        })
        .click();

      await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/library\\?preview=file-1`));
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'comment-navigation-design.md' })
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Comment navigation design' })).toBeVisible();
      await waitForUiSettled(page);
      await screenshot(page, `comments-13-project-to-library-preview-${label}`);
      await assertNoOverflow(page);
    });

    test('project comments opens and reveals a chat message comment', async ({ page }) => {
      await setupMocks(page);
      await page.goto(`/projects/${PROJECT_ID}/comments`);
      await page.getByRole('heading', { name: 'Comments', level: 1 }).waitFor({ timeout: 15_000 });

      await page
        .getByRole('button', {
          name: /The project-wide endpoint makes this drawer viable for large projects/,
        })
        .click();

      await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`));
      await expect(page).not.toHaveURL(/commentMessage=/);
      const highlighted = page.locator('.sam-message-highlight');
      await expect(highlighted).toContainText(
        'The project-level page now reads the project-wide comments endpoint once'
      );
      await expect(highlighted).toBeInViewport();
      await waitForUiSettled(page);
      await screenshot(page, `comments-14-project-to-chat-message-${label}`);
      await assertNoOverflow(page);
    });

    test('project comments empty state', async ({ page }) => {
      await setupMocks(page);
      await page.route(`**/api/projects/${PROJECT_ID}/comments*`, (route) =>
        route.fulfill({
          json: {
            messageThreads: [],
            fileThreads: [],
            sessions: [],
            files: [],
            hasMore: false,
            totalCount: 0,
          },
        })
      );
      await page.goto(`/projects/${PROJECT_ID}/comments`);
      await page.getByText('No comments in this project yet').waitFor({ timeout: 15_000 });
      await screenshot(page, `comments-10-project-empty-${label}`);
      await assertNoOverflow(page);
    });

    /**
     * A capped page must say so. Without this the reader concludes there is
     * nothing else outstanding (rule 65), which is the failure mode the
     * disclosure exists to prevent.
     */
    test('project comments page discloses a truncated page', async ({ page }) => {
      await setupMocks(page);
      await page.route(`**/api/projects/${PROJECT_ID}/comments*`, (route) =>
        route.fulfill({ json: { ...PROJECT_COMMENTS_RESPONSE, hasMore: true, totalCount: 137 } })
      );
      await page.goto(`/projects/${PROJECT_ID}/comments`);
      await page.getByRole('heading', { name: 'Comments', level: 1 }).waitFor({ timeout: 15_000 });

      const disclosure = page.getByText(/most recently active of 137 comments/);
      await expect(disclosure).toBeVisible();
      // The disclosure must be near the filters, before the bucket list, so a
      // reader who only checks "Needs you" still sees that this is a capped page.
      await expect(disclosure).toBeInViewport();
      await waitForUiSettled(page);
      await screenshot(page, `comments-12-project-truncated-${label}`);
      await assertNoOverflow(page);
    });
  });
}

test.describe('Comment navigation — nav placement', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('Comments sits between Chat and Files in the project nav', async ({ page }) => {
    await setupMocks(page);
    await page.goto(`/projects/${PROJECT_ID}/comments`);
    await page.getByRole('heading', { name: 'Comments', level: 1 }).waitFor({ timeout: 15_000 });
    await expect(page.getByRole('link', { name: 'Comments' }).first()).toBeVisible();
    await waitForUiSettled(page);

    const navLabels = await page
      .locator('nav a[href^="/projects/"], aside a[href^="/projects/"]')
      .allInnerTexts();
    const flattened = navLabels.map((t) => t.trim()).filter(Boolean);
    const chat = flattened.indexOf('Chat');
    const comments = flattened.indexOf('Comments');
    const files = flattened.indexOf('Files');

    expect(chat).toBeGreaterThanOrEqual(0);
    expect(comments).toBe(chat + 1);
    expect(files).toBe(comments + 1);

    await screenshot(page, 'comments-11-nav-placement-desktop');
  });
});
