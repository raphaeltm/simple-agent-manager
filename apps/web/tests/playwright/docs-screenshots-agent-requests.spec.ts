/**
 * Documentation screenshots for the cards an agent puts in the chat while it waits for the
 * person who started it — a permission request, a question, and a link to open — and for the
 * usage-limit details dialog opened from the chat header.
 *
 * Every capture drives the REAL production components with mocked API data, and asserts on what
 * rendered rather than on the fixture, so a component that stops rendering fails the capture
 * instead of producing a stale-looking image
 * (`.claude/rules/62-tests-must-observe-the-real-trigger.md`).
 *
 * The fixtures mirror what production sends. A permission card's title is the tool call's own
 * title (`session_host_interactions.go:permissionDetail`), which for a Claude Code command is the
 * command itself, and its options are the adapter's ("Yes", "Yes, and don't ask again for …",
 * "No"). A Claude Code question is its AskUserQuestion form: the question as the message, the
 * question's header as the field title, and a per-question "Other" box.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-agent-requests \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 *
 * The committed PNGs were then palette-compressed (no visible change), from apps/www:
 * sharp(file).png({ palette: true, quality: 90, effort: 10, dither: 0.6 }).
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { makeMockUser, seedTheme } from './audit-helpers';
import { fulfillDocsChatRoute, neighboringDocsSessions } from './docs-chat-fixtures';
import { docsShot, opaqueBackdrop } from './docs-shot';

const PROJECT_ID = 'proj-docs-requests';

/** Anchored to the real clock: the UI renders relative times and live countdowns. */
const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const MOCK_USER = makeMockUser({
  email: 'docs@example.com',
  name: 'Docs User',
  sessionId: 'session-docs-requests',
  userId: 'user-docs-requests',
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'acme/checkout-service',
  repository: 'acme/checkout-service',
  defaultBranch: 'main',
  userId: MOCK_USER.user.id,
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

interface SessionFixture {
  id: string;
  topic: string;
  status: 'active' | 'sleeping' | 'stopped';
  taskStatus: 'in_progress' | 'completed';
  taskMode: 'task' | 'conversation';
  lastMessageAt: number;
  needsInput?: boolean;
}

const PERMISSION: SessionFixture = {
  id: 'sess-permission',
  topic: 'Fix the flaky checkout tests',
  status: 'active',
  taskStatus: 'in_progress',
  taskMode: 'conversation',
  lastMessageAt: NOW - MINUTE,
  needsInput: true,
};

const QUESTION: SessionFixture = {
  id: 'sess-question',
  topic: 'Add receipt uploads to expenses',
  status: 'active',
  taskStatus: 'in_progress',
  taskMode: 'conversation',
  lastMessageAt: NOW - 2 * MINUTE,
  needsInput: true,
};

const LINK: SessionFixture = {
  id: 'sess-link',
  topic: 'Sync new customers from the CRM',
  status: 'active',
  taskStatus: 'in_progress',
  taskMode: 'conversation',
  lastMessageAt: NOW - 3 * MINUTE,
  needsInput: true,
};

const USAGE: SessionFixture = {
  id: 'sess-usage',
  topic: 'Speed up the order history page',
  status: 'active',
  taskStatus: 'in_progress',
  taskMode: 'conversation',
  lastMessageAt: NOW - 4 * MINUTE,
};

/** Neighbouring rows, so the list shows Needs input beside chats that are not waiting. */
const OTHER_SESSIONS: SessionFixture[] = neighboringDocsSessions(NOW);

/** The permission screenshot's list shows only the waiting chat among ordinary ones. */
const PERMISSION_LIST = [PERMISSION, USAGE, ...OTHER_SESSIONS];

function agentSessionId(fixture: SessionFixture): string {
  return `agent-${fixture.id}`;
}

function sessionPayload(fixture: SessionFixture) {
  const taskId = `task-${fixture.id}`;
  return {
    id: fixture.id,
    projectId: PROJECT_ID,
    status: fixture.status,
    topic: fixture.topic,
    workspaceId: fixture.status === 'active' ? `ws-${fixture.id}` : null,
    agentSessionId: fixture.status === 'active' ? agentSessionId(fixture) : null,
    isIdle: false,
    isMine: true,
    isTerminated: false,
    agentCompletedAt: null,
    messageCount: 4,
    startedAt: fixture.lastMessageAt - HOUR,
    endedAt: null,
    createdAt: fixture.lastMessageAt - HOUR,
    lastMessageAt: fixture.lastMessageAt,
    taskId,
    agentType: 'claude-code',
    // What the InteractionStore projects onto the chat while a request is pending
    // (`interaction-store.ts:projectAttention`).
    attention: fixture.needsInput
      ? {
          markerId: `marker-${fixture.id}`,
          kind: 'needs_input',
          createdAt: fixture.lastMessageAt,
          expiresAt: null,
          reason: 'acp_interaction_pending',
          options: [],
        }
      : undefined,
    task: {
      id: taskId,
      status: fixture.taskStatus,
      // A live conversation is past provisioning; an earlier step would (correctly) put the
      // "Starting…" provisioning banner over the chat.
      executionStep: fixture.taskStatus === 'in_progress' ? 'running' : null,
      outputBranch: `sam/${fixture.id}`,
      outputPrUrl: null,
      errorMessage: null,
      outputSummary: null,
      finalizedAt: null,
      taskMode: fixture.taskMode,
      agentProfileHint: 'default',
    },
  };
}

type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

function message(
  sessionId: string,
  id: string,
  role: MessageRole,
  content: string,
  createdAt: number,
  toolMetadata: Record<string, unknown> | null = null
) {
  return { id, sessionId, role, content, toolMetadata, createdAt };
}

function toolCall(sessionId: string, toolCallId: string, title: string, kind: string, at: number) {
  return message(sessionId, `tool-${toolCallId}`, 'tool', '(tool call)', at, {
    toolCallId,
    title,
    kind,
    status: 'pending',
    content: [],
  });
}

const PERMISSION_TOOL_CALL = 'toolu-npm-test';
const QUESTION_TOOL_CALL = 'toolu-ask-storage';
const STORAGE_QUESTION = 'Where should uploaded receipts be stored?';

const MESSAGES: Record<string, ReturnType<typeof message>[]> = {
  [PERMISSION.id]: [
    message(
      PERMISSION.id,
      'p-1',
      'user',
      'The checkout tests fail about one run in five. Find out why and fix it.',
      NOW - 4 * MINUTE
    ),
    message(
      PERMISSION.id,
      'p-2',
      'assistant',
      "I'll run the suite a few times first to see which tests are flaky.",
      NOW - 3 * MINUTE
    ),
    toolCall(PERMISSION.id, PERMISSION_TOOL_CALL, 'npm test', 'execute', NOW - 2 * MINUTE),
  ],
  [QUESTION.id]: [
    message(
      QUESTION.id,
      'q-1',
      'user',
      'Let people attach a photo of the receipt when they submit an expense.',
      NOW - 5 * MINUTE
    ),
    message(
      QUESTION.id,
      'q-2',
      'assistant',
      'Before I build the upload form, I need one decision from you.',
      NOW - 4 * MINUTE
    ),
    toolCall(QUESTION.id, QUESTION_TOOL_CALL, STORAGE_QUESTION, 'other', NOW - 3 * MINUTE),
  ],
  [LINK.id]: [
    message(
      LINK.id,
      'l-1',
      'user',
      'Import the customers created in the CRM this week and add them to the mailing list.',
      NOW - 6 * MINUTE
    ),
    message(
      LINK.id,
      'l-2',
      'assistant',
      "I'll read this week's new customers through the Northwind CRM tools.",
      NOW - 5 * MINUTE
    ),
  ],
  [USAGE.id]: [
    message(
      USAGE.id,
      'u-1',
      'user',
      'The order history page takes four seconds to load. Make it faster.',
      NOW - 8 * MINUTE
    ),
    message(
      USAGE.id,
      'u-2',
      'assistant',
      'The page runs one query per order. I batched them into a single query, and the page now loads in 300 ms.',
      NOW - 4 * MINUTE
    ),
  ],
};

const PERMISSION_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const QUESTION_ID = 'bbbbbbbb-2222-4222-8222-222222222222';
const LINK_ID = 'cccccccc-3333-4333-8333-333333333333';

interface InteractionFixture {
  summary: {
    interactionId: string;
    kind: 'permission' | 'form' | 'url';
    state: 'pending';
    createdAt: number;
    updatedAt: number;
    deadlineAt: number;
    answeredAt: null;
    deliveryState: null;
    attentionMarkerId: string;
    toolCallId: string | null;
    urlCompletedAt?: null;
  };
  detail: Record<string, unknown>;
}

const INTERACTIONS: Record<string, InteractionFixture> = {
  [PERMISSION.id]: {
    summary: {
      interactionId: PERMISSION_ID,
      kind: 'permission',
      state: 'pending',
      createdAt: NOW - 2 * MINUTE,
      updatedAt: NOW - 2 * MINUTE,
      // A conversation permission request waits up to two hours.
      deadlineAt: NOW + 2 * HOUR - 2 * MINUTE,
      answeredAt: null,
      deliveryState: null,
      attentionMarkerId: `marker-${PERMISSION.id}`,
      toolCallId: PERMISSION_TOOL_CALL,
    },
    // The runtime sends title, kind and options only — no description.
    detail: {
      toolCallId: PERMISSION_TOOL_CALL,
      title: 'npm test',
      toolKind: 'execute',
      options: [
        { id: 'allow-once', kind: 'allow_once', name: 'Yes' },
        {
          id: 'allow-with-updates',
          kind: 'allow_always',
          name: "Yes, and don't ask again for npm commands",
        },
        { id: 'reject', kind: 'reject_once', name: 'No' },
      ],
    },
  },
  [QUESTION.id]: {
    summary: {
      interactionId: QUESTION_ID,
      kind: 'form',
      state: 'pending',
      createdAt: NOW - 3 * MINUTE,
      updatedAt: NOW - 3 * MINUTE,
      deadlineAt: NOW + 2 * HOUR - 3 * MINUTE,
      answeredAt: null,
      deliveryState: null,
      attentionMarkerId: `marker-${QUESTION.id}`,
      // The runtime sends no tool-call ID for a question (`session_host_form.go`), so the card
      // renders at the end of the chat, after the AskUserQuestion step.
      toolCallId: null,
    },
    // Claude Code's AskUserQuestion form (`elicitation.js:askUserQuestionsToCreateRequest`).
    detail: {
      message: STORAGE_QUESTION,
      schema: {
        type: 'object',
        properties: {
          question_0: {
            type: 'string',
            title: 'Storage',
            oneOf: [
              {
                const: 'R2 bucket (Recommended)',
                title: 'R2 bucket (Recommended)',
                description: 'Private bucket; the app serves receipts through signed links.',
              },
              {
                const: 'Database column',
                title: 'Database column',
                description: 'Simplest, but large images slow down backups.',
              },
            ],
          },
          question_0_custom: {
            type: 'string',
            title: 'Other',
            description:
              'Type your own answer, or add a note to the option you chose above (optional).',
            _meta: {
              _askUserQuestionCustomAnswer: { questionId: 'question_0', isCustomAnswer: true },
            },
          },
        },
      },
    },
  },
  [LINK.id]: {
    summary: {
      interactionId: LINK_ID,
      kind: 'url',
      state: 'pending',
      createdAt: NOW - 4 * MINUTE,
      updatedAt: NOW - 4 * MINUTE,
      // A link request waits up to 10 minutes.
      deadlineAt: NOW + 6 * MINUTE,
      answeredAt: null,
      deliveryState: null,
      attentionMarkerId: `marker-${LINK.id}`,
      toolCallId: null,
      urlCompletedAt: null,
    },
    detail: {
      message:
        'Northwind CRM needs you to approve access before the agent can read your customer records.',
      url: 'https://mcp.northwind-crm.com/approve?request=7f3c2e91',
      elicitationId: 'opaque',
    },
  },
};

/** Claude Max windows at a Warning level, so the dialog shows the colour the guide describes. */
const USAGE_CREDENTIAL = {
  credentialReference: 'cc_credentials:cred-claude',
  credentialId: 'cred-claude',
  credentialSource: 'user',
  provider: 'anthropic',
  providerMode: 'direct',
  agentType: 'claude-code',
  level: 'warning',
  observedAt: NOW - 4 * MINUTE,
  windows: [
    {
      windowType: 'claude.five_hour',
      provider: 'anthropic',
      source: 'claude-acp.rate_limit',
      status: 'allowed',
      level: 'warning',
      utilizationPercent: 78,
      limitAmount: null,
      remainingAmount: null,
      windowMinutes: 300,
      resetsAt: NOW + 2 * HOUR + 10 * MINUTE,
      observedAt: NOW - 4 * MINUTE,
      updatedAt: NOW - 4 * MINUTE,
    },
    {
      windowType: 'claude.seven_day',
      provider: 'anthropic',
      source: 'claude-acp.rate_limit',
      status: 'allowed',
      level: 'ok',
      utilizationPercent: 31,
      limitAmount: null,
      remainingAmount: null,
      windowMinutes: 10080,
      resetsAt: NOW + 3 * 24 * HOUR,
      observedAt: NOW - 4 * MINUTE,
      updatedAt: NOW - 4 * MINUTE,
    },
  ],
};

function sessionState() {
  return {
    activity: 'prompting',
    activityAt: NOW - MINUTE,
    statusError: null,
    currentPlan: [],
    planUpdatedAt: null,
    promptStartedAt: NOW - 4 * MINUTE,
    agentType: 'claude-code',
    lastStopReason: null,
  };
}

/**
 * Own route table rather than `setupProjectChatMocks`: that helper serves one session for every
 * session route, and these captures need several sessions in the list, each with its own
 * transcript, pending request, and usage reading.
 */
async function setupMocks(page: Page, listed: SessionFixture[]) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);

  const sessions = listed.map(sessionPayload);

  // Hold the ProjectData socket open so a live chat reports a connection. An aborted socket
  // shows "Reconnecting...", which would teach the reader a fault the scene does not have.
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

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;
    const json = (body: unknown) => route.fulfill({ status: 200, json: body });

    if (pathname.endsWith('/ws') || url.href.includes('websocket')) return route.abort();

    // The usage chip reads the credential the chat's agent session is attributed to.
    if (pathname === `/api/projects/${PROJECT_ID}/credential-limits`) {
      const forUsage = url.searchParams.get('agentSessionId') === agentSessionId(USAGE);
      return json({ credentials: forUsage ? [USAGE_CREDENTIAL] : [], generatedAt: NOW });
    }

    const interactions = pathname.match(
      new RegExp(`^/api/projects/${PROJECT_ID}/sessions/([^/]+)/interactions(?:/([^/]+))?$`)
    );
    if (interactions) {
      const [, sessionId, interactionId] = interactions;
      const fixture = INTERACTIONS[sessionId ?? ''];
      if (!interactionId) {
        return json({ pending: fixture ? [fixture.summary] : [], settled: [], cursor: null });
      }
      if (fixture && fixture.summary.interactionId === interactionId) {
        return route.fulfill({
          status: 200,
          json: { summary: fixture.summary, detail: fixture.detail },
          headers: { 'Cache-Control': 'private, no-store' },
        });
      }
      return route.fulfill({ status: 404, json: { error: 'NOT_FOUND', message: 'Not found' } });
    }

    return fulfillDocsChatRoute(route, {
      project: MOCK_PROJECT,
      user: MOCK_USER,
      sessions,
      messages: MESSAGES,
      state: sessionState(),
    });
  });
}

async function openChat(page: Page, fixture: SessionFixture, listed: SessionFixture[]) {
  await seedTheme(page, 'dark');
  await setupMocks(page, listed);
  await page.goto(`/projects/${PROJECT_ID}/chat/${fixture.id}`);
  // Liveness: without this, every capture below would happily screenshot a crash page.
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible({ timeout: 20000 });
  // The provisioning banner belongs to starting work, not to a running conversation.
  await expect(page.getByText('Starting...')).toHaveCount(0);
  await expect(page.getByText('Reconnecting...')).toHaveCount(0);
  await expectNoOverflow(page);
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width
  );
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

/**
 * A card crop on a phone needs the whole card inside the visible conversation: at 375x667 a
 * question or link card is taller than the space between the header and the composer, so the
 * crop caught the composer and the scroll button and cut the card off. Height does not change
 * a card's layout at a given width, so a tall phone viewport gives a faithful 375-wide card.
 */
async function fitCardOnPhone(page: Page) {
  if (isMobile(page)) await page.setViewportSize({ width: 375, height: 1200 });
}

/**
 * For a crop of one card: the agent's turn is still open while it waits, so the completion dock —
 * the floating Interrupt button and the crest behind it — sits over the end of the conversation,
 * which is where the card is. It is not part of the card, so it is hidden once the test has seen it.
 */
async function hideCompletionDock(page: Page) {
  const interrupt = page.getByRole('button', { name: 'Interrupt agent' });
  await expect(interrupt).toBeVisible();
  await interrupt.evaluate((button) => {
    const dock = button.closest<HTMLElement>('div.shrink-0.pointer-events-none') ?? button;
    dock.style.visibility = 'hidden';
  });
  await expect(interrupt).toBeHidden();
}

/** The permission card for the `npm test` step, with all three of the agent's options. */
async function expectPermissionCard(page: Page) {
  const card = page.getByTestId(`acp-permission-${PERMISSION_ID}`);
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card.getByRole('heading', { name: 'npm test' })).toBeVisible();
  await expect(card.getByText('Permission needed')).toBeVisible();
  await expect(card.getByText(/\d+h( \d+m)? remaining|\d+m remaining/)).toBeVisible();
  for (const name of ['Yes', "Yes, and don't ask again for npm commands", 'No']) {
    await expect(card.getByRole('button', { name, exact: true })).toBeEnabled();
  }
  return card;
}

// ---------------------------------------------------------------------------
// 1. A permission request: Needs input in the list, the card under its step
// ---------------------------------------------------------------------------

test('docs: permission request in the session list and the chat', async ({ page }) => {
  // Only the desktop project captures this scene; phone coverage uses the dedicated capture.
  test.skip(isMobile(page), 'desktop capture');
  // Narrowest desktop layout (lg starts at 1024px): the docs column scales this image down,
  // and a narrower capture keeps the list label and the buttons legible there. Tall enough to
  // keep the user's request in view above the agent's reply and the card.
  await page.setViewportSize({ width: 1060, height: 860 });
  await openChat(page, PERMISSION, PERMISSION_LIST);

  // The label the guide tells the reader to look for, on the waiting chat only.
  const row = page.getByRole('button', { name: new RegExp(`Needs input ${PERMISSION.topic}`) });
  await expect(row).toBeVisible();
  await expect(row.locator('.text-warning-fg', { hasText: 'Needs input' })).toBeVisible();
  const otherRow = page.getByRole('button', { name: new RegExp(USAGE.topic) });
  await expect(otherRow).toBeVisible();
  await expect(otherRow.getByText('Needs input')).toHaveCount(0);

  const card = await expectPermissionCard(page);
  // Anchored under the step it belongs to, not floating at the end of the chat.
  await expect(card).toHaveAttribute('data-tool-call-id', PERMISSION_TOOL_CALL);

  // Crop to the session list and the chat: the app navigation to their left is not what the
  // guide is about.
  const listBox = await page.getByRole('navigation', { name: 'Chat sessions' }).boundingBox();
  const viewport = page.viewportSize();
  if (!listBox || !viewport) throw new Error('session list or viewport has no geometry');
  await expectNoOverflow(page);
  await docsShot(page, 'chat-permission-request', {
    clip: { x: listBox.x, y: 0, width: viewport.width - listBox.x, height: viewport.height },
  });
});

/**
 * The same request on a phone, where the desktop capture shrinks to unreadable text. A
 * 375x812 phone (rather than the project's 375x667) shows the agent's whole reply above the
 * step: at the shorter height the floating header cut a message's "Comment" link in half,
 * which reads as a rendering bug in a still image.
 */
test('docs: permission request on a phone', async ({ page }) => {
  // Only phone projects capture this scene; desktop coverage uses the session-list capture.
  test.skip(!isMobile(page), 'phone capture');
  await page.setViewportSize({ width: 375, height: 812 });
  await openChat(page, PERMISSION, PERMISSION_LIST);
  const card = await expectPermissionCard(page);
  await card.scrollIntoViewIfNeeded();
  await expectNoOverflow(page);
  await docsShot(page, 'chat-permission-request-mobile');
});

// ---------------------------------------------------------------------------
// 2. A question (form) and 3. a link to open
// ---------------------------------------------------------------------------

test('docs: agent question card', async ({ page }) => {
  await fitCardOnPhone(page);
  await openChat(page, QUESTION, [QUESTION, ...OTHER_SESSIONS]);

  const card = page.getByTestId(`acp-form-${QUESTION_ID}`);
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card.getByRole('heading', { name: 'Agent question' })).toBeVisible();
  await expect(card.getByText(STORAGE_QUESTION)).toBeVisible();
  // Pick the recommended option so the image shows its description, as the guide says.
  await card.getByLabel('Storage').selectOption({ label: 'R2 bucket (Recommended)' });
  await expect(
    card.getByText('Private bucket; the app serves receipts through signed links.')
  ).toBeVisible();
  await expect(card.getByLabel('Other')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Send answer' })).toBeEnabled();
  await expect(card.getByRole('button', { name: 'Decline' })).toBeEnabled();

  await card.scrollIntoViewIfNeeded();
  await hideCompletionDock(page);
  await expectNoOverflow(page);
  await docsShot(page, isMobile(page) ? 'chat-agent-question-mobile' : 'chat-agent-question', card);
});

test('docs: external link request card', async ({ page }) => {
  await fitCardOnPhone(page);
  await openChat(page, LINK, [LINK, ...OTHER_SESSIONS]);

  const card = page.getByTestId(`acp-url-${LINK_ID}`);
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card.getByRole('heading', { name: 'External service request' })).toBeVisible();
  await expect(card.getByText('Destination: mcp.northwind-crm.com')).toBeVisible();
  await expect(card.getByRole('link', { name: 'Open mcp.northwind-crm.com' })).toBeVisible();
  // The guide says Continue only becomes available after the link is opened.
  await expect(card.getByRole('button', { name: 'Continue after opening' })).toBeDisabled();
  await expect(card.getByRole('button', { name: 'Decline' })).toBeEnabled();

  await card.scrollIntoViewIfNeeded();
  await hideCompletionDock(page);
  await expectNoOverflow(page);
  await docsShot(
    page,
    isMobile(page) ? 'chat-external-link-request-mobile' : 'chat-external-link-request',
    card
  );
});

// ---------------------------------------------------------------------------
// 4. The usage-limit details dialog opened from the chat header
// ---------------------------------------------------------------------------

test('docs: usage limits dialog from the chat header', async ({ page }) => {
  await openChat(page, USAGE, [USAGE, ...OTHER_SESSIONS]);

  const chip = page.getByTestId('credential-limit-chip');
  await expect(chip).toBeVisible({ timeout: 20000 });
  await expect(chip).toHaveText('Claude · 5h 78% · Week 31%');
  await chip.click();

  const details = page.getByTestId('credential-limit-details');
  await expect(details).toBeVisible();
  await expect(details.getByRole('heading', { name: 'Claude usage' })).toBeVisible();
  await expect(details.getByText('Warning')).toBeVisible();
  const windows = details.getByTestId('credential-limit-window');
  await expect(windows).toHaveCount(2);
  await expect(windows.nth(0)).toContainText('5h');
  await expect(windows.nth(0)).toContainText('78% used');
  // NOW is taken when the module loads, so the countdown can read a minute or so less.
  await expect(windows.nth(0)).toContainText(/resets in 2h \d+m/);
  await expect(windows.nth(1)).toContainText('Week');
  await expect(windows.nth(1)).toContainText('31% used');

  await opaqueBackdrop(page);
  const panel = page.locator('.glass-panel-container').filter({ has: details });
  await expectNoOverflow(page);
  await docsShot(
    page,
    isMobile(page) ? 'credential-usage-limits-mobile' : 'credential-usage-limits',
    panel
  );
});
