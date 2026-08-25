import { expect, type Locator, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const PROJECT_ID = 'proj-message-comments';
const SESSION_ID = 'session-message-comments';
const NOW = Date.now();

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  role: 'superadmin',
  sessionId: 'auth-session-message-comments',
  userId: 'user-message-comments',
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Message Comment Audit',
  repository: 'testuser/message-comment-audit',
  repoProvider: 'github',
  defaultBranch: 'main',
  userId: 'user-message-comments',
  githubInstallationId: 'inst-message-comments',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  defaultWorkspaceProfile: 'full',
  defaultDevcontainerConfigName: '',
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-08-21T00:00:00Z',
  updatedAt: '2026-08-21T00:00:00Z',
};

const MOCK_SESSION = {
  id: SESSION_ID,
  workspaceId: null,
  taskId: null,
  topic: 'Message anchored comments audit',
  status: 'active',
  messageCount: 28,
  startedAt: NOW - 600_000,
  endedAt: null,
  createdAt: NOW - 700_000,
  lastMessageAt: NOW - 10_000,
  isIdle: true,
  agentCompletedAt: NOW - 20_000,
  isTerminated: false,
  workspaceUrl: null,
  cleanupAt: null,
  agentSessionId: 'agent-session-message-comments',
};

const AUTHOR = {
  id: 'user-message-comments',
  name: 'Test User',
  email: 'test@example.com',
  avatarUrl: null,
  kind: 'human',
};

type CommentStatus = 'open' | 'sent' | 'resolved';
type CommentAction = 'note' | 'send_to_agent';

interface AuditCommentReply {
  id: string;
  clientId?: string | null;
  author: typeof AUTHOR;
  body: string;
  createdAt: number;
  updatedAt: number;
  sentToAgent?: boolean;
}

interface AuditCommentThread {
  id: string;
  clientId?: string | null;
  projectId: string;
  sessionId: string;
  anchor: {
    kind: 'message';
    messageId: string;
    quote?: string;
  };
  author: typeof AUTHOR;
  body: string;
  createdAt: number;
  updatedAt: number;
  status: CommentStatus;
  replies: AuditCommentReply[];
}

function makeMessage(index: number) {
  const role = index % 2 === 0 ? 'user' : 'assistant';
  const marker =
    index === 3
      ? 'Assistant comment target 3: Select this exact desktop phrase for the audit.'
      : index === 27
        ? 'Assistant mobile comment target 27: Select this exact mobile phrase for the audit.'
        : `${role === 'user' ? 'User' : 'Assistant'} message ${index}`;
  return {
    id: `msg-${index}`,
    sessionId: SESSION_ID,
    role,
    content: `${marker} ${'Wrapped message content keeps the virtualized chat realistic. '.repeat(role === 'assistant' ? 6 : 2)}`,
    toolMetadata: null,
    createdAt: NOW - (28 - index) * 10_000,
    sequence: index,
  };
}

const MESSAGES = Array.from({ length: 28 }, (_, index) => makeMessage(index));

function makeComment(overrides: Partial<AuditCommentThread> & { messageId?: string } = {}) {
  const messageId = overrides.messageId ?? overrides.anchor?.messageId ?? 'msg-3';
  return {
    id: overrides.id ?? 'comment-seeded-1',
    clientId: overrides.clientId ?? null,
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    anchor: overrides.anchor ?? {
      kind: 'message' as const,
      messageId,
      quote: `Quoted text for ${messageId}`,
    },
    author: overrides.author ?? AUTHOR,
    body: overrides.body ?? 'Seeded desktop rail comment',
    createdAt: overrides.createdAt ?? NOW - 300_000,
    updatedAt: overrides.updatedAt ?? NOW - 300_000,
    status: overrides.status ?? 'open',
    replies: overrides.replies ?? [],
  } satisfies AuditCommentThread;
}

async function parseJson(route: Route): Promise<Record<string, unknown>> {
  const raw = route.request().postData() || '{}';
  return JSON.parse(raw) as Record<string, unknown>;
}

async function setupProjectWebSocket(page: Page) {
  await page.routeWebSocket(/\/api\/projects\/[^/]+\/sessions\/ws/, (ws) => {
    ws.onMessage((raw) => {
      try {
        const parsed = JSON.parse(String(raw));
        if (parsed?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* ignore non-json frames */
      }
    });
  });
}

async function setupApiMocks(
  page: Page,
  options: {
    initialComments?: AuditCommentThread[];
    commentsMode?: 'normal' | 'error-then-empty';
  } = {}
) {
  const comments = [...(options.initialComments ?? [])];
  let nextCommentId = 1;
  let nextReplyId = 1;
  let commentsErrorEnabled = options.commentsMode === 'error-then-empty';

  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);
  await setupProjectWebSocket(page);

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/provider-catalog') || path.startsWith('/api/providers/catalog'))
      return respond(200, { catalogs: [] });
    if (path === '/api/trial/status') return respond(200, { available: false });
    if (path === '/api/transcribe') return respond(200, { text: 'Dictated from voice.' });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/workspaces') return respond(200, []);
    if (path === '/api/projects')
      return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (!projectMatch) return respond(200, {});
    const subPath = projectMatch[2] || '';

    const commentsBase = `/sessions/${SESSION_ID}/comments`;
    if (subPath === commentsBase && method === 'GET') {
      if (commentsErrorEnabled) {
        await new Promise((resolve) => setTimeout(resolve, 350));
        return respond(500, {
          error: 'COMMENTS_UNAVAILABLE',
          message: 'Audit comments unavailable',
        });
      }
      return respond(200, { comments });
    }

    if (subPath === commentsBase && method === 'POST') {
      const body = await parseJson(route);
      const legacyAnchor =
        typeof body.anchor === 'object' && body.anchor !== null
          ? (body.anchor as Partial<AuditCommentThread['anchor']>)
          : null;
      const anchor: AuditCommentThread['anchor'] = {
        kind: 'message',
        messageId:
          typeof body.messageId === 'string'
            ? body.messageId
            : typeof legacyAnchor?.messageId === 'string'
              ? legacyAnchor.messageId
              : 'msg-3',
        quote:
          typeof body.quote === 'string'
            ? body.quote
            : typeof legacyAnchor?.quote === 'string'
              ? legacyAnchor.quote
              : undefined,
      };
      const action: CommentAction = body.action === 'send_to_agent' ? 'send_to_agent' : 'note';
      const comment = makeComment({
        id: `comment-created-${nextCommentId++}`,
        clientId:
          typeof body.clientId === 'string'
            ? body.clientId
            : typeof body.clientMutationId === 'string'
              ? body.clientMutationId
              : null,
        anchor,
        body: String(body.body),
        status: action === 'send_to_agent' ? 'sent' : 'open',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      comments.push(comment);
      return respond(200, { comment, thread: comment });
    }

    const replyMatch = subPath.match(new RegExp(`^${commentsBase}/([^/]+)/replies$`));
    if (replyMatch && method === 'POST') {
      const comment = comments.find((candidate) => candidate.id === replyMatch[1]);
      if (!comment) return respond(404, { error: 'NOT_FOUND', message: 'Comment not found' });
      const body = await parseJson(route);
      const action: CommentAction = body.action === 'send_to_agent' ? 'send_to_agent' : 'note';
      comment.replies.push({
        id: `reply-created-${nextReplyId++}`,
        clientId:
          typeof body.clientId === 'string'
            ? body.clientId
            : typeof body.clientMutationId === 'string'
              ? body.clientMutationId
              : null,
        author: AUTHOR,
        body: String(body.body),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sentToAgent: action === 'send_to_agent',
      });
      if (action === 'send_to_agent') comment.status = 'sent';
      comment.updatedAt = Date.now();
      return respond(200, { comment, thread: comment });
    }

    const statusMatch = subPath.match(
      new RegExp(`^${commentsBase}/([^/]+)/(resolve|reopen|send)$`)
    );
    if (statusMatch && method === 'POST') {
      const comment = comments.find((candidate) => candidate.id === statusMatch[1]);
      if (!comment) return respond(404, { error: 'NOT_FOUND', message: 'Comment not found' });
      if (statusMatch[2] === 'resolve') comment.status = 'resolved';
      if (statusMatch[2] === 'reopen') comment.status = 'open';
      if (statusMatch[2] === 'send') comment.status = 'sent';
      comment.updatedAt = Date.now();
      return respond(200, { comment, thread: comment });
    }

    if (subPath === '/sessions') {
      return respond(200, { sessions: [MOCK_SESSION], total: 1, hasMore: false });
    }
    if (subPath === `/sessions/${SESSION_ID}`) {
      return respond(200, { session: MOCK_SESSION, messages: MESSAGES, hasMore: false });
    }
    if (subPath.match(/^\/sessions\/[^/]+\/messages/)) return respond(200, MESSAGES);
    if (subPath === '/tasks') return respond(200, { tasks: [], nextCursor: null });
    if (subPath === '/agent-profiles') return respond(200, { items: [] });
    if (subPath === '/skills') return respond(200, { items: [] });
    if (subPath.match(/\/commands|\/cached-commands/)) return respond(200, { commands: [] });

    return respond(200, MOCK_PROJECT);
  });

  return {
    clearCommentsError: () => {
      commentsErrorEnabled = false;
    },
  };
}

/**
 * Replaces the microphone stack in the page so the real VoiceButton can be
 * driven through record -> stop -> transcribe without hardware or permissions.
 */
async function stubMicrophone(page: Page) {
  await page.addInitScript(() => {
    class StubRecorder {
      state = 'inactive';
      mimeType = 'audio/webm';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      onerror: (() => void) | null = null;
      static isTypeSupported() {
        return true;
      }
      start() {
        this.state = 'recording';
      }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) });
        this.onstop?.();
      }
    }
    Object.defineProperty(window, 'MediaRecorder', {
      value: StubRecorder,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {}, kind: 'audio' }] }),
      },
      configurable: true,
      writable: true,
    });
  });
}

/**
 * Variant C proof: the mic must sit *inside* the textarea's box (an overlay),
 * not below or beside it, and must not cover text.
 */
async function expectMicOverlaidInComposer(composer: Locator, textareaLabel: string) {
  const mic = composer.getByRole('button', { name: 'Start voice input' });
  await expect(mic).toBeVisible();

  const micBox = (await mic.boundingBox())!;
  const fieldBox = (await composer.getByLabel(textareaLabel).boundingBox())!;
  expect(micBox, 'mic must have a layout box').not.toBeNull();

  expect(micBox.x).toBeGreaterThanOrEqual(fieldBox.x);
  expect(micBox.x + micBox.width).toBeLessThanOrEqual(fieldBox.x + fieldBox.width + 1);
  expect(micBox.y).toBeGreaterThanOrEqual(fieldBox.y);
  expect(micBox.y + micBox.height).toBeLessThanOrEqual(fieldBox.y + fieldBox.height + 1);

  // Touch target stays tappable on a coarse pointer.
  expect(micBox.width).toBeGreaterThanOrEqual(44);
  expect(micBox.height).toBeGreaterThanOrEqual(44);
  return mic;
}

async function openChat(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  await expect(page.getByText(/Assistant mobile comment target 27/)).toBeVisible({
    timeout: 15_000,
  });
}

async function dragSelectText(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box, 'selection target must have a browser layout box').not.toBeNull();
  const startX = box!.x + 16;
  const endX = box!.x + Math.min(box!.width - 12, 330);
  const y = box!.y + Math.min(20, Math.max(10, box!.height / 2));

  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(endX, y, { steps: 12 });
  await page.mouse.up();

  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString().trim().length ?? 0), {
      timeout: 5_000,
    })
    .toBeGreaterThan(3);
}

async function expectCommentThreadVisible(root: Page | Locator, body: string) {
  const article = root.locator('article').filter({ hasText: body }).first();
  await expect(article).toBeVisible();
  return article;
}

async function expectConversationCanScrollBehindOverlay(page: Page) {
  const scrollResult = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>(
      '[data-sam-conversation-scroller="true"]'
    );
    if (!scroller) return null;

    const before = scroller.scrollTop;
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    scroller.scrollTop = before > 0 ? Math.max(0, before - 300) : Math.min(maxScroll, 300);
    scroller.dispatchEvent(new Event('scroll', { bubbles: true }));

    return {
      after: scroller.scrollTop,
      before,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
    };
  });

  expect(
    scrollResult,
    'conversation scroller should exist while the selected-text composer is fixed'
  ).not.toBeNull();
  expect(scrollResult!.scrollHeight).toBeGreaterThan(scrollResult!.clientHeight);
  expect(scrollResult!.after).not.toBe(scrollResult!.before);
}

test.describe('message comments audit — desktop 1280x800', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('supports data-driven rail, selection create, reply, send, resolve, and reopen', async ({
    page,
  }) => {
    await setupApiMocks(page, {
      initialComments: [
        makeComment({
          id: 'comment-offscreen-msg-3',
          messageId: 'msg-3',
          body: 'Seeded desktop rail comment on an offscreen message.',
        }),
      ],
    });
    await openChat(page);

    await expect(page.getByRole('complementary', { name: 'Session comments' })).toHaveCount(0);
    await page.getByRole('button', { name: /1 unresolved comment/i }).click();
    const rail = page.getByRole('complementary', { name: 'Session comments' });
    await expect(
      rail.getByText('Seeded desktop rail comment on an offscreen message.')
    ).toBeVisible();

    const desktopTarget = page.getByText(/Assistant mobile comment target 27/);
    await expect(desktopTarget).toBeVisible();
    await dragSelectText(page, desktopTarget);

    const selectionDialog = page.getByRole('dialog', { name: 'Comment on selection' });
    await expect(selectionDialog).toBeVisible();
    await selectionDialog.getByRole('button', { name: 'Comment' }).click();

    await expect(rail.getByText(/New comment on selected text msg-27/)).toBeVisible();
    await rail.getByLabel('Add a comment…').fill('Desktop note from selected message text.');
    await rail.getByRole('button', { name: 'Comment', exact: true }).click();

    const createdThread = await expectCommentThreadVisible(
      rail,
      'Desktop note from selected message text.'
    );
    await expect
      .poll(() => createdThread.getAttribute('data-comment-id'), {
        message: 'created comment should settle from optimistic id to server id',
      })
      .toMatch(/^comment-created-/);
    const createdCommentId = await createdThread.getAttribute('data-comment-id');
    expect(createdCommentId).toBeTruthy();
    await expect(createdThread).toHaveAttribute('data-comment-status', 'open');

    await createdThread.getByRole('button', { name: 'Reply' }).click();
    await createdThread.getByLabel('Reply…').fill('Reply sent with selected context.');
    await createdThread.getByRole('radio', { name: 'Send to agent' }).check();
    await createdThread.getByRole('button', { name: 'Comment & send' }).click();
    await expect(createdThread.getByRole('textbox', { name: 'Reply…' })).toBeHidden();
    await expect(
      createdThread.getByRole('listitem').filter({ hasText: 'Reply sent with selected context.' })
    ).toBeVisible();
    await expect(createdThread).toHaveAttribute('data-comment-status', 'sent');

    await createdThread.getByRole('button', { name: 'Resolve' }).click();
    const resolvedThread = rail.locator(`article[data-comment-id="${createdCommentId}"]`);
    await expect(resolvedThread).toHaveAttribute('data-comment-status', 'resolved');
    await expect(
      resolvedThread.getByRole('button', { name: /Show resolved thread/ })
    ).toBeVisible();
    await resolvedThread.getByRole('button', { name: /Show resolved thread/ }).click();
    await resolvedThread.getByRole('button', { name: 'Reopen' }).click();
    await expect(resolvedThread).toHaveAttribute('data-comment-status', 'open');

    await screenshot(page, 'message-comments-desktop-thread-flow');
    await assertNoOverflow(page);
  });

  test('dictates a comment through the overlaid mic in the rail composer', async ({ page }) => {
    await stubMicrophone(page);
    await setupApiMocks(page);
    await openChat(page);

    await dragSelectText(page, page.getByText(/Assistant mobile comment target 27/));
    await page
      .getByRole('dialog', { name: 'Comment on selection' })
      .getByRole('button', { name: 'Comment', exact: true })
      .click();

    const rail = page.getByRole('complementary', { name: 'Session comments' });
    const field = rail.getByLabel('Add a comment…');
    await expect(field).toBeVisible();
    await field.fill('Typed first.');

    const mic = await expectMicOverlaidInComposer(rail, 'Add a comment…');
    await screenshot(page, 'message-comments-desktop-voice-idle');
    await assertNoOverflow(page);

    // The mic overlay covers the native resize grip, so the field must grow on
    // its own — otherwise disabling resize would leave long comments stuck in a
    // fixed 3-row box. Height must rise with content, then stop at the ceiling.
    const heightOf = () => field.evaluate((el) => el.getBoundingClientRect().height);
    const restingHeight = await heightOf();
    await field.fill('One line.\nTwo lines.\nThree lines.\nFour lines.\nFive lines.');
    const grownHeight = await heightOf();
    expect(grownHeight).toBeGreaterThan(restingHeight);

    await field.fill(`${'A very long dictated sentence that wraps. '.repeat(40)}`);
    const cappedHeight = await heightOf();
    expect(cappedHeight).toBeLessThanOrEqual(200);
    expect(cappedHeight).toBeGreaterThanOrEqual(grownHeight);
    // The mic must still be inside the field at its grown size, not floating
    // over the radios below it.
    await expectMicOverlaidInComposer(rail, 'Add a comment…');
    await screenshot(page, 'message-comments-desktop-voice-grown');
    await assertNoOverflow(page);

    await field.fill('Typed first.');
    await expect.poll(heightOf).toBe(restingHeight);

    await mic.click();
    const stop = rail.getByRole('button', { name: 'Stop recording' });
    await expect(stop).toBeVisible();
    // Dark theme resolves --sam-color-danger to #ef4444.
    await expect(field).toHaveCSS('border-color', 'rgb(239, 68, 68)');
    await screenshot(page, 'message-comments-desktop-voice-recording');

    // The tint is a theme token, not a fixed color: light theme must re-resolve
    // it to #dc2626 rather than keeping the dark value.
    await page.evaluate(() => document.documentElement.setAttribute('data-ui-theme', 'sam-light'));
    await expect(field).toHaveCSS('border-color', 'rgb(220, 38, 38)');
    await screenshot(page, 'message-comments-desktop-voice-recording-light');
    await page.evaluate(() => document.documentElement.setAttribute('data-ui-theme', 'sam'));

    await stop.click();
    await expect(field).toHaveValue('Typed first. Dictated from voice.');

    await rail.getByRole('button', { name: 'Comment', exact: true }).click();
    await expectCommentThreadVisible(rail, 'Typed first. Dictated from voice.');
    await screenshot(page, 'message-comments-desktop-voice-submitted');
    await assertNoOverflow(page);
  });

  test('surfaces loading, error, retry, and empty states', async ({ page }) => {
    const controls = await setupApiMocks(page, { commentsMode: 'error-then-empty' });
    await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);

    await page.getByRole('button', { name: 'Show session details' }).click();
    await page.getByRole('button', { name: 'Comments', exact: true }).click();
    const rail = page.getByRole('complementary', { name: 'Session comments' });

    await expect(rail.getByText('Loading comments…')).toBeVisible();
    await expect(
      rail.getByRole('alert').filter({ hasText: 'Comments failed to load.' })
    ).toBeVisible({
      timeout: 10_000,
    });
    await screenshot(page, 'message-comments-desktop-error-state');

    controls.clearCommentsError();
    await rail.getByRole('button', { name: 'Retry' }).click();
    await expect(
      rail.getByText(
        'Select text in a user or agent message, or use a message Comment button to start a thread.'
      )
    ).toBeVisible();
    await screenshot(page, 'message-comments-desktop-empty-state');
    await assertNoOverflow(page);
  });
});

test.describe('message comments audit — mobile 375x667', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });

  test('uses coarse-pointer selection affordance and bottom composer for selected-text drafts', async ({
    page,
  }) => {
    await setupApiMocks(page);
    await openChat(page);

    await expect(page.getByRole('heading', { name: 'Comments' })).toBeHidden();
    const mobileTarget = page.getByText(/Assistant mobile comment target 27/);
    await dragSelectText(page, mobileTarget);

    const actionBar = page.getByRole('dialog', { name: 'Comment on selection' });
    await expect(actionBar.getByRole('button', { name: 'Comment on selection' })).toBeVisible();
    await actionBar.getByRole('button', { name: 'Comment on selection' }).click();

    const bottomComposer = page.getByRole('region', {
      name: 'Selected text comment composer',
    });
    await expect(bottomComposer).toBeVisible();
    await expectConversationCanScrollBehindOverlay(page);
    await expect(bottomComposer).toBeVisible();

    await bottomComposer
      .getByLabel('Add a comment…')
      .fill('Mobile comment sent to agent from selected text.');
    await bottomComposer.getByRole('radio', { name: 'Send to agent' }).check();
    await bottomComposer.getByRole('button', { name: 'Comment & send' }).click();

    await expect(bottomComposer).toBeHidden();
    const mobilePanel = page.getByRole('region', { name: 'Message comments' }).last();

    const thread = await expectCommentThreadVisible(
      mobilePanel,
      'Mobile comment sent to agent from selected text.'
    );
    await expect(thread).toHaveAttribute('data-comment-status', 'sent');
    await expect(
      page.getByRole('button', { name: /1 comment on this message, 1 unresolved/i })
    ).toBeVisible();
    await expect(page.locator('aside')).toBeHidden();

    await screenshot(page, 'message-comments-mobile-bottom-composer-send');
    await assertNoOverflow(page);
  });

  test('dictates a comment through the overlaid mic in the mobile panel', async ({ page }) => {
    await stubMicrophone(page);
    await setupApiMocks(page);
    await openChat(page);

    const mobileTarget = page.getByText(/Assistant mobile comment target 27/);
    await dragSelectText(page, mobileTarget);
    await page
      .getByRole('dialog', { name: 'Comment on selection' })
      .getByRole('button', { name: 'Comment on selection' })
      .click();

    const panel = page.getByRole('region', { name: 'Selected text comment composer' });
    const field = panel.getByLabel('Add a comment…');
    await expect(field).toBeVisible();

    const mic = await expectMicOverlaidInComposer(panel, 'Add a comment…');
    await screenshot(page, 'message-comments-mobile-voice-idle');
    await assertNoOverflow(page);

    await mic.click();
    const stop = panel.getByRole('button', { name: 'Stop recording' });
    await expect(stop).toBeVisible();
    await screenshot(page, 'message-comments-mobile-voice-recording');

    await stop.click();
    // Empty body means no leading separator is inserted.
    await expect(field).toHaveValue('Dictated from voice.');

    await panel.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(panel).toBeHidden();
    const messagePanel = page.getByRole('region', { name: 'Message comments' }).last();
    await expectCommentThreadVisible(messagePanel, 'Dictated from voice.');
    await screenshot(page, 'message-comments-mobile-voice-submitted');
    await assertNoOverflow(page);
  });
});
