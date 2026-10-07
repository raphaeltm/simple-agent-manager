import { expect, type Locator, type Page, test } from '@playwright/test';

import {
  assertNoOverflow,
  expectTheme,
  makeMockUser,
  screenshot,
  seedTheme,
  setupProjectChatMocks,
} from './audit-helpers';

// ---------------------------------------------------------------------------
// User Message Actions Audit
//
// User messages carry two of the three buttons agent messages have: Message
// info and Copy message (agent messages add Read aloud). The shared acp-client
// MessageBubble supported this since #495, but no chat passed a user message's
// timestamp, and the bubble only renders its action row when it has one — so
// the buttons never reached a real chat.
//
// These tests enter the way a user does: the project chat loads history from
// the API and sends through the composer; the workspace chat replays history
// over the agent socket. A call site that drops the timestamp again fails here,
// not just in a unit test that hands MessageBubble a timestamp directly.
// ---------------------------------------------------------------------------

const LONG_URL =
  'https://example.com/a/very/long/path/that/should/wrap/rather/than/overflow?query=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const UNBREAKABLE_TOKEN = 'Supercalifragilisticexpialidocious'.repeat(3);

const SHORT_TEXT = 'ok';
/** Raw markdown — Copy must return exactly this, not the rendered text. */
const LONG_TEXT = [
  `Please review ${LONG_URL} and explain **why** \`renderMessage()\` drops ${UNBREAKABLE_TOKEN}.`,
  '',
  '- Keep the <script>alert("x")</script> literal escaped & intact',
  '- Unicode: 日本語のテキスト, emoji ✅🚀, and RTL שלום',
].join('\n');
const MULTILINE_TEXT = [
  'First line of my request',
  'Second line',
  '',
  '```ts',
  'const answer = 42;',
  '```',
].join('\n');
const INJECTED_TEXT = `IMPORTANT: ${'SAM-injected policy and knowledge context. '.repeat(12)}Call get_instructions first.`;
const SENT_TEXT = 'Ship the info and copy buttons on user messages 🚀';

function infoButton(scope: Locator) {
  return scope.getByRole('button', { name: 'Message info' });
}
function copyButton(scope: Locator) {
  return scope.getByRole('button', { name: 'Copy message' });
}
function readAloudButton(scope: Locator) {
  return scope.getByRole('button', { name: 'Read aloud' });
}
function metadataPopover(page: Page) {
  return page.getByRole('dialog', { name: 'Message metadata' });
}
/** The virtualized list that scrolls (and clips) the conversation holding `el`. */
function scrollerOf(el: Locator) {
  return el.locator('xpath=ancestor::*[@data-testid="virtuoso-scroller"][1]');
}

/** Right edge of the bubble's content box: its border box minus border and padding. */
async function contentRight(bubble: Locator): Promise<number> {
  return bubble.evaluate((el) => {
    const style = getComputedStyle(el);
    return (
      el.getBoundingClientRect().right -
      parseFloat(style.paddingRight) -
      parseFloat(style.borderRightWidth)
    );
  });
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  expect(found, 'element must have a layout box').not.toBeNull();
  return found!;
}

/**
 * Virtuoso only mounts rows near the viewport. When the target is not mounted,
 * walk the list from the top until it is, then center it.
 */
async function reveal(target: Locator, scroller: Locator): Promise<Locator> {
  if ((await target.count()) === 0) {
    await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
    for (let step = 0; step < 20; step++) {
      try {
        // Give Virtuoso a frame to render the rows at the new offset.
        await target.first().waitFor({ state: 'attached', timeout: 300 });
        break;
      } catch {
        await scroller.evaluate((el) => el.scrollBy({ top: el.clientHeight / 2 }));
      }
    }
  }
  // Resolve and scroll in one in-page step: Virtuoso can swap row nodes between
  // a separate lookup and scroll.
  await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await expect(target).toHaveCount(1);
  await expect(target).toBeVisible();
  return target;
}

/** Info + Copy inside the bubble, never Read aloud. */
async function expectUserActions(bubble: Locator) {
  await expect(bubble).toHaveCount(1);
  await expect(infoButton(bubble)).toBeVisible();
  await expect(copyButton(bubble)).toBeVisible();
  await expect(readAloudButton(bubble)).toHaveCount(0);
}

/** The copy button ends at the bubble's content edge, with info to its left on one line. */
async function expectTrailingActions(bubble: Locator) {
  const info = await box(infoButton(bubble));
  const copy = await box(copyButton(bubble));
  const bubbleBox = await box(bubble);
  expect(Math.abs(copy.x + copy.width - (await contentRight(bubble)))).toBeLessThanOrEqual(1);
  expect(info.x + info.width).toBeLessThanOrEqual(copy.x + 0.5);
  expect(Math.abs(info.y - copy.y)).toBeLessThanOrEqual(1);
  expect(copy.y + copy.height).toBeLessThanOrEqual(bubbleBox.y + bubbleBox.height);
}

/**
 * The info popover must be usable where it opened: fully inside the visible
 * conversation, painted over the rows around it, one line per field.
 */
async function expectPopoverUsable(page: Page, popover: Locator, scroller: Locator) {
  const area = await box(scroller);
  const pop = await box(popover);
  expect(pop.y).toBeGreaterThanOrEqual(area.y);
  expect(pop.y + pop.height).toBeLessThanOrEqual(area.y + area.height);
  expect(pop.x).toBeGreaterThanOrEqual(0);
  expect(pop.x + pop.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  const layout = await popover.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.bottom - 4);
    return {
      onTop: hit !== null && el.contains(hit),
      lineHeight: parseFloat(getComputedStyle(el).lineHeight),
      rowHeights: Array.from(el.querySelectorAll(':scope > div > div')).map(
        (row) => row.getBoundingClientRect().height
      ),
    };
  });
  // Not painted underneath the next message's row.
  expect(layout.onTop).toBe(true);
  // Sized to its content rather than squeezed to a narrow bubble's width.
  expect(layout.rowHeights).toHaveLength(3);
  for (const height of layout.rowHeights) {
    expect(height).toBeLessThan(layout.lineHeight * 1.5);
  }
}

// ---------------------------------------------------------------------------
// Project chat
// ---------------------------------------------------------------------------

const PROJECT_ID = 'proj-user-actions';
const SESSION_ID = 'sess-user-actions';

const PROJECT = {
  id: PROJECT_ID,
  name: 'User Message Actions Audit',
  repository: 'user/user-message-actions-audit',
  repoProvider: 'github',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

// An active, non-idle session keeps the composer mounted and routes Send
// through the optimistic-append + REST prompt path a real user takes.
const SESSION = {
  id: SESSION_ID,
  workspaceId: 'ws-user-actions',
  taskId: null,
  topic: 'User message actions',
  status: 'active',
  messageCount: 6,
  startedAt: Date.now() - 600_000,
  lastMessageAt: Date.now() - 60_000,
  createdAt: Date.now() - 600_000,
  updatedAt: Date.now() - 1_000,
  endedAt: null,
  cleanupAt: null,
  isIdle: false,
  agentCompletedAt: null,
  agentSessionId: 'acp-user-actions',
  agentType: 'claude-code',
};

function message(id: string, role: 'user' | 'assistant', content: string, sequence: number) {
  return {
    id,
    sessionId: SESSION_ID,
    role,
    content,
    toolMetadata: null,
    createdAt: Date.now() - (10 - sequence) * 60_000,
    sequence,
  };
}

const MESSAGES = [
  message('user-short', 'user', SHORT_TEXT, 1),
  message('agent-1', 'assistant', 'Sure — here is a **short** reply with `inline code`.', 2),
  message('user-long', 'user', LONG_TEXT, 3),
  { ...message('user-system', 'user', INJECTED_TEXT, 4), origin: 'system' },
  message('agent-2', 'assistant', 'Done. Anything else?', 5),
  message('user-multiline', 'user', MULTILINE_TEXT, 6),
];

/** Holds the ProjectData socket open so the chat reports a live connection. */
async function mockProjectWebSocket(page: Page) {
  await page.routeWebSocket(/\/api\/projects\/[^/]+\/sessions\/ws/, (ws) => {
    ws.onMessage((raw) => {
      try {
        const parsed = JSON.parse(String(raw));
        if (parsed?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* non-JSON keepalive frames are ignored */
      }
    });
  });
}

async function openProjectChat(page: Page, theme: 'dark' | 'light') {
  await seedTheme(page, theme);
  await mockProjectWebSocket(page);
  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: PROJECT,
    session: SESSION,
    messages: MESSAGES,
  });
  await page.route(`**/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/prompt`, (route) =>
    route.fulfill({ status: 200, json: { status: 'sent' } })
  );
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  await expect(page.locator('[data-conversation-item-id]').first()).toBeVisible({
    timeout: 15_000,
  });
  await expectTheme(page, theme);
}

/** The project chat's virtualized message list. */
function projectScroller(page: Page) {
  return page.getByRole('log', { name: 'Conversation' }).getByTestId('virtuoso-scroller');
}

async function revealRow(page: Page, id: string): Promise<Locator> {
  return reveal(page.locator(`[data-conversation-item-id="${id}"]`), projectScroller(page));
}

/** The glass user bubble inside a project chat row, with its actions checked. */
async function userBubble(row: Locator): Promise<Locator> {
  const bubble = row.locator('.glass-msg-user');
  await expectUserActions(bubble);
  return bubble;
}

function runProjectChatAudit(
  label: string,
  viewport: { width: number; height: number },
  isMobile: boolean
) {
  test.describe(`User Message Actions — Project chat — ${label}`, () => {
    test.use({ viewport, isMobile });

    for (const theme of ['dark', 'light'] as const) {
      test(`history: user messages show info + copy (${theme})`, async ({ page }) => {
        await openProjectChat(page, theme);

        const shortRow = await revealRow(page, 'user-short');
        await screenshot(page, `user-message-actions-top-${theme}`);
        const shortBubble = await userBubble(shortRow);

        // Same palette as the agent bubble's buttons: the glass user bubble is
        // themed by the same tokens, so it must not inherit the light-on-dark
        // icon colors of the built-in solid-blue bubble (white on light mode).
        const userIconColor = await infoButton(shortBubble).evaluate(
          (el) => getComputedStyle(el).color
        );
        const agentRow = await revealRow(page, 'agent-1');
        await expect(infoButton(agentRow)).toBeVisible();
        await expect(readAloudButton(agentRow)).toBeVisible();
        await expect(copyButton(agentRow)).toBeVisible();
        const agentIconColor = await infoButton(agentRow).evaluate(
          (el) => getComputedStyle(el).color
        );
        expect(userIconColor).toBe(agentIconColor);

        // A wide bubble proves the trailing alignment.
        const longRow = await revealRow(page, 'user-long');
        await expectTrailingActions(await userBubble(longRow));
        await assertNoOverflow(page);

        // SAM-injected context stays collapsed and carries no message actions.
        const systemRow = await revealRow(page, 'user-system');
        await expect(systemRow.locator('details.sam-injected-message')).toBeVisible();
        await expect(infoButton(systemRow)).toHaveCount(0);
        await expect(copyButton(systemRow)).toHaveCount(0);

        const multilineRow = await revealRow(page, 'user-multiline');
        await userBubble(multilineRow);
        await screenshot(page, `user-message-actions-bottom-${theme}`);
        await assertNoOverflow(page);
      });
    }

    test('info popover is readable, on top, and closes with Escape', async ({ page }) => {
      await openProjectChat(page, 'dark');
      const row = await revealRow(page, 'user-short');
      const bubble = await userBubble(row);

      await infoButton(bubble).click();
      const popover = metadataPopover(page);
      await expect(popover).toBeVisible();
      await expect(popover).toContainText('Time:');
      await expect(popover).toContainText('Words: 1');
      await expect(popover).toContainText('Characters: 2');
      await expect(infoButton(bubble)).toHaveAttribute('aria-expanded', 'true');
      await expectPopoverUsable(page, popover, scrollerOf(row));

      // "ok" is the narrowest bubble, hugging the right edge of the screen. The
      // popover opens below it, anchored to that edge and extending leftward.
      const popoverBox = await box(popover);
      expect(popoverBox.y).toBeGreaterThanOrEqual((await box(infoButton(bubble))).y);
      expect(
        Math.abs(popoverBox.x + popoverBox.width - (await contentRight(bubble)))
      ).toBeLessThanOrEqual(1);
      await screenshot(page, 'user-message-actions-info-open-dark');
      await assertNoOverflow(page);

      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
      await expect(infoButton(bubble)).toHaveAttribute('aria-expanded', 'false');
    });

    test('info on the newest message opens upward, clear of the composer', async ({ page }) => {
      await openProjectChat(page, 'light');
      const row = await revealRow(page, 'user-multiline');
      const bubble = await userBubble(row);

      await infoButton(bubble).click();
      const popover = metadataPopover(page);
      await expect(popover).toBeVisible();
      await expectPopoverUsable(page, popover, scrollerOf(row));
      // Below the newest message there is no room before the composer.
      const popoverBox = await box(popover);
      expect(popoverBox.y + popoverBox.height).toBeLessThanOrEqual(
        (await box(infoButton(bubble))).y
      );
      await screenshot(page, 'user-message-actions-info-newest-light');
    });

    test('copy puts the raw markdown on the clipboard', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openProjectChat(page, 'light');
      const row = await revealRow(page, 'user-long');
      const bubble = await userBubble(row);

      await copyButton(bubble).click();
      await expect(bubble.getByRole('button', { name: 'Copied' })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LONG_TEXT);
      await screenshot(page, 'user-message-actions-copied-light');
    });

    test('a message sent from the composer gets info + copy', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openProjectChat(page, 'dark');

      await page.locator('textarea[role="combobox"]').fill(SENT_TEXT);
      await page.getByRole('button', { name: 'Send', exact: true }).click();

      const sentRow = page.locator('[data-conversation-item-id^="optimistic-"]');
      await expect(sentRow).toHaveCount(1);
      await expect(sentRow).toContainText(SENT_TEXT);
      await screenshot(page, 'user-message-actions-sent-dark');
      const bubble = await userBubble(sentRow);

      await copyButton(bubble).click();
      await expect(bubble.getByRole('button', { name: 'Copied' })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(SENT_TEXT);
      await assertNoOverflow(page);
    });
  });
}

// ---------------------------------------------------------------------------
// Workspace chat without a linked project session
//
// Standalone workspaces fall back to the acp-client AgentPanel, which replays
// the conversation from the VM agent's socket. Its user bubble is the built-in
// solid blue one, so its actions use the light-on-dark icon palette.
// ---------------------------------------------------------------------------

const WORKSPACE_ID = 'ws-legacy-chat';
const AGENT_SESSION_ID = 'agent-session-legacy';
const WORKSPACE_PROJECT_ID = 'proj-legacy-chat';
const WORKSPACE_USER = makeMockUser({
  email: 'legacy@example.com',
  name: 'Legacy User',
  sessionId: 'auth-session-legacy',
  userId: 'user-legacy',
});

const WORKSPACE = {
  id: WORKSPACE_ID,
  name: 'legacy-chat',
  displayName: 'Legacy Chat Workspace',
  status: 'running',
  nodeId: 'node-legacy',
  projectId: WORKSPACE_PROJECT_ID,
  userId: 'user-legacy',
  vmSize: 'medium',
  vmLocation: 'nbg1',
  workspaceProfile: 'full',
  // The page derives the agent socket (ws://localhost:4173/agent/ws) from this.
  url: 'http://localhost:4173',
  portsPublic: false,
  chatSessionId: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:05:00.000Z',
};

const NODE = {
  id: 'node-legacy',
  name: 'legacy-node',
  status: 'running',
  healthStatus: 'healthy',
  vmSize: 'medium',
  vmLocation: 'nbg1',
  cloudProvider: 'hetzner',
  lastHeartbeatAt: '2026-10-01T10:05:00.000Z',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T10:05:00.000Z',
};

/** The desktop sidebar's resource meters read this. */
const NODE_SYSTEM_INFO = {
  cpu: { loadAvg1: 0.34, loadAvg5: 0.41, loadAvg15: 0.5, numCpu: 4 },
  memory: { usedBytes: 2.4e9, totalBytes: 8e9, availableBytes: 5.6e9, usedPercent: 30 },
  disk: {
    usedBytes: 42e9,
    totalBytes: 120e9,
    availableBytes: 78e9,
    usedPercent: 35,
    mountPath: '/',
  },
};

const AGENT_SESSION = {
  id: AGENT_SESSION_ID,
  workspaceId: WORKSPACE_ID,
  status: 'running',
  hostStatus: 'idle',
  label: 'Chat 1',
  agentType: 'claude-code',
  worktreePath: null,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:05:00.000Z',
};

function sessionUpdate(kind: 'user_message_chunk' | 'agent_message_chunk', text: string) {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'acp-legacy',
      update: { sessionUpdate: kind, content: { type: 'text', text } },
    },
  };
}

/** The prompt result that ends an agent turn (settles its streaming text). */
function turnEnded(id: number) {
  return { jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } };
}

const REPLAY = [
  sessionUpdate('user_message_chunk', SHORT_TEXT),
  sessionUpdate('agent_message_chunk', 'Sure — here is a short reply.'),
  turnEnded(1),
  sessionUpdate('user_message_chunk', LONG_TEXT),
  sessionUpdate('agent_message_chunk', 'Done. Anything else?'),
  turnEnded(2),
];

/** Serves the workspace page and replays the conversation over the agent socket. */
async function openWorkspaceChat(page: Page, theme: 'dark' | 'light') {
  await seedTheme(page, theme);
  await page.addInitScript(() =>
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-legacy', 'true')
  );

  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (body: unknown) => route.fulfill({ status: 200, json: body });
    if (path.includes('/api/auth/')) return json(WORKSPACE_USER);
    if (path.startsWith('/api/notifications')) return json({ notifications: [], unreadCount: 0 });
    if (path === '/api/terminal/token') {
      return json({
        token: 'workspace-token',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        workspaceUrl: WORKSPACE.url,
      });
    }
    if (path === `/api/workspaces/${WORKSPACE_ID}`) return json(WORKSPACE);
    if (path === `/api/workspaces/${WORKSPACE_ID}/agent-sessions`) return json([AGENT_SESSION]);
    if (path === '/api/workspaces') return json([WORKSPACE]);
    if (path === `/api/nodes/${NODE.id}`) return json(NODE);
    if (path === `/api/nodes/${NODE.id}/system-info`) return json(NODE_SYSTEM_INFO);
    if (path === '/api/projects') return json({ projects: [], nextCursor: null });
    if (path === '/api/trial/status') return json({ available: false });
    if (path === '/api/agents') return json({ agents: [] });
    if (path === '/api/github/installations') return json([]);
    return json({});
  });

  // Direct VM-agent HTTP calls go to the workspace URL.
  await page.route(`**/workspaces/${WORKSPACE_ID}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/api/')) return route.fallback();
    if (path.endsWith('/agent-sessions')) {
      return route.fulfill({ status: 200, json: { sessions: [AGENT_SESSION] } });
    }
    return route.fulfill({ status: 200, json: {} });
  });
  await page.route('**/terminal/ws**', (route) => route.abort());

  await page.routeWebSocket(/\/agent\/ws/, (ws) => {
    ws.onMessage((raw) => {
      try {
        const parsed = JSON.parse(String(raw));
        if (parsed?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {
        /* non-JSON frames are ignored */
      }
    });
    // What the VM agent sends a viewer that attaches to a running session.
    const frames = [
      {
        type: 'session_state',
        status: 'ready',
        agentType: 'claude-code',
        replayCount: REPLAY.length,
      },
      ...REPLAY,
      { type: 'session_replay_complete' },
    ];
    setTimeout(() => frames.forEach((frame) => ws.send(JSON.stringify(frame))), 50);
  });

  await page.goto(`/workspaces/${WORKSPACE_ID}?sessionId=${AGENT_SESSION_ID}`);
  // The newest user message is in view once the replay has rendered.
  await expect(workspaceUserBubble(page, /^Please review/)).toBeVisible({ timeout: 15_000 });
  await expectTheme(page, theme);
}

/**
 * The built-in solid blue user bubble holding this message text. Matches the
 * text element, because the bubble's own text also includes the info popover's
 * contents while it is open.
 */
function workspaceUserBubble(page: Page, text: RegExp) {
  return page.locator('.bg-blue-600').filter({ has: page.getByText(text) });
}

async function revealWorkspaceBubble(page: Page, text: RegExp): Promise<Locator> {
  const scroller = page
    .getByTestId('virtuoso-scroller')
    .filter({ has: page.locator('.bg-blue-600') });
  return reveal(workspaceUserBubble(page, text), scroller);
}

function runWorkspaceChatAudit(
  label: string,
  viewport: { width: number; height: number },
  isMobile: boolean
) {
  test.describe(`User Message Actions — Workspace chat — ${label}`, () => {
    test.use({ viewport, isMobile });

    for (const theme of ['dark', 'light'] as const) {
      test(`replayed user messages show info + copy (${theme})`, async ({ page }) => {
        await openWorkspaceChat(page, theme);

        const shortBubble = await revealWorkspaceBubble(page, /^ok$/);
        await expectUserActions(shortBubble);
        // Light-on-dark icons on the solid blue bubble, in either theme.
        expect(await infoButton(shortBubble).evaluate((el) => getComputedStyle(el).color)).toBe(
          'rgba(255, 255, 255, 0.7)'
        );

        const longBubble = await revealWorkspaceBubble(page, /^Please review/);
        await expectUserActions(longBubble);
        await expectTrailingActions(longBubble);
        await screenshot(page, `user-message-actions-workspace-${theme}`);
        await assertNoOverflow(page);
      });
    }

    test('info popover is readable and on top', async ({ page }) => {
      await openWorkspaceChat(page, 'dark');
      const bubble = await revealWorkspaceBubble(page, /^ok$/);
      await expectUserActions(bubble);

      await infoButton(bubble).click();
      const popover = metadataPopover(page);
      await expect(popover).toBeVisible();
      await expect(popover).toContainText('Words: 1');
      await expectPopoverUsable(page, popover, scrollerOf(bubble));
      await screenshot(page, 'user-message-actions-workspace-info-open-dark');
      await assertNoOverflow(page);
    });

    test('copy puts the raw markdown on the clipboard', async ({ page, context }) => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await openWorkspaceChat(page, 'light');
      const bubble = await revealWorkspaceBubble(page, /^Please review/);
      await expectUserActions(bubble);

      await copyButton(bubble).click();
      await expect(bubble.getByRole('button', { name: 'Copied' })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(LONG_TEXT);
    });
  });
}

runProjectChatAudit('Mobile (375x667)', { width: 375, height: 667 }, true);
runProjectChatAudit('Desktop (1280x800)', { width: 1280, height: 800 }, false);
runWorkspaceChatAudit('Mobile (375x667)', { width: 375, height: 667 }, true);
runWorkspaceChatAudit('Desktop (1280x800)', { width: 1280, height: 800 }, false);
