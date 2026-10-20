import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

/**
 * Visual audit for how a chat looks to each kind of viewer once sessions can be shared
 * (idea 01M59MYE4GY91BWTE8TZF1ZB5D): the owner, a teammate it was shared with, and any other
 * project member. Covers the composer area, the shared-session notice, sender attribution on
 * transcript rows, the session rail's Share/Files tools, and the Files/Git panels a teammate
 * now gets. The share dialog, comment mentions and reader comment hint are audited in
 * shared-session-collaboration-audit.spec.ts.
 */

const PROJECT_ID = 'proj-shared-viewer';
const SESSION_ID = 'session-shared-viewer';
const NOW = Date.now();
const VIEWER_ID = 'user-viewer';

const LONG_OWNER =
  'Prakash Raman-Venkataraghavan (Platform Engineering) <script>alert(1)</script> 🚀 with a deliberately long display name';
const LONG_GRANTEE =
  'Ana Lucía Ruiz-Okafor, Staff Engineer & on-call lead for checkout payments 💳';

const MOCK_USER = makeMockUser({
  email: 'viewer@example.com',
  name: 'Viewer Person',
  role: 'user',
  sessionId: 'auth-session-shared-viewer',
  userId: VIEWER_ID,
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Shared Session Viewer Audit',
  repository: 'acme/checkout',
  repoProvider: 'github',
  defaultBranch: 'main',
  userId: 'owner-1',
  githubInstallationId: 'inst-shared-viewer',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  defaultWorkspaceProfile: 'full',
  defaultDevcontainerConfigName: '',
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-10-19T00:00:00Z',
  updatedAt: '2026-10-19T00:00:00Z',
};

type Viewer = 'owner' | 'grantee' | 'reader';

function person(id: string, name: string) {
  return { id, name, avatarUrl: null };
}

/** Minutes left on each grant: the viewer's own (first) ends in 23. */
const MINUTES_LEFT = [23, 4, 58];

function accessSummary(viewer: Viewer, grantCount: number) {
  const grants = Array.from({ length: grantCount }, (_, index) => ({
    id: `grant-${index}`,
    sessionId: SESSION_ID,
    grantee:
      index === 0 && viewer === 'grantee'
        ? person(VIEWER_ID, 'Viewer Person')
        : person(`member-${index}`, index === 1 ? LONG_GRANTEE : `Teammate ${index}`),
    grantedBy: person('owner-1', LONG_OWNER),
    parentGrantId: null,
    createdAt: NOW - 60_000 * (index + 1),
    expiresAt: NOW + 60_000 * (MINUTES_LEFT[index] ?? 30),
    durationMinutes: 60,
  }));
  return {
    sessionId: SESSION_ID,
    viewerAccess: viewer,
    owner: person(viewer === 'owner' ? VIEWER_ID : 'owner-1', LONG_OWNER),
    grants,
    serverTime: NOW,
  };
}

function makeSession(viewer: Viewer, overrides: Record<string, unknown> = {}) {
  const ownerId = viewer === 'owner' ? VIEWER_ID : 'owner-1';
  return {
    id: SESSION_ID,
    workspaceId: 'ws-shared-viewer',
    taskId: null,
    topic: 'Fix the flaky checkout tests before the Friday release',
    status: 'active',
    messageCount: 7,
    startedAt: NOW - 600_000,
    endedAt: null,
    createdAt: NOW - 700_000,
    lastMessageAt: NOW - 10_000,
    isIdle: true,
    agentCompletedAt: NOW - 20_000,
    isTerminated: false,
    workspaceUrl: null,
    cleanupAt: null,
    agentSessionId: null,
    createdBy: { id: ownerId, name: LONG_OWNER, email: 'prakash@example.com' },
    isMine: viewer === 'owner',
    viewerAccess: viewer,
    access: accessSummary(viewer, 3),
    ...overrides,
  };
}

/** A session whose agent is not idle, so the rail offers its live-workspace tools. */
const LIVE = { isIdle: false, agentCompletedAt: null };

const durable = (metadata: Record<string, unknown>) => ({
  kind: 'durable_prompt_delivery',
  deliveryId: `delivery-${Math.random().toString(36).slice(2)}`,
  ...metadata,
});

const MESSAGES = [
  {
    id: 'msg-owner',
    role: 'user',
    content: 'The checkout tests fail about one run in five. Find out why.',
    toolMetadata: null,
  },
  {
    id: 'msg-agent-1',
    role: 'assistant',
    content: 'The flaky test waits on a fixed 200ms timeout before reading the cart total.',
    toolMetadata: null,
  },
  {
    id: 'msg-grantee',
    role: 'user',
    content:
      'Replace the fixed wait with an explicit wait for the cart total, and run the suite 20 times.',
    toolMetadata: durable({
      source: 'user_followup',
      userId: 'grantee-1',
      senderName: LONG_GRANTEE,
      onBehalfOfUserId: 'owner-1',
      grantId: 'grant-1',
    }),
  },
  {
    id: 'msg-comment',
    role: 'user',
    content:
      'SAM comment directive — Comment ID: thread-1. Feedback: please also cover the empty-cart case.',
    toolMetadata: durable({
      source: 'comment_directive',
      userId: 'owner-1',
      senderName: LONG_OWNER,
      author: { kind: 'human', id: 'reviewer-1', displayName: 'Ben Okafor' },
    }),
  },
  {
    id: 'msg-cancelled',
    role: 'user',
    content: 'Also bump the retry count to five.',
    toolMetadata: durable({
      source: 'user_followup',
      senderName: 'Teammate 2',
      onBehalfOfUserId: 'owner-1',
      deliveryCancelled: 'sender_access_revoked',
    }),
  },
  {
    id: 'msg-expired',
    role: 'user',
    content: 'And open a PR when the suite is green.',
    toolMetadata: durable({
      source: 'user_followup',
      senderName: LONG_GRANTEE,
      onBehalfOfUserId: 'owner-1',
      deliveryCancelled: 'sender_access_expired',
    }),
  },
  {
    id: 'msg-scheduled',
    role: 'user',
    content: 'Re-run the checkout suite now that CI has finished.',
    toolMetadata: durable({
      source: 'scheduled_action',
      scheduleId: 'schedule-1',
      creatorUserId: 'grantee-1',
      userId: 'grantee-1',
      senderName: LONG_GRANTEE,
      onBehalfOfUserId: 'owner-1',
      grantId: 'grant-1',
    }),
  },
  {
    id: 'msg-agent-2',
    role: 'assistant',
    content: 'Done: the explicit wait passes 20 of 20 runs, including the empty cart.',
    toolMetadata: null,
  },
].map((message, index) => ({
  ...message,
  sessionId: SESSION_ID,
  createdAt: NOW - (8 - index) * 30_000,
  sequence: index + 1,
}));

/** The repository folder as the workspace agent lists it: many entries, some long names. */
const FILE_LISTING = {
  path: '.',
  entries: [
    { name: 'src', type: 'dir', size: 0, modifiedAt: '2026-10-19T09:00:00Z' },
    { name: 'tests', type: 'dir', size: 0, modifiedAt: '2026-10-19T09:00:00Z' },
    ...Array.from({ length: 32 }, (_, index) => ({
      name:
        index === 3
          ? `checkout-payment-reconciliation-with-a-deliberately-long-file-name-that-has-no-breaks-${index}.test.ts`
          : `file-${index}.ts`,
      type: 'file',
      size: 1200 + index,
      modifiedAt: '2026-10-19T09:00:00Z',
    })),
  ],
};

const GIT_STATUS = {
  staged: [{ path: 'src/checkout/cart.ts', status: 'M' }],
  unstaged: [{ path: 'tests/checkout/cart.test.ts', status: 'M' }],
  untracked: [{ path: 'tests/checkout/empty-cart.test.ts', status: '??' }],
};

async function setupMocks(page: Page, session: ReturnType<typeof makeSession>) {
  const wide = (page.viewportSize()?.width ?? 0) >= 1024;
  await page.addInitScript(
    ({ userId, labelledRail }) => {
      window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
      // Desktop rail checks read tool labels; phones keep the default compact rail.
      if (labelledRail) window.localStorage.setItem('sam-session-tool-strip-mode', 'labels');
    },
    { userId: VIEWER_ID, labelledRail: wide }
  );
  await page.routeWebSocket(/\/api\/projects\/[^/]+\/sessions\/ws/, (ws) => {
    ws.onMessage((raw) => {
      try {
        if (JSON.parse(String(raw))?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* ignore non-json frames */
      }
    });
  });
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/provider-catalog') || path.startsWith('/api/providers/catalog'))
      return respond(200, { catalogs: [] });
    if (path === '/api/trial/status') return respond(200, { available: false });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/workspaces') return respond(200, []);
    if (path === '/api/projects')
      return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (!projectMatch) return respond(200, {});
    const subPath = projectMatch[2] || '';

    if (subPath === `/sessions/${SESSION_ID}/comments`) return respond(200, { comments: [] });
    if (subPath === `/sessions/${SESSION_ID}/files/list`) return respond(200, FILE_LISTING);
    if (subPath === `/sessions/${SESSION_ID}/files/find`)
      return respond(200, { files: FILE_LISTING.entries.map((entry) => entry.name) });
    if (subPath === `/sessions/${SESSION_ID}/git/status`) return respond(200, GIT_STATUS);
    if (subPath === `/sessions/${SESSION_ID}/access`) return respond(200, session.access);
    if (subPath === '/sessions') {
      return respond(200, { sessions: [session], total: 1, hasMore: false });
    }
    if (subPath === `/sessions/${SESSION_ID}`) {
      return respond(200, { session, messages: MESSAGES, hasMore: false });
    }
    if (subPath.match(/^\/sessions\/[^/]+\/messages/)) return respond(200, MESSAGES);
    if (subPath === '/members') return respond(200, { members: [], invites: [] });
    if (subPath === '/tasks') return respond(200, { tasks: [], nextCursor: null });
    if (subPath === '/agent-profiles') return respond(200, { items: [] });
    if (subPath === '/skills') return respond(200, { items: [] });
    if (subPath.match(/\/commands|\/cached-commands/)) return respond(200, { commands: [] });
    return respond(200, MOCK_PROJECT);
  });
}

/** Scroll the virtualized conversation from the top until `label` is rendered, then assert it. */
async function scrollConversationUntil(page: Page, text: string) {
  const scroller = page.locator('[data-sam-conversation-scroller="true"]').first();
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  for (let step = 0; step < 20; step += 1) {
    if (await page.getByText(text, { exact: false }).count()) return;
    await scroller.evaluate((el) => {
      el.scrollTop += Math.max(120, el.clientHeight * 0.6);
      el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await page.waitForTimeout(150);
  }
}

async function expectAttribution(page: Page, label: string) {
  await scrollConversationUntil(page, label);
  await expect(
    page.getByTestId('user-message-attribution').filter({ hasText: label }).first()
  ).toBeVisible();
}

/** The message renders, and no attribution line sits in the same row. */
async function expectUnlabelled(page: Page, content: string) {
  await scrollConversationUntil(page, content);
  const bubble = page.getByText(content).first();
  await expect(bubble).toBeVisible();
  const row = page.locator('[data-index]').filter({ has: bubble }).first();
  await expect(row.getByTestId('user-message-attribution')).toHaveCount(0);
}

async function openChat(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  await expect(page.getByText(/explicit wait passes 20 of 20 runs/)).toBeVisible({
    timeout: 15_000,
  });
}

function slug(viewer: string, page: Page) {
  const width = page.viewportSize()?.width ?? 0;
  return `shared-session-${viewer}-${width < 768 ? 'mobile' : 'desktop'}`;
}

test.describe('Shared session — what each viewer sees', () => {
  test('a teammate it was shared with: notice, composer, and attributed messages', async ({
    page,
  }) => {
    await setupMocks(page, makeSession('grantee'));
    await openChat(page);

    // The owner's name is long, has HTML and emoji; it must render as text and wrap.
    const notice = page.getByTestId('shared-session-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText(`You're chatting in ${LONG_OWNER}'s session.`);
    // Their own grant's time left, not another person's (4 and 58 minutes).
    await expect(page.getByTestId('shared-session-time-left')).toHaveText(
      /^Your access ends in 23 min \(.+\)\.$/
    );
    await expect(page.getByPlaceholder(/Send a message/)).toBeVisible();
    // A teammate can attach their own files, like the owner.
    await expect(page.getByRole('button', { name: 'Attach files' })).toBeVisible();
    // The notice wraps inside the viewport rather than pushing the composer off-screen.
    const viewport = page.viewportSize()!;
    const noticeBox = (await notice.boundingBox())!;
    expect(noticeBox.x + noticeBox.width).toBeLessThanOrEqual(viewport.width + 1);

    // The conversation is virtualized: scroll each labelled message into the rendered window.
    await expectAttribution(page, `${LONG_GRANTEE} · shared access`);
    await expectAttribution(page, `${LONG_OWNER} sent Ben Okafor's comment to the agent`);
    await expectAttribution(page, 'Teammate 2 · shared access');
    await expect(page.getByText('Not delivered — access was removed')).toBeVisible();
    await scrollConversationUntil(page, 'And open a PR when the suite is green.');
    await expect(page.getByText('Not delivered — access expired')).toBeVisible();
    // A message the teammate scheduled is theirs too, and says it was scheduled.
    await expectAttribution(page, `${LONG_GRANTEE} · shared access · scheduled`);
    // Six user messages, five labelled: the owner's own message carries no label.
    await expectUnlabelled(page, 'The checkout tests fail about one run in five. Find out why.');

    await assertNoOverflow(page);
    await screenshot(page, slug('grantee', page));
  });

  test('a message cancelled after the page cached it shows Not delivered, live and after a reload', async ({
    page,
  }) => {
    // The page loads before the teammate's access runs out: their last message is unlabelled.
    // The server then cancels it and labels the stored row, but this page already has the row,
    // so the label has to come from the access read the change triggers.
    const late = 'And open a PR when the suite is green.';
    const unlabelled = MESSAGES.map((message) =>
      message.id === 'msg-expired'
        ? {
            ...message,
            toolMetadata: durable({
              source: 'user_followup',
              senderName: LONG_GRANTEE,
              onBehalfOfUserId: 'owner-1',
            }),
          }
        : message
    );
    const session = makeSession('owner');
    let cancelled = false;
    const access = () => ({
      ...session.access,
      ...(cancelled
        ? { undelivered: [{ messageId: 'msg-expired', reason: 'sender_access_expired' }] }
        : {}),
    });
    await setupMocks(page, session);
    // Registered after setupMocks, so these answer first.
    const sockets: { send(message: string): void }[] = [];
    await page.routeWebSocket(/\/api\/projects\/[^/]+\/sessions\/ws/, (ws) => {
      sockets.push(ws);
      ws.onMessage((raw) => {
        if (String(raw).includes('"ping"')) ws.send(JSON.stringify({ type: 'pong' }));
      });
    });
    await page.route(new RegExp(`/sessions/${SESSION_ID}/access(\\?.*)?$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(access()),
      })
    );
    await page.route(new RegExp(`/api/projects/[^/]+/sessions/${SESSION_ID}(\\?.*)?$`), (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          session: { ...session, access: access() },
          messages: unlabelled,
          hasMore: false,
        }),
      })
    );

    await openChat(page);
    await scrollConversationUntil(page, late);
    await expect(page.getByText(late).first()).toBeVisible();
    await expect(page.getByText('Not delivered — access expired')).toHaveCount(0);
    await expect.poll(() => sockets.length).toBeGreaterThan(0);

    cancelled = true;
    for (const socket of sockets) {
      socket.send(
        JSON.stringify({
          type: 'session.access.changed',
          payload: { sessionId: SESSION_ID, reason: 'expired' },
        })
      );
    }
    await expectAttribution(page, 'Not delivered — access expired');
    await screenshot(page, `${slug('owner', page)}-cancelled-live`);

    // A reload keeps the cached row as it was; the session read carries the label again.
    await page.reload();
    await expect(page.getByText(/explicit wait passes 20 of 20 runs/)).toBeVisible({
      timeout: 15_000,
    });
    await expectAttribution(page, 'Not delivered — access expired');
    await assertNoOverflow(page);
  });

  test('a teammate whose time runs out: the composer locks and says why', async ({ page }) => {
    // Real time passes in this test: the grant ends 12 s after the mocks are set up.
    test.setTimeout(90_000);
    const expiresAt = Date.now() + 12_000;
    // Answers like the server: its own clock, and an ended grant is gone.
    const accessNow = () => {
      const base = accessSummary('grantee', 3);
      const ended = Date.now() >= expiresAt;
      return {
        ...base,
        viewerAccess: ended ? 'reader' : 'grantee',
        grants: ended
          ? base.grants.slice(1)
          : [{ ...base.grants[0]!, expiresAt }, ...base.grants.slice(1)],
        serverTime: Date.now(),
      };
    };
    await setupMocks(page, makeSession('grantee', { access: accessNow() }));
    await page.route(`**/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/access`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(accessNow()),
      })
    );
    await openChat(page);

    await expect(page.getByTestId('shared-session-time-left')).toHaveText(
      /^Your access ends in under a minute/
    );
    await expect(page.getByPlaceholder(/Send a message/)).toBeVisible();

    // The end time passes with no socket message: the composer locks and says why.
    await expect(page.getByText('Your shared access has ended')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByPlaceholder(/Send a message/)).toHaveCount(0);
    await expect(page.getByTestId('shared-session-notice')).toHaveCount(0);
    // The refetch that follows makes them a reader; the footer still says their access ended.
    await expect
      .poll(() => page.evaluate(() => document.body.innerText.includes('Only ')), {
        timeout: 5_000,
      })
      .toBe(false);
    await expect(page.getByText('Your shared access has ended')).toBeVisible();
    await expect(
      page.getByText(
        `You can still read and comment. Ask ${LONG_OWNER} to share it again to keep chatting.`
      )
    ).toBeVisible();

    await assertNoOverflow(page);
    await screenshot(page, slug('access-ended', page));
  });

  test('any other member: read-only composer that names the owner', async ({ page }) => {
    await setupMocks(page, makeSession('reader'));
    await openChat(page);

    await expect(page.getByText(`Only ${LONG_OWNER} can message this agent`)).toBeVisible();
    await expect(
      page.getByText(
        `You can leave comments on any message, or ask ${LONG_OWNER} to share this chat.`
      )
    ).toBeVisible();
    await expect(page.getByTestId('shared-session-notice')).toHaveCount(0);
    // No message composer for a reader (the comment composer is not open).
    await expect(page.getByPlaceholder(/Send a message/)).toHaveCount(0);

    await assertNoOverflow(page);
    await screenshot(page, slug('reader', page));
  });

  test('the owner: no notice, uploads available, Share shows who has access', async ({ page }) => {
    await setupMocks(page, makeSession('owner'));
    await openChat(page);

    await expect(page.getByTestId('shared-session-notice')).toHaveCount(0);
    await expect(page.getByText(/can message this agent/)).toHaveCount(0);
    await expect(page.getByPlaceholder(/Send a message/)).toBeVisible();

    await assertNoOverflow(page);
    await screenshot(page, slug('owner', page));
  });

  test('the owner’s rail: Share carries the grant count, and Files is there', async ({ page }) => {
    const viewport = page.viewportSize();
    test.skip(!viewport || viewport.width < 1024, 'The labelled tool rail is desktop-only');
    // Files and Git are offered only while the session is live (not idle).
    await setupMocks(page, makeSession('owner', LIVE));
    await openChat(page);

    const share = page.getByRole('button', { name: /Share/ }).first();
    await expect(share).toBeVisible();
    await expect(share).toContainText('3');
    await expect(page.getByRole('button', { name: 'Browse workspace files' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review uncommitted changes' })).toBeVisible();
  });

  test('a grantee gets Files and Git, which read the repository folder', async ({ page }) => {
    await setupMocks(page, makeSession('grantee', LIVE));
    await openChat(page);

    await page.getByRole('button', { name: 'Browse workspace files' }).click();
    await expect(page.getByText('file-0.ts')).toBeVisible();
    const longName = FILE_LISTING.entries[5]!.name;
    await expect(page.getByText(longName)).toBeVisible();

    await assertNoOverflow(page);
    await screenshot(page, slug('grantee-files', page));

    // Git changes come from the same repository folder.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Review uncommitted changes' }).click();
    await expect(page.getByText('tests/checkout/empty-cart.test.ts')).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, slug('grantee-git', page));
  });

  test('a grantee sees why an older workspace agent shows no files', async ({ page }) => {
    await setupMocks(page, makeSession('grantee', LIVE));
    // Registered after setupMocks, so it answers first: the agent cannot confirm the limit.
    await page.route(`**/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/files/list**`, (route) =>
      route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'CONFLICT',
          message:
            'This workspace runs an older agent that cannot limit files to the repository. Teammates can browse files after it restarts.',
        }),
      })
    );
    await openChat(page);

    await page.getByRole('button', { name: 'Browse workspace files' }).click();
    await expect(page.getByText(/older agent that cannot limit files/)).toBeVisible();
    await expect(page.getByText('file-0.ts')).toHaveCount(0);

    await assertNoOverflow(page);
    await screenshot(page, slug('grantee-files-old-agent', page));
  });

  test('a member it is not shared with gets neither Files nor Git', async ({ page }) => {
    await setupMocks(page, makeSession('reader', LIVE));
    await openChat(page);

    // Liveness: the rail rendered before asserting what it lacks.
    await expect(page.getByRole('button', { name: 'Jump through session history' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Browse workspace files' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Review uncommitted changes' })).toHaveCount(0);
  });

  test('an ended chat tells a grantee it cannot continue, without offering sharing', async ({
    page,
  }) => {
    await setupMocks(
      page,
      makeSession('grantee', { status: 'stopped', isTerminated: true, endedAt: NOW - 5_000 })
    );
    await openChat(page);

    await expect(page.getByText('This chat has ended')).toBeVisible();
    await expect(page.getByText(`Only ${LONG_OWNER} can fork it to continue.`)).toBeVisible();
    await expect(page.getByText(/share this chat/)).toHaveCount(0);

    await assertNoOverflow(page);
    await screenshot(page, slug('ended-grantee', page));
  });
});
