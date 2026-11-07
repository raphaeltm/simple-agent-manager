import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot } from './audit-helpers';

/**
 * Visual + behavioural audit for the attention-first project chat list: Needs attention,
 * Awake, Sleeping, then a folded History. Both production cases that motivated it are in
 * the data — an awake chat quiet for six hours, and a sleeping chat whose wake failed —
 * alongside long titles, markup in titles and 40 finished chats.
 */

const PROJECT_ID = 'proj-sections-audit';
const USER = { id: 'user-sections-audit', name: 'Audit User', email: 'audit@example.com' };
const NOW = Date.now();
const HOUR = 3_600_000;

function chatSession(
  id: string,
  topic: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    workspaceId: `ws-${id}`,
    taskId: null,
    topic,
    status: 'active',
    messageCount: 6,
    startedAt: NOW - 8 * HOUR,
    endedAt: null,
    createdAt: NOW - 8 * HOUR,
    lastMessageAt: NOW - 60_000,
    isIdle: false,
    agentCompletedAt: null,
    agentSessionId: null,
    attention: null,
    ...overrides,
  };
}

function marker(kind: 'needs_input' | 'wake_failed', reason: string) {
  return {
    markerId: `marker-${kind}`,
    kind,
    createdAt: NOW - HOUR,
    expiresAt: null,
    reason,
    options: [],
  };
}

const WAKE_FAILED = chatSession('sess-wake-failed', 'Restore preview environment', {
  status: 'sleeping',
  lastMessageAt: NOW - 30 * HOUR,
  attention: marker('wake_failed', 'provider_limit_blocked'),
});
const NEEDS_INPUT = chatSession('sess-needs-input', 'Approve the database migration plan', {
  lastMessageAt: NOW - 20 * 60_000,
  attention: marker('needs_input', 'Which migration should run first?'),
});
const WORKING = chatSession('sess-working', 'Fix the payouts webhook retry');
const QUIET_AWAKE = chatSession('sess-quiet-awake', 'UI sandbox with a dev server', {
  lastMessageAt: NOW - 6 * HOUR,
  isIdle: true,
  agentCompletedAt: NOW - 6 * HOUR,
});
const LONG_TITLE = chatSession(
  'sess-long-title',
  'A chat whose title is deliberately very long so the section list has to wrap or truncate it gracefully without pushing anything off screen — ünïcödé ✓ <script>alert(1)</script> https://example.com/a/very/long/path/that/should/not/overflow',
  { lastMessageAt: NOW - 2 * HOUR }
);
const SLEEPING = chatSession('sess-sleeping', 'Ledger reconciliation follow-up', {
  status: 'sleeping',
  lastMessageAt: NOW - 3 * HOUR,
});
const HISTORY = Array.from({ length: 40 }, (_, n) =>
  chatSession(`sess-history-${n}`, `Finished chat ${n + 1}: investigate item #${2_000 + n}`, {
    status: 'stopped',
    endedAt: NOW - (n + 1) * HOUR,
    lastMessageAt: NOW - (n + 1) * HOUR,
  })
);

const ALL_SESSIONS = [
  WORKING,
  ...HISTORY.slice(0, 5),
  NEEDS_INPUT,
  LONG_TITLE,
  SLEEPING,
  QUIET_AWAKE,
  ...HISTORY.slice(5),
  WAKE_FAILED,
];

async function setupApi(page: Page, sessions: Record<string, unknown>[]): Promise<string[]> {
  const listIncludes: string[] = [];
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

    const projectPath = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (!projectPath) return respond({});
    const sub = projectPath[2] ?? '';

    if (sub === '/sessions') {
      listIncludes.push(url.searchParams.get('include') ?? '');
      return respond({ sessions, total: sessions.length, hasMore: false });
    }
    const detail = sub.match(/^\/sessions\/([^/]+)$/);
    if (detail) {
      const session = sessions.find((s) => s.id === detail[1]);
      return respond({ session, messages: [], hasMore: false, state: null });
    }
    if (sub.match(/^\/sessions\/[^/]+\/comments/)) return respond({ comments: [] });
    if (sub === '/tasks') return respond({ tasks: [], nextCursor: null });
    if (sub === '/agent-profiles') return respond({ items: [] });
    if (sub.startsWith('/commands')) return respond({ commands: [] });
    if (sub === '') {
      return respond({
        id: PROJECT_ID,
        name: 'Sections Audit',
        repository: 'user/sections-audit',
        repoProvider: 'github',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-01T00:00:00Z',
      });
    }
    return respond({});
  });
  return listIncludes;
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 768;
}

/** Opens the session list the way a user does on this viewport and returns its scroller. */
async function openSessionList(page: Page) {
  if (isMobile(page)) {
    await page.getByRole('button', { name: /^Open chat list/ }).click();
    return page.getByRole('dialog', { name: 'Chat sessions' }).getByRole('navigation', {
      name: 'Chat sessions',
    });
  }
  return page.getByRole('navigation', { name: 'Chat sessions' });
}

function section(list: ReturnType<Page['getByRole']>, id: string) {
  return list.locator(`section[aria-labelledby="session-section-${id}"]`);
}

test.describe('project chat — attention-first session list', () => {
  test('groups chats by state and keeps finished work folded', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name.startsWith('iPhone') ? 'mobile' : 'desktop';
    const listIncludes = await setupApi(page, ALL_SESSIONS);
    await page.goto(`/projects/${PROJECT_ID}/chat/${WORKING.id}`);

    if (isMobile(page)) {
      // A closed drawer still says how many chats need someone.
      const toggle = page.getByRole('button', { name: 'Open chat list, 2 need attention' });
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      await screenshot(page, `project-chat-sections-closed-${viewport}`);
    }

    const list = await openSessionList(page);
    await expect(list.getByText(QUIET_AWAKE.topic as string)).toBeVisible({ timeout: 15_000 });

    // Every list read asks for live sessions beyond the newest page.
    expect(listIncludes.length).toBeGreaterThan(0);
    expect(new Set(listIncludes)).toEqual(new Set(['live']));

    const order = await list
      .locator('section')
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-labelledby')));
    expect(order).toEqual([
      'session-section-attention',
      'session-section-awake',
      'session-section-sleeping',
      'session-section-history',
    ]);

    // Attention first, newest message first: the old wake failure still makes the top.
    const attentionRows = section(list, 'attention');
    await expect(attentionRows.getByText(NEEDS_INPUT.topic as string)).toBeVisible();
    await expect(attentionRows.getByText(WAKE_FAILED.topic as string)).toBeVisible();
    // The six-hour-quiet awake chat is in view without expanding anything.
    await expect(section(list, 'awake').getByText(QUIET_AWAKE.topic as string)).toBeVisible();
    await expect(section(list, 'sleeping').getByText(SLEEPING.topic as string)).toBeVisible();

    const history = list.getByRole('button', { name: /^History/ });
    await expect(history).toHaveAttribute('aria-expanded', 'false');
    await expect(history).toContainText('40');
    await expect(list.getByText('Finished chat 1:', { exact: false })).toHaveCount(0);

    await assertNoOverflow(page);
    await screenshot(page, `project-chat-sections-default-${viewport}`);

    await history.click();
    await expect(history).toHaveAttribute('aria-expanded', 'true');
    await list.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(list.getByText('Finished chat 40:', { exact: false })).toBeInViewport();
    await assertNoOverflow(page);
    await screenshot(page, `project-chat-sections-history-open-${viewport}`);
  });

  test('search opens every section and finds folded chats', async ({ page }, testInfo) => {
    const viewport = testInfo.project.name.startsWith('iPhone') ? 'mobile' : 'desktop';
    await setupApi(page, ALL_SESSIONS);
    await page.goto(`/projects/${PROJECT_ID}/chat/${WORKING.id}`);

    const list = await openSessionList(page);
    await expect(list.getByText(QUIET_AWAKE.topic as string)).toBeVisible({ timeout: 15_000 });
    const container = isMobile(page) ? page.getByRole('dialog', { name: 'Chat sessions' }) : page;
    await container.getByPlaceholder('Search chats...').fill('item #2039');

    await expect(list.getByText('Finished chat 40:', { exact: false })).toBeVisible();
    await expect(list.getByRole('button', { name: /^History/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    await expect(list.getByText(QUIET_AWAKE.topic as string)).toHaveCount(0);
    await assertNoOverflow(page);
    await screenshot(page, `project-chat-sections-search-${viewport}`);
  });

  test('a list with only finished chats shows a folded History and no badge', async ({
    page,
  }, testInfo) => {
    const viewport = testInfo.project.name.startsWith('iPhone') ? 'mobile' : 'desktop';
    const onlyHistory = HISTORY.slice(0, 3);
    await setupApi(page, onlyHistory);
    await page.goto(`/projects/${PROJECT_ID}/chat/${onlyHistory[0]!.id}`);

    if (isMobile(page)) {
      await expect(page.getByRole('button', { name: 'Open chat list' })).toBeVisible({
        timeout: 15_000,
      });
    }
    const list = await openSessionList(page);
    const history = list.getByRole('button', { name: /^History/ });
    await expect(history).toBeVisible({ timeout: 15_000 });
    await expect(list.locator('section')).toHaveCount(1);
    await assertNoOverflow(page);
    await screenshot(page, `project-chat-sections-only-history-${viewport}`);
  });
});
