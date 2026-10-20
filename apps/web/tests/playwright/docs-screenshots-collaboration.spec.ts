/**
 * Documentation screenshots for working together in a chat (the Collaboration guide): the
 * Share dialog's confirmation step, the chat as the teammate it was shared with sees it, and
 * the comment box with its @mention list and with Send to agent chosen.
 *
 * Every capture drives the REAL production components with mocked API data, opens each
 * surface the way a person does, and asserts on what rendered, so a component that stops
 * rendering fails the capture instead of shipping a stale image
 * (`.claude/rules/62-tests-must-observe-the-real-trigger.md`). The stress cases (unbreakable
 * names, many people, 320px, revoke and renew) live in
 * `shared-session-collaboration-audit.spec.ts` and `shared-session-viewer-audit.spec.ts`;
 * these fixtures are ordinary on purpose, because they are what a reader compares their own
 * screen against.
 *
 * The clock and time zone are fixed so the "ends in … (time)" text is the same on every run.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-collaboration \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { makeIdleSessionState, makeMockUser, seedTheme } from './audit-helpers';
import { docsShot, opaqueBackdrop } from './docs-shot';

test.use({ timezoneId: 'UTC', locale: 'en-US' });

const PROJECT_ID = '01KH2ZQ7M4R9T6V3X8B5N1C0DW';
const SESSION_ID = '7d1e4c92-3a6b-4f08-9b2e-5c7a1d0e8f63';
const TASK_ID = '01KH9B3C5D7E9F1G3H5J7K9M1N';
const NOW = Date.parse('2026-10-20T14:20:00Z');
const MINUTE = 60_000;

const PRAKASH = { id: 'user-prakash', name: 'Prakash Rao', avatarUrl: null };
const ANA = { id: 'user-ana', name: 'Ana Ruiz', avatarUrl: null };

type Viewer = 'owner' | 'grantee';

const VIEWERS = {
  owner: makeMockUser({
    email: 'prakash@example.com',
    name: PRAKASH.name,
    sessionId: 'auth-docs-prakash',
    userId: PRAKASH.id,
  }),
  grantee: makeMockUser({
    email: 'ana@example.com',
    name: ANA.name,
    sessionId: 'auth-docs-ana',
    userId: ANA.id,
  }),
};

function member(userId: string, name: string, email: string, role = 'admin') {
  return {
    projectId: PROJECT_ID,
    userId,
    role,
    status: 'active',
    invitedBy: null,
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
    user: { id: userId, name, email, image: null, avatarUrl: null },
  };
}

const MEMBERS = {
  members: [
    member(PRAKASH.id, PRAKASH.name, 'prakash@example.com', 'owner'),
    member(ANA.id, ANA.name, 'ana@example.com'),
    member('user-dana', 'Dana Scully', 'dana@example.com'),
    member('user-ben', 'Ben Okafor', 'ben@example.com'),
    member('user-erin', 'Erin Hannon', 'erin@example.com'),
  ],
  inviteLinks: [],
  accessRequests: [],
};

const PROJECT = {
  id: PROJECT_ID,
  name: 'acme/checkout-service',
  repository: 'acme/checkout-service',
  defaultBranch: 'main',
  userId: PRAKASH.id,
  githubInstallationId: 'inst-1',
  multiplayerActive: true,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-10-20T00:00:00Z',
};

/** Ana's access: shared by Prakash for an hour, 23 minutes left. */
const ANA_GRANT = {
  id: 'grant-ana',
  sessionId: SESSION_ID,
  grantee: ANA,
  grantedBy: PRAKASH,
  parentGrantId: null,
  createdAt: NOW - 37 * MINUTE,
  expiresAt: NOW + 23 * MINUTE,
  durationMinutes: 60,
};

function accessSummary(viewer: Viewer) {
  return {
    sessionId: SESSION_ID,
    viewerAccess: viewer,
    owner: PRAKASH,
    grants: [ANA_GRANT],
    serverTime: NOW,
  };
}

function session(viewer: Viewer) {
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    workspaceId: 'ws-docs-collab',
    // A Chat backed by a task, as every project chat is: the task is what puts Fork and Retry
    // in the tool rail, for the teammate too.
    taskId: TASK_ID,
    task: {
      id: TASK_ID,
      status: 'in_progress',
      executionStep: 'awaiting_followup',
      outputBranch: 'sam/fix-flaky-checkout-tests',
      outputPrUrl: null,
      errorMessage: null,
      outputSummary: null,
      finalizedAt: null,
      taskMode: 'conversation',
      agentProfileHint: null,
    },
    topic: 'Fix the flaky checkout tests',
    status: 'active',
    messageCount: 4,
    startedAt: NOW - 50 * MINUTE,
    endedAt: null,
    createdAt: NOW - 50 * MINUTE,
    lastMessageAt: NOW - 2 * MINUTE,
    isIdle: true,
    agentCompletedAt: NOW - 2 * MINUTE,
    isTerminated: false,
    workspaceUrl: null,
    cleanupAt: null,
    // No live agent session to reconnect to: otherwise connection recovery resumes it and the
    // header flips from Idle to Active depending on timing.
    agentSessionId: null,
    agentType: 'claude-code',
    isMine: viewer === 'owner',
    // Who started it: the teammate's session list names Prakash instead of "You".
    createdByUserId: PRAKASH.id,
    createdBy: { id: PRAKASH.id, name: PRAKASH.name, email: 'prakash@example.com' },
    viewerAccess: viewer,
    access: accessSummary(viewer),
  };
}

const MESSAGES = [
  {
    id: 'msg-1',
    role: 'user',
    content: 'The checkout tests fail about one run in five. Find out why.',
    toolMetadata: null,
  },
  {
    id: 'msg-2',
    role: 'assistant',
    content:
      'The flaky test waits a fixed 200 ms before it reads the cart total, and the total ' +
      'sometimes arrives later than that. I can replace the fixed wait with an explicit wait ' +
      'for the total.',
    toolMetadata: null,
  },
  {
    // Ana's message, sent while the chat was shared with her: the server records who sent it.
    id: 'msg-3',
    role: 'user',
    content: 'Go ahead, and run the suite 20 times to be sure.',
    toolMetadata: {
      kind: 'durable_prompt_delivery',
      deliveryId: 'delivery-docs-ana',
      source: 'user_followup',
      userId: ANA.id,
      senderName: ANA.name,
      onBehalfOfUserId: PRAKASH.id,
      grantId: ANA_GRANT.id,
    },
  },
  {
    id: 'msg-4',
    role: 'assistant',
    content:
      'Done: with the explicit wait, the checkout suite passed 20 of 20 runs. The change is ' +
      'in `tests/checkout/cart.spec.ts`.',
    toolMetadata: null,
  },
].map((message, index) => ({
  ...message,
  sessionId: SESSION_ID,
  createdAt: NOW - (40 - index * 12) * MINUTE,
  sequence: index + 1,
}));

async function setupMocks(page: Page, viewer: Viewer) {
  const user = VIEWERS[viewer];
  await page.clock.setFixedTime(NOW);
  await seedTheme(page, 'dark');
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
    window.localStorage.setItem('sam-session-tool-strip-mode', 'icons');
  }, user.user.id);
  await page.routeWebSocket(/\/api\/projects\/[^/]+\/sessions\/ws/, (ws) => {
    ws.onMessage((raw) => {
      try {
        if (JSON.parse(String(raw))?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* ignore non-JSON frames */
      }
    });
  });

  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown) => route.fulfill({ status: 200, json: body });

    if (path.includes('/api/auth/')) return respond(user);
    if (path.startsWith('/api/notifications')) {
      return respond({ notifications: [], unreadCount: 0, nextCursor: null });
    }
    if (path === '/api/credentials/agent') {
      return respond({ credentials: [{ agentType: 'claude-code', isActive: true }] });
    }
    if (path.startsWith('/api/credentials')) {
      return respond([{ id: 'cred-docs-hetzner', provider: 'hetzner', name: 'Hetzner' }]);
    }
    if (path === '/api/github/installations') {
      return respond([{ id: 'inst-1', accountName: 'acme', accountType: 'Organization' }]);
    }
    if (path === '/api/agents') return respond({ agents: [] });
    if (path === '/api/trial/status') return respond({ available: false });
    if (path === '/api/workspaces') return respond([]);
    if (path === '/api/projects') return respond({ projects: [PROJECT], nextCursor: null });

    const match = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (!match) return respond({});
    const sub = match[2] ?? '';
    const current = session(viewer);
    if (sub === '/members') return respond(MEMBERS);
    if (sub === `/sessions/${SESSION_ID}/access`) return respond(current.access);
    if (sub === `/sessions/${SESSION_ID}/comments`) return respond({ comments: [] });
    if (sub === '/comment-threads') return respond({ threads: [], total: 0 });
    if (sub === '/sessions') return respond({ sessions: [current], total: 1, hasMore: false });
    // The agent has finished its turn: a steady "Idle" chat, whichever poll lands first.
    if (sub === `/sessions/${SESSION_ID}/state`) return respond(makeIdleSessionState());
    if (sub === `/sessions/${SESSION_ID}`) {
      return respond({
        session: current,
        messages: MESSAGES,
        hasMore: false,
        state: makeIdleSessionState(),
      });
    }
    if (sub === `/sessions/${SESSION_ID}/messages`) {
      return respond({ messages: MESSAGES, hasMore: false });
    }
    if (sub === '/tasks') return respond({ tasks: [], nextCursor: null });
    if (sub === '/agent-profiles' || sub === '/skills') return respond({ items: [] });
    if (/\/commands|\/cached-commands/.test(sub)) return respond({ commands: [] });
    if (sub === '/credential-attribution-health') {
      // Nothing runs on anyone's personal keys, so the nav shows no Credentials indicator.
      return respond({
        multiplayerActive: true,
        counts: {
          resources: 0,
          personalResources: 0,
          personalCredentials: 0,
          projectCoveredCredentials: 0,
        },
        resources: [],
      });
    }
    if (sub === '') return respond(PROJECT);
    return respond({});
  });
}

async function openChat(page: Page, viewer: Viewer) {
  await setupMocks(page, viewer);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  // Liveness: without this, every capture below would happily screenshot a crash page.
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByText(/passed 20 of 20 runs/).first()).toBeVisible({ timeout: 20_000 });
  // The agent has finished its turn; every image shows the same steady state.
  await expect(page.getByTestId('session-floating-header')).toContainText('Idle');
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

/**
 * Phone captures keep the 375px width but use a taller screen than the iPhone SE project, so
 * the frame shows the surface with its context instead of a sliver under the fixed headers.
 */
async function usePhoneHeight(page: Page, height: number) {
  if (isMobile(page)) await page.setViewportSize({ width: 375, height });
}

/** The element's top edge is below the floating chat header, so a capture shows it. */
async function expectClearOfChatHeader(page: Page, target: ReturnType<Page['getByTestId']>) {
  const headerBox = (await page.getByTestId('session-floating-header').boundingBox())!;
  const targetBox = (await target.boundingBox())!;
  expect(targetBox.y).toBeGreaterThan(headerBox.y + headerBox.height + 8);
}

test('docs: share a chat, confirmation step', async ({ page }) => {
  // Tall enough for the whole confirmation step to fit in the phone's bottom sheet.
  await usePhoneHeight(page, 1000);
  await openChat(page, 'owner');
  await page.getByTestId('session-tool-share').click();
  const dialog = page.getByRole('dialog', { name: 'Share chat access' });
  await expect(dialog).toBeVisible();
  // People with access: Ana, added earlier, with the time her access ends.
  await expect(dialog.getByTestId('grant-time-left')).toHaveText('ends in 23 min (2:43 PM)');

  await dialog.getByRole('button', { name: 'Share with Dana Scully' }).click();
  await expect(dialog.getByRole('heading', { name: 'Share with Dana Scully?' })).toBeVisible();
  const durations = dialog.getByRole('group', { name: 'How long?' });
  await expect(durations.locator('label')).toHaveText(['5 min', '10 min', '30 min', '1 hour']);
  const share = dialog.getByRole('button', { name: 'Share', exact: true });
  // Nothing is chosen for you: Share stays off until a duration and the checkbox are picked.
  await expect(share).toBeDisabled();
  await durations.getByText('30 min').click();
  await dialog.getByRole('checkbox', { name: 'I understand this runs on my accounts' }).check();
  await expect(dialog.getByText('Ends at 2:50 PM.')).toBeVisible();
  await expect(share).toBeEnabled();

  await opaqueBackdrop(page);
  await docsShot(
    page,
    isMobile(page) ? 'collaboration-share-confirm-mobile' : 'collaboration-share-confirm',
    dialog
  );
});

test('docs: a chat as the teammate it is shared with sees it', async ({ page }) => {
  await usePhoneHeight(page, 812);
  await openChat(page, 'grantee');
  const notice = page.getByTestId('shared-session-notice');
  await expect(notice).toContainText(
    "You're chatting in Prakash Rao's session. It runs on Prakash Rao's accounts."
  );
  await expect(page.getByTestId('shared-session-time-left')).toHaveText(
    'Your access ends in 23 min (2:43 PM).'
  );
  const label = page
    .getByTestId('user-message-attribution')
    .filter({ hasText: 'Ana Ruiz · shared access' });
  await expect(label).toBeVisible();
  // Bring Ana's labelled message into the middle of the chat, clear of the floating header.
  await label.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await expectClearOfChatHeader(page, label);
  // The teammate can write, but has no paperclip: attachments stay with the owner.
  await expect(page.getByPlaceholder(/Send a message/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Attach files' })).toHaveCount(0);
  // Fork and Retry start a chat of the teammate's own, so the rail offers them too.
  await expect(page.getByTestId('session-tool-fork')).toBeVisible();
  await expect(page.getByTestId('session-tool-retry')).toBeVisible();
  if (!isMobile(page)) {
    // The session list (desktop only; phones show the chat alone) names who started the chat.
    await expect(page.getByText('Prakash Rao', { exact: true }).first()).toBeVisible();
  }

  await docsShot(
    page,
    isMobile(page) ? 'collaboration-shared-view-mobile' : 'collaboration-shared-view'
  );
});

/** Opens the comment box on the agent's last reply, as its owner does. */
async function openCommentBox(page: Page) {
  const message = page.locator('[data-conversation-item-id="msg-4"]');
  await message.getByRole('button', { name: 'Comment on this message' }).click();
  // Desktop docks the comment box in the Comments panel; phones show it under the message.
  const field = page.getByLabel('Add a comment…').filter({ visible: true }).first();
  await expect(field).toBeVisible();
  if (isMobile(page)) {
    // On a phone the box opens under the message: show the reply it's about above it,
    // just below the floating header (which overlays the top of the conversation). The list
    // re-measures while the box mounts and can scroll again, so repeat until it stays put.
    const header = page.getByTestId('session-floating-header');
    const scroller = page.locator('[data-sam-conversation-scroller="true"]').first();
    await expect(async () => {
      const headerBox = (await header.boundingBox())!;
      const target = headerBox.y + headerBox.height + 16;
      const offset = (await message.boundingBox())!.y - target;
      if (Math.abs(offset) > 2) await scroller.evaluate((el, by) => el.scrollBy(0, by), offset);
      await page.waitForTimeout(300);
      expect(Math.abs((await message.boundingBox())!.y - target)).toBeLessThan(3);
    }).toPass({ timeout: 10_000 });
  }
  // Keep the pointer off lists and buttons, so nothing in the capture shows a hover state.
  await page.mouse.move(2, 2);
  return field;
}

/** On a phone, the reply the comment is about is still in the capture, clear of the header. */
async function expectReplyInView(page: Page) {
  if (!isMobile(page)) return;
  const reply = page.locator('[data-conversation-item-id="msg-4"]');
  await expectClearOfChatHeader(page, reply.getByText(/passed 20 of 20 runs/));
}

test('docs: mention a teammate in a comment', async ({ page }) => {
  await usePhoneHeight(page, 812);
  await openChat(page, 'owner');
  // With the pointer away, the list opens with its first entry active, as it does when
  // someone types.
  const field = await openCommentBox(page);
  await field.fill('Can you double-check the empty-cart case, @');
  const palette = page.getByRole('listbox', { name: 'Mention a teammate' });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('option', { name: /Dana Scully/ })).toBeVisible();
  // The owner can drive this chat, so the box offers a note or Send to agent.
  const form = page.locator('form').filter({ has: field });
  await expect(form.getByRole('radio', { name: 'Add note' })).toBeChecked();
  await expect(form.getByRole('radio', { name: 'Send to agent' })).toBeAttached();
  await expectReplyInView(page);

  await docsShot(page, isMobile(page) ? 'collaboration-mention-mobile' : 'collaboration-mention');
});

test('docs: send a comment to the agent', async ({ page }) => {
  await usePhoneHeight(page, 812);
  await openChat(page, 'owner');
  const field = await openCommentBox(page);
  await field.fill('Also run it with the slow-network profile before you open the pull request.');
  const form = page.locator('form').filter({ has: field });
  // A note is the default; choosing Send to agent turns the comment into a message for the agent.
  await expect(form.getByRole('radio', { name: 'Add note' })).toBeChecked();
  await form.getByRole('radio', { name: 'Send to agent' }).check();
  await expect(
    form.getByText('Send to agent creates a follow-up instruction with the quoted message context.')
  ).toBeVisible();
  const send = form.getByRole('button', { name: 'Comment & send' });
  await expect(send).toBeEnabled();
  // The whole box, down to its button, is on screen in the capture, below the reply.
  await expect(send).toBeInViewport();
  await expectReplyInView(page);

  await docsShot(
    page,
    isMobile(page) ? 'collaboration-send-to-agent-mobile' : 'collaboration-send-to-agent'
  );
});
