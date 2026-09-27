import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot } from './audit-helpers';

/**
 * Visual + behavioural audit for instant project chat switching.
 *
 * The API mock pages transcripts the way the real session endpoint does — no
 * cursor returns the newest `limit` rows, `before` pages older, `after` drains
 * forward — so a real browser exercises newest-first loading, scroll-up paging,
 * and switching back to a cached chat whose background refresh is deliberately
 * slow. Screenshots taken while that refresh is still pending prove the switch
 * did not wait for the network.
 */

const PROJECT_ID = 'proj-switch-audit';
const USER = { id: 'user-switch-audit', name: 'Audit User', email: 'audit@example.com' };
// Relative to the real clock: the session list files chats idle for hours under a
// collapsed "Older" group, and these must read as recent.
const NOW = Date.now();
const REFRESH_DELAY_MS = 4_000;
const LONG_URL =
  'https://example.com/a/very/long/path/that/should/wrap/rather/than/overflow?query=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&more=bbbbbbbbbbbbbbbbbbbbbbbb';

interface Row {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolMetadata: Record<string, unknown> | null;
  createdAt: number;
  sequence: number;
}

function transcript(sessionId: string, length: number, content: (n: number) => string): Row[] {
  return Array.from({ length }, (_, n) => ({
    id: `${sessionId}-m${n}`,
    sessionId,
    role: n % 2 === 0 ? 'user' : 'assistant',
    content: content(n),
    toolMetadata: null,
    createdAt: NOW - (length - n) * 60_000,
    sequence: n + 1,
  }));
}

function chatSession(id: string, topic: string, messageCount: number, status = 'active') {
  return {
    id,
    workspaceId: null,
    taskId: null,
    topic,
    status,
    messageCount,
    startedAt: NOW - 86_400_000,
    endedAt: status === 'active' ? null : NOW - 3_600_000,
    createdAt: NOW - 86_400_000,
    lastMessageAt: NOW - 60_000,
    isIdle: false,
    agentCompletedAt: null,
    agentSessionId: null,
  };
}

const LONG = chatSession('sess-long', 'Refactor the transcript pager across 1,200 messages', 1_200);
const EMPTY = chatSession('sess-empty', 'Brand new chat', 0);
const WORDY = chatSession(
  'sess-wordy',
  'A chat whose title is deliberately very long so the header and the session list both have to wrap or truncate it gracefully without pushing anything off screen — ünïcödé ✓ <script>alert(1)</script>',
  3,
  'stopped'
);
const FILLER = Array.from({ length: 32 }, (_, n) =>
  chatSession(
    `sess-filler-${n}`,
    `Filler chat ${n + 1}: investigate item #${1_000 + n}`,
    12,
    'stopped'
  )
);
// An agent run: every page of 500 rows is one short reply followed by an unbroken
// streak of tool calls, which the view folds into a single card — a whole page
// renders as two rows.
const TOOLS = chatSession('sess-tools', 'Agent run with long unbroken tool-call streaks', 1_500);
const SESSIONS = [LONG, TOOLS, EMPTY, WORDY, ...FILLER];

function toolRun(sessionId: string, length: number): Row[] {
  return Array.from({ length }, (_, n) => ({
    id: `${sessionId}-m${n}`,
    sessionId,
    role: n % 500 === 0 ? 'assistant' : 'tool',
    content: n % 500 === 0 ? `Tool run checkpoint ${n}: the next batch is running.` : '(tool call)',
    toolMetadata:
      n % 500 === 0
        ? null
        : {
            toolCallId: `tc-${sessionId}-${n}`,
            title: `Run migration step ${n}`,
            kind: 'execute',
            status: 'completed',
            contentSize: 64,
          },
    createdAt: NOW - (length - n) * 1_000,
    sequence: n + 1,
  }));
}

const TRANSCRIPTS: Record<string, Row[]> = {
  [LONG.id]: transcript(LONG.id, 1_200, (n) =>
    n % 2 === 0
      ? `Long chat message ${n}: please look at the next part of the pager.`
      : `Long chat message ${n}: done — the reply for step ${n} is written, reviewed, and pushed. ${'Detail line. '.repeat(3)}`
  ),
  [TOOLS.id]: toolRun(TOOLS.id, 1_500),
  [EMPTY.id]: [],
  [WORDY.id]: transcript(WORDY.id, 3, (n) =>
    n === 1
      ? `${'A very long paragraph that keeps going to test wrapping. '.repeat(10)} Reference: ${LONG_URL} Supercalifragilisticexpialidocious${'x'.repeat(80)}`
      : `Wordy chat message ${n} with emoji 🚀 and <b>not bold</b> &amp; entities`
  ),
  ...Object.fromEntries(
    FILLER.map((session) => [
      session.id,
      transcript(session.id, 12, (n) => `${session.topic} — message ${n}`),
    ])
  ),
};

const OLDEST_OF_NEWEST_PAGE = 1_200 - 500; // message 700 is the first row the cold open reads

// A comment on a message older than the newest page, which a cold open does not load.
const UNLOADED_ANCHOR_COMMENT = {
  id: 'comment-on-early-message',
  sessionId: LONG.id,
  anchor: { kind: 'message', messageId: `${LONG.id}-m10`, quote: '' },
  author: { id: USER.id, kind: 'human', name: USER.name },
  body: 'Worth revisiting this early decision before the refactor lands.',
  createdAt: NOW - 30_000,
  updatedAt: NOW - 30_000,
  status: 'open',
  replies: [],
};

interface DetailRequest {
  sessionId: string;
  limit: string | null;
  before: string | null;
  after: string | null;
}

function cursorIndex(rows: Row[], cursor: string): number {
  return rows.findIndex((row) => cursor.endsWith(`"${row.id}"]`));
}

/** Serves one session-detail request the way the API pages a transcript. */
function detailPage(sessionId: string, params: URLSearchParams) {
  const rows = TRANSCRIPTS[sessionId] ?? [];
  const session = SESSIONS.find((s) => s.id === sessionId);
  const after = params.get('after');
  const before = params.get('before');
  const limit = Number(params.get('limit') ?? 500);
  let messages: Row[];
  let hasMore: boolean;
  if (after) {
    const start = cursorIndex(rows, after) + 1;
    messages = rows.slice(start, start + 5_000);
    hasMore = start + 5_000 < rows.length;
  } else {
    const end = before ? cursorIndex(rows, before) : rows.length;
    const start = Math.max(0, end - limit);
    messages = rows.slice(start, end);
    hasMore = start > 0;
  }
  return { session, messages, hasMore, state: null };
}

async function setupApi(page: Page, detailRequests: DetailRequest[]) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, USER.id);

  await page.routeWebSocket(/\/api\/projects\/[^/]+\/sessions\/ws/, (ws) => {
    ws.onMessage((raw) => {
      try {
        if (JSON.parse(String(raw))?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* keepalive frames that are not JSON are ignored */
      }
    });
  });

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.startsWith('/api/auth/')) return respond({ user: USER });
    if (path.startsWith('/api/notifications')) {
      return respond({ notifications: [], unreadCount: 0, nextCursor: null });
    }
    if (path === '/api/credentials') return respond([{ provider: 'hetzner', status: 'valid' }]);
    if (path === '/api/trial/status') return respond({ available: false });
    if (path === '/api/agents') return respond({ agents: [] });
    if (path === '/api/github/installations') return respond([]);
    if (path === '/api/report-issue/config') return respond({ enabled: true });

    const projectPath = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (!projectPath) return respond({});
    const sub = projectPath[2] ?? '';

    if (sub === '/sessions') return respond({ sessions: SESSIONS, total: SESSIONS.length });
    const detail = sub.match(/^\/sessions\/([^/]+)$/);
    if (detail) {
      const sessionId = detail[1]!;
      detailRequests.push({
        sessionId,
        limit: url.searchParams.get('limit'),
        before: url.searchParams.get('before'),
        after: url.searchParams.get('after'),
      });
      // A background refresh of a cached chat is deliberately slow: the switch
      // must render from cache without waiting for it.
      if (url.searchParams.get('after')) await new Promise((r) => setTimeout(r, REFRESH_DELAY_MS));
      return respond(detailPage(sessionId, url.searchParams));
    }
    const comments = sub.match(/^\/sessions\/([^/]+)\/comments/);
    if (comments) {
      return respond({ comments: comments[1] === LONG.id ? [UNLOADED_ANCHOR_COMMENT] : [] });
    }
    if (sub === '/tasks') return respond({ tasks: [], nextCursor: null });
    if (sub === '/agent-profiles') return respond({ items: [] });
    if (sub.startsWith('/commands')) return respond({ commands: [] });
    if (sub === '') {
      return respond({
        id: PROJECT_ID,
        name: 'Switching Audit',
        repository: 'user/switching-audit',
        repoProvider: 'github',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      });
    }
    return respond({});
  });
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 768;
}

/** Picks a chat the way a user does on this viewport: the sidebar, or the chat-list drawer. */
async function selectChat(page: Page, topic: string) {
  if (isMobile(page)) {
    await page.getByRole('button', { name: 'Open chat list' }).click();
    const drawer = page.getByRole('dialog', { name: 'Chat sessions' });
    await drawer.getByText(topic, { exact: false }).first().click();
    await expect(drawer).toHaveCount(0);
  } else {
    await page
      .getByRole('navigation', { name: 'Chat sessions' })
      .getByText(topic, { exact: false })
      .first()
      .click();
  }
}

const conversation = (page: Page) => page.getByRole('log', { name: 'Conversation' });

/** The lowest "Long chat message N" number currently rendered in the conversation. */
async function oldestRenderedMessage(page: Page): Promise<number> {
  const text = (await conversation(page).textContent()) ?? '';
  const numbers = [...text.matchAll(/Long chat message (\d+):/g)].map((match) => Number(match[1]));
  return numbers.length > 0 ? Math.min(...numbers) : Number.POSITIVE_INFINITY;
}

test.describe('project chat — instant switching audit', () => {
  test('cold open reads the newest page and pages older history in on scroll-up', async ({
    page,
  }, testInfo) => {
    const viewport = testInfo.project.name.startsWith('iPhone') ? 'mobile' : 'desktop';
    const requests: DetailRequest[] = [];
    await setupApi(page, requests);

    await page.goto(`/projects/${PROJECT_ID}/chat/${LONG.id}`);
    await expect(conversation(page).getByText('Long chat message 1199:')).toBeVisible({
      timeout: 15_000,
    });

    const coldOpen = requests.filter((r) => r.sessionId === LONG.id);
    expect(coldOpen[0]).toEqual({ sessionId: LONG.id, limit: '500', before: null, after: null });
    await assertNoOverflow(page);
    await screenshot(page, `project-chat-switching-long-newest-${viewport}`);

    // Nothing older loads until the reader scrolls.
    await page.waitForTimeout(1_000);
    expect(requests.filter((r) => r.sessionId === LONG.id && r.before)).toHaveLength(0);

    // The reader scrolls up to the top of what is loaded: the next older page is
    // requested from the oldest loaded row, and its rows become reachable.
    const scroller = page.locator('[data-sam-conversation-scroller="true"]');
    await scroller.hover();
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, -20_000);
          return requests.filter((r) => r.sessionId === LONG.id && r.before).length;
        },
        { timeout: 15_000 }
      )
      .toBeGreaterThan(0);
    expect(requests.find((r) => r.before)?.before).toContain(
      `"${LONG.id}-m${OLDEST_OF_NEWEST_PAGE}"`
    );
    // The top of the list now shows history older than anything the cold open read.
    await expect
      .poll(
        async () => {
          await page.mouse.wheel(0, -20_000);
          return oldestRenderedMessage(page);
        },
        { timeout: 15_000 }
      )
      .toBeLessThan(OLDEST_OF_NEWEST_PAGE);
    await assertNoOverflow(page);
    await screenshot(page, `project-chat-switching-long-older-paged-in-${viewport}`);
  });

  test('a chat whose newest page folds into a few rows opens on that page alone', async ({
    page,
  }, testInfo) => {
    const viewport = testInfo.project.name.startsWith('iPhone') ? 'mobile' : 'desktop';
    const requests: DetailRequest[] = [];
    await setupApi(page, requests);

    await page.goto(`/projects/${PROJECT_ID}/chat/${TOOLS.id}`);
    await expect(conversation(page).getByText('Tool run checkpoint 1000:')).toBeVisible({
      timeout: 15_000,
    });
    // The whole page fits on screen, so Virtuoso reports the top as reached at
    // once. Give its debounced callback ample time: nothing older may load until
    // the reader asks for it.
    await page.waitForTimeout(1_500);
    expect(requests.filter((r) => r.sessionId === TOOLS.id)).toEqual([
      { sessionId: TOOLS.id, limit: '500', before: null, after: null },
    ]);

    await page.getByRole('button', { name: 'Load earlier messages' }).click();
    await expect(conversation(page).getByText('Tool run checkpoint 500:')).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(requests.filter((r) => r.sessionId === TOOLS.id && r.before)).toHaveLength(1);
    await assertNoOverflow(page);
    await screenshot(page, `project-chat-switching-tool-heavy-${viewport}`);
  });

  test('a comment on history not loaded yet does not guess who wrote the message', async ({
    page,
  }, testInfo) => {
    const viewport = testInfo.project.name.startsWith('iPhone') ? 'mobile' : 'desktop';
    await setupApi(page, []);

    await page.goto(`/projects/${PROJECT_ID}/chat/${LONG.id}`);
    await expect(conversation(page).getByText('Long chat message 1199:')).toBeVisible({
      timeout: 15_000,
    });
    await page
      .getByRole('button', { name: /1 unresolved comment/i })
      .first()
      .click();
    await expect(
      page.getByText('Worth revisiting this early decision', { exact: false }).first()
    ).toBeVisible();
    if (isMobile(page)) {
      // The drawer lists the thread; its message is not loaded, so the row names no author.
      await expect(page.getByText('on a message').first()).toBeVisible();
      await expect(page.getByText("on the agent's reply")).toHaveCount(0);
    } else {
      // Desktop docks the thread beside the conversation instead of listing it.
      await expect(page.getByText('on a message')).toHaveCount(0);
    }
    await assertNoOverflow(page);
    await screenshot(page, `project-chat-switching-comment-unloaded-anchor-${viewport}`);

    // Following the comment pages back until its message is loaded, and lands on it.
    if (isMobile(page)) {
      await page
        .getByText('Worth revisiting this early decision', { exact: false })
        .first()
        .click();
      await page.getByRole('button', { name: /show in conversation/i }).click();
    } else {
      await page
        .getByRole('button', { name: `Show message ${LONG.id}-m10 in conversation` })
        .click();
    }
    await expect(conversation(page).getByText('Long chat message 10:')).toBeInViewport({
      timeout: 15_000,
    });
    await assertNoOverflow(page);
    await screenshot(page, `project-chat-switching-comment-jump-${viewport}`);
  });

  test('switching renders the chosen chat at once and never the previous one', async ({
    page,
  }, testInfo) => {
    const viewport = testInfo.project.name.startsWith('iPhone') ? 'mobile' : 'desktop';
    const requests: DetailRequest[] = [];
    await setupApi(page, requests);

    await page.goto(`/projects/${PROJECT_ID}/chat/${LONG.id}`);
    await expect(conversation(page).getByText('Long chat message 1199:')).toBeVisible({
      timeout: 15_000,
    });

    // Many sessions in the list, long titles included.
    if (isMobile(page)) {
      await page.getByRole('button', { name: 'Open chat list' }).click();
      const drawer = page.getByRole('dialog', { name: 'Chat sessions' });
      await expect(drawer.getByText('Filler chat 32:', { exact: false })).toBeAttached();
      await assertNoOverflow(page);
      await screenshot(page, `project-chat-switching-session-list-${viewport}`);
      await page.keyboard.press('Escape');
      await expect(drawer).toHaveCount(0);
    } else {
      await screenshot(page, `project-chat-switching-session-list-${viewport}`);
    }

    // An empty chat: no messages, and nothing from the long chat.
    await selectChat(page, EMPTY.topic);
    await expect(page.getByText('Waiting for messages...')).toBeVisible();
    await expect(page.getByText('Long chat message 1199:')).toHaveCount(0);
    await assertNoOverflow(page);
    await screenshot(page, `project-chat-switching-empty-${viewport}`);

    // Long text, special characters, a stopped session.
    await selectChat(page, 'A chat whose title is deliberately very long');
    await expect(
      conversation(page).getByText('Wordy chat message 2', { exact: false })
    ).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, `project-chat-switching-wordy-${viewport}`);

    // Back to the long chat, which is cached: it must paint before its (slow)
    // background refresh answers.
    const refreshesBefore = requests.filter((r) => r.sessionId === LONG.id && r.after).length;
    const switchedAt = Date.now();
    await selectChat(page, LONG.topic);
    await expect(conversation(page).getByText('Long chat message 1199:')).toBeVisible();
    expect(Date.now() - switchedAt).toBeLessThan(REFRESH_DELAY_MS);
    await expect(page.getByText('Wordy chat message 2', { exact: false })).toHaveCount(0);
    await expect
      .poll(() => requests.filter((r) => r.sessionId === LONG.id && r.after).length)
      .toBeGreaterThan(refreshesBefore);
    await assertNoOverflow(page);
    // Taken while the refresh is still outstanding.
    await screenshot(page, `project-chat-switching-cached-return-${viewport}`);
  });
});
