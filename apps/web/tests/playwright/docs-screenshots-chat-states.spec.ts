/**
 * Documentation screenshots for chat states the docs teach a reader to recognise: a sleeping
 * chat whose wake failed, an agent reply containing a Mermaid diagram, and a chat whose saved
 * workspace expired, with the fork it offers.
 *
 * Every capture drives the REAL production components with mocked API data, and asserts
 * on what rendered rather than on the fixture, so a component that stops rendering fails
 * the capture instead of producing a stale-looking image
 * (`.claude/rules/62-tests-must-observe-the-real-trigger.md`).
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-chat-states \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 *
 * The committed PNGs were then palette-compressed (about 5x smaller, no visible change) with
 * `pnpm --filter @simple-agent-manager/www compress:screenshots public/images/docs`.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { makeMockUser, seedTheme } from './audit-helpers';
import { fulfillDocsChatRoute, neighboringDocsSessions } from './docs-chat-fixtures';
import { docsShot } from './docs-shot';

const PROJECT_ID = '01KGW3FTJ8R5N2M7X4Q9B6C0VD';

/**
 * Anchored to the real clock, not a fixed date: the UI renders relative times ("2m ago"),
 * so a fixed date would read "Just now" or "3d ago" depending on when the spec runs.
 */
const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MOCK_USER = makeMockUser({
  email: 'docs@example.com',
  name: 'Docs User',
  sessionId: 'session-docs-states',
  userId: 'user-docs-states',
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

/**
 * The exact text ProjectData writes when a wake is refused:
 * `Wake failed: <refusal description> (<reason code>)` — see `wake-failure.ts` and
 * `session-recovery-refusals.ts`. A fixable reason is shown because it is the case the
 * guide teaches the reader to act on.
 */
const WAKE_FAILED_TEXT =
  'Wake failed: Cloud provider credentials are missing for this wake. (placement_credentials_missing)';

interface SessionFixture {
  id: string;
  topic: string;
  status: 'active' | 'sleeping' | 'stopped';
  taskStatus: 'in_progress' | 'completed' | 'failed' | 'cancelled';
  taskMode: 'task' | 'conversation';
  lastMessageAt: number;
  attention?: { kind: 'wake_failed'; reason: string };
  errorMessage?: string;
  terminalReason?: string;
  /** Realistic IDs and branch for scenes whose image shows them; defaults derive from `id`. */
  taskId?: string;
  outputBranch?: string;
}

const WAKE_FAILED: SessionFixture = {
  id: 'sess-wake-failed',
  topic: 'Rate-limit the public checkout endpoint',
  status: 'sleeping',
  taskStatus: 'in_progress',
  taskMode: 'conversation',
  lastMessageAt: NOW - 2 * MINUTE,
  attention: { kind: 'wake_failed', reason: 'wake_refused' },
};

const DIAGRAM: SessionFixture = {
  id: 'sess-diagram',
  topic: 'Explain the checkout request path',
  status: 'active',
  taskStatus: 'in_progress',
  taskMode: 'conversation',
  lastMessageAt: NOW - 4 * MINUTE,
};

/**
 * A conversation that slept past the seven-day retention: SAM cancels its task with this
 * terminal reason (`SNAPSHOT_EXPIRED_REASON`), and the chat offers a fork instead of a wake.
 */
const EXPIRED: SessionFixture = {
  // The fork scene shows these IDs and the branch, so they look like the real thing.
  id: '6f2c9e14-8b3d-4a7e-9c51-2d0e7f4a8b36',
  taskId: '01KH8ZQ4TR6M2N9V3X7B5C1D0E',
  outputBranch: 'sam/add-csv-export-orders-page',
  topic: 'Add a CSV export to the orders page',
  status: 'stopped',
  taskStatus: 'cancelled',
  taskMode: 'conversation',
  lastMessageAt: NOW - 8 * DAY,
  terminalReason: 'snapshot_expired',
};

/** Neighbouring rows so the list shows Wake failed among the states it is compared with. */
const OTHER_SESSIONS: SessionFixture[] = neighboringDocsSessions(NOW);

function sessionPayload(fixture: SessionFixture) {
  const taskId = fixture.taskId ?? `task-${fixture.id}`;
  return {
    id: fixture.id,
    projectId: PROJECT_ID,
    status: fixture.status,
    topic: fixture.topic,
    workspaceId: fixture.status === 'active' ? `ws-${fixture.id}` : null,
    agentSessionId: null,
    isIdle: false,
    isMine: true,
    isTerminated: false,
    agentCompletedAt: null,
    messageCount: 6,
    startedAt: fixture.lastMessageAt - HOUR,
    endedAt: null,
    createdAt: fixture.lastMessageAt - HOUR,
    lastMessageAt: fixture.lastMessageAt,
    taskId,
    agentType: 'claude-code',
    attention: fixture.attention
      ? {
          markerId: `marker-${fixture.id}`,
          kind: fixture.attention.kind,
          createdAt: fixture.lastMessageAt,
          expiresAt: null,
          reason: fixture.attention.reason,
          options: [],
        }
      : undefined,
    task: {
      id: taskId,
      status: fixture.taskStatus,
      // An asleep or live conversation is past provisioning; any earlier step would
      // (correctly) put the "Starting…" provisioning banner over the chat.
      executionStep: fixture.taskStatus === 'in_progress' ? 'running' : null,
      outputBranch: fixture.outputBranch ?? `sam/${fixture.id}`,
      outputPrUrl: null,
      errorMessage: fixture.errorMessage ?? null,
      terminalReason: fixture.terminalReason ?? null,
      outputSummary: null,
      finalizedAt: null,
      taskMode: fixture.taskMode,
      agentProfileHint: 'default',
    },
  };
}

const ALL_SESSIONS = [WAKE_FAILED, DIAGRAM, ...OTHER_SESSIONS];

function message(
  sessionId: string,
  id: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  createdAt: number
) {
  return { id, sessionId, role, content, toolMetadata: null, createdAt };
}

/** A finished turn, a sleep, then a follow-up whose wake was refused. */
function wakeFailedMessages() {
  const id = WAKE_FAILED.id;
  return [
    message(
      id,
      'wf-1',
      'user',
      'Rate-limit POST /checkout to 20 requests a minute per customer.',
      NOW - 3 * HOUR
    ),
    message(
      id,
      'wf-2',
      'assistant',
      'Done: `CheckoutRateLimiter` now returns 429 past the limit, and the new tests pass.',
      NOW - 3 * HOUR + 6 * MINUTE
    ),
    message(
      id,
      'wf-3',
      'user',
      'Also exempt our internal service tokens from the limit.',
      NOW - 3 * MINUTE
    ),
    message(id, 'wf-4', 'system', WAKE_FAILED_TEXT, NOW - 2 * MINUTE),
  ];
}

/** Mermaid is the documented way an agent draws in chat; this is the fence it sends. */
const MERMAID_REPLY = [
  'Here is the path a checkout request takes:',
  '',
  '```mermaid',
  'flowchart LR',
  '  B[Browser] -->|POST /checkout| R{Rate limiter}',
  '  R -->|allowed| P[Payments]',
  '  R -->|429| B',
  '  P --> L[(Ledger)]',
  '```',
  '',
  'The limiter sits in front of payments, so a throttled request never reaches the ledger.',
].join('\n');

function diagramMessages() {
  const id = DIAGRAM.id;
  return [
    message(
      id,
      'dg-1',
      'user',
      'Draw how a checkout request flows through our services.',
      NOW - 6 * MINUTE
    ),
    message(id, 'dg-2', 'assistant', MERMAID_REPLY, NOW - 4 * MINUTE),
  ];
}

function expiredMessages() {
  const id = EXPIRED.id;
  const start = EXPIRED.lastMessageAt - 20 * MINUTE;
  return [
    message(id, 'ex-1', 'user', 'Add a CSV export button to the orders page.', start),
    message(
      id,
      'ex-2',
      'assistant',
      'Added `ExportOrdersButton` and an `/orders/export.csv` route that streams the filtered orders. I have not pushed yet; tell me when to open a pull request.',
      EXPIRED.lastMessageAt
    ),
  ];
}

const MESSAGES: Record<string, ReturnType<typeof message>[]> = {
  [WAKE_FAILED.id]: wakeFailedMessages(),
  [DIAGRAM.id]: diagramMessages(),
  [EXPIRED.id]: expiredMessages(),
};

/** One VM profile, so the fork opens the ordinary composer rather than the profile wizard. */
const AGENT_PROFILES = {
  items: [{ id: 'profile-build', name: 'Build and test', agentType: 'claude-code', runtime: 'vm' }],
};

function sessionState() {
  return {
    activity: 'idle',
    activityAt: NOW - 2 * MINUTE,
    statusError: null,
    currentPlan: [],
    planUpdatedAt: null,
    promptStartedAt: null,
    agentType: 'claude-code',
    lastStopReason: null,
  };
}

/**
 * Own route table rather than `setupProjectChatMocks`: that helper serves one session for
 * every session route, and this capture needs several sessions in different states in the
 * list, each with its own transcript.
 */
/** Scene-specific responses by path, consulted before the shared ones. */
type RouteOverrides = Record<string, unknown>;

async function setupMocks(page: Page, fixtures: SessionFixture[], overrides: RouteOverrides) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);

  const sessions = fixtures.map(sessionPayload);

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    const { pathname } = new URL(url);

    if (pathname.endsWith('/ws') || url.includes('websocket')) return route.abort();
    if (pathname === `/api/projects/${PROJECT_ID}/agent-profiles`) {
      return route.fulfill({ status: 200, json: AGENT_PROFILES });
    }
    if (pathname === `/api/projects/${PROJECT_ID}/agent-profiles/picker`) {
      return route.fulfill({
        status: 200,
        json: { usage: [], hiddenProfileIds: [], usageWindowDays: 30 },
      });
    }
    if (pathname in overrides) return route.fulfill({ status: 200, json: overrides[pathname] });

    return fulfillDocsChatRoute(route, {
      project: MOCK_PROJECT,
      user: MOCK_USER,
      sessions,
      messages: MESSAGES,
      state: sessionState(),
    });
  });
}

async function openChat(
  page: Page,
  sessionId: string,
  fixtures = ALL_SESSIONS,
  overrides: RouteOverrides = {}
) {
  await seedTheme(page, 'dark');
  await setupMocks(page, fixtures, overrides);
  await page.goto(`/projects/${PROJECT_ID}/chat/${sessionId}`);
  // Liveness: without this, every capture below would happily screenshot a crash page.
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible({ timeout: 20000 });
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

// ---------------------------------------------------------------------------
// 1. A chat whose wake failed: the red list label and the reason in the chat
// ---------------------------------------------------------------------------

test('docs: wake failed in the session list and the chat', async ({ page }) => {
  test.skip(isMobile(page), 'desktop capture');
  // Narrowest desktop layout (lg starts at 1024px): the docs column scales this image down,
  // and a narrower capture keeps the red list label legible there.
  await page.setViewportSize({ width: 1060, height: 720 });
  await openChat(page, WAKE_FAILED.id);

  // The two things the guide tells the reader to look for, asserted where they render.
  const row = page.getByRole('button', { name: new RegExp(`Wake failed ${WAKE_FAILED.topic}`) });
  await expect(row).toBeVisible();
  await expect(row.locator('.text-danger-fg', { hasText: 'Wake failed' })).toBeVisible();
  await expect(
    page.getByRole('log', { name: 'Conversation' }).getByText(WAKE_FAILED_TEXT)
  ).toBeVisible();
  // A neighbouring sleeping chat must NOT carry the label, or the image teaches nothing.
  const sleepingRow = page.getByRole('button', { name: /Move invoice rendering to a queue/ });
  await expect(sleepingRow).toBeVisible();
  await expect(sleepingRow.getByText('Wake failed')).toHaveCount(0);
  // The reader is told the composer stays usable, so the image must show it.
  await expect(page.getByPlaceholder(/wake the agent/i)).toBeVisible();
  // The provisioning banner belongs to starting work, not to a chat that is asleep.
  await expect(page.getByText('Starting...')).toHaveCount(0);

  // Crop to the session list and the chat: the app navigation to their left is not what
  // the guide is about. (Focus mode would fold the list into an icon strip, hiding the
  // red label this image exists to show.)
  const listBox = await page.getByRole('navigation', { name: 'Chat sessions' }).boundingBox();
  const viewport = page.viewportSize();
  if (!listBox || !viewport) throw new Error('session list or viewport has no geometry');
  await docsShot(page, 'chat-wake-failed', {
    clip: { x: listBox.x, y: 0, width: viewport.width - listBox.x, height: viewport.height },
  });
});

/**
 * The same chat on a phone, where the desktop capture shrinks to unreadable text. The phone
 * layout shows the chat without the session list, so the reason in the chat is what it shows.
 */
test('docs: wake failed in the chat on a phone', async ({ page }) => {
  test.skip(!isMobile(page), 'phone capture');
  await openChat(page, WAKE_FAILED.id);

  await expect(
    page.getByRole('log', { name: 'Conversation' }).getByText(WAKE_FAILED_TEXT)
  ).toBeVisible();
  await expect(page.getByPlaceholder(/wake the agent/i)).toBeVisible();
  await expect(page.getByText('Starting...')).toHaveCount(0);

  await docsShot(page, 'chat-wake-failed-mobile');
});

// ---------------------------------------------------------------------------
// 2. A Mermaid diagram in an agent reply, with its controls
// ---------------------------------------------------------------------------

test('docs: mermaid diagram in chat', async ({ page }) => {
  test.skip(isMobile(page), 'desktop capture');
  await openChat(page, DIAGRAM.id);

  const diagram = page.getByTestId('mermaid-diagram');
  await expect(diagram).toBeVisible({ timeout: 20000 });
  // Rendered, not the streaming/code fallback and not the error card.
  await expect(page.getByTestId('mermaid-code-fallback')).toHaveCount(0);
  await expect(page.getByTestId('mermaid-diagram-error')).toHaveCount(0);
  await expect(diagram.locator('svg').first()).toBeVisible({ timeout: 20000 });
  // Labels are SVG text now; one from each end of the flow proves the whole graph drew.
  await expect(diagram.locator('svg').getByText('Browser')).toBeVisible();
  await expect(diagram.locator('svg').getByText('Ledger')).toBeVisible();
  for (const name of ['Copy Mermaid source', 'Reset diagram view', 'Expand Mermaid diagram']) {
    await expect(diagram.getByRole('button', { name })).toBeVisible();
  }

  // Just the agent's reply: the innermost element holding both the diagram and the
  // reply's own actions. A whole-log crop shrinks the diagram past legibility once the
  // docs column scales the image down.
  const reply = page
    .getByRole('log', { name: 'Conversation' })
    .locator('div')
    .filter({ has: diagram })
    .filter({ has: page.getByRole('button', { name: 'Copy message' }) })
    .last();
  await expect(reply).toContainText('never reaches the ledger');
  await docsShot(page, 'chat-mermaid-diagram', reply);
});

// ---------------------------------------------------------------------------
// 3. A chat whose saved workspace expired, and the fork it offers
// ---------------------------------------------------------------------------

/** Its own list, so the other scenes' session lists and committed images stay unchanged. */
const EXPIRED_LIST = [EXPIRED, ...OTHER_SESSIONS];

async function openExpiredChat(page: Page, overrides: RouteOverrides = {}) {
  await openChat(page, EXPIRED.id, EXPIRED_LIST, overrides);
  const footer = page.getByText(/The saved workspace has expired/);
  await expect(footer).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fork conversation' })).toBeVisible();
  // Liveness for the absence below: the transcript itself rendered.
  await expect(page.getByText(/ExportOrdersButton/)).toBeVisible();
  // The message box is replaced, not merely disabled.
  await expect(page.getByPlaceholder(/Send a message/)).toHaveCount(0);
}

test('docs: expired chat', async ({ page }) => {
  test.skip(isMobile(page), 'desktop capture');
  await page.setViewportSize({ width: 1060, height: 720 });
  await openExpiredChat(page);
  const log = await page.getByRole('log', { name: 'Conversation' }).boundingBox();
  const viewport = page.viewportSize();
  if (!log || !viewport) throw new Error('conversation or viewport has no geometry');
  // The chat column only: an eight-day-old chat sits in the collapsed Older group of the list.
  await docsShot(page, 'chat-expired', {
    clip: { x: log.x, y: 0, width: viewport.width - log.x, height: viewport.height },
  });
});

test('docs: expired chat on a phone', async ({ page }) => {
  test.skip(!isMobile(page), 'phone capture');
  await openExpiredChat(page);
  await docsShot(page, 'chat-expired-mobile');
});

/**
 * The session list as the real list route returns it: its task carries only identity and status
 * (`apps/api/src/routes/chat-session-list.ts`), so Fork takes no branch from it and its banner
 * shows none. Serving the richer detail shape here would put a branch on the banner that users
 * never see.
 */
function listPayload(fixtures: SessionFixture[]) {
  return fixtures.map(sessionPayload).map(({ task, ...session }) => ({
    ...session,
    task: { id: task.id, status: task.status, terminalReason: task.terminalReason },
  }));
}

async function forkExpiredChat(page: Page) {
  // Fork from the session tool rail, the guide's first path. The expired footer's own fork
  // control now depends on the session's stored status (`SessionFooter.tsx`), which this
  // fixture no longer matches: tasks/backlog/2026-10-21-docs-expired-chat-spec-drift.md.
  await openChat(page, EXPIRED.id, EXPIRED_LIST, {
    [`/api/projects/${PROJECT_ID}/sessions`]: {
      sessions: listPayload(EXPIRED_LIST),
      total: EXPIRED_LIST.length,
    },
    // A configured agent, or the new-chat composer is disabled and asks you to add one.
    '/api/agents': {
      agents: [{ id: 'claude-code', name: 'Claude Code', configured: true, supportsAcp: true }],
    },
  });
  await expect(page.getByText(/The saved workspace has expired/)).toBeVisible();
  await page.getByRole('button', { name: /^Fork — start a new task/ }).click();
  await expect(page.getByText(`Forking from: ${EXPIRED.topic}`)).toBeVisible();
  const composer = page
    .getByRole('combobox')
    .filter({ has: page.locator('textarea') })
    .or(page.locator('textarea'));
  await expect(composer.first()).toBeEnabled();
  await expect(composer.first()).toHaveValue(
    /Previous session: "Add a CSV export to the orders page"/
  );
  await expect(composer.first()).toHaveValue(new RegExp(`Parent session ID: ${EXPIRED.id}`));
  // The fork text is inserted once; a doubled insertion would tell the agent twice.
  const prefill = await composer.first().inputValue();
  expect(prefill.split('Previous session:')).toHaveLength(2);
  return composer.first();
}

async function captureForkComposer(page: Page, width: number, name: string) {
  await page.setViewportSize({ width, height: 760 });
  const composer = await forkExpiredChat(page);
  // Type the next instruction at the end, as the guide says; the box scrolls to the caret,
  // which brings the IDs into view above it.
  await composer.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Now add the same CSV export to the invoices page.');
  await expect(composer).toHaveValue(/invoices page\.$/);
  // From the Forking banner to the send hint: the chat column only.
  const banner = await page
    .getByRole('button', { name: 'Cancel fork/retry' })
    .locator('..')
    .boundingBox();
  const hint = await page.getByText('Press Ctrl+Enter to send').boundingBox();
  const viewport = page.viewportSize();
  if (!banner || !hint || !viewport) throw new Error('fork composer has no geometry');
  const x = banner.x - 16;
  const y = banner.y - 16;
  await docsShot(page, name, {
    clip: { x, y, width: viewport.width - x, height: hint.y + hint.height + 16 - y },
  });
}

/** Wide enough that the message box shows all three IDs above the added instruction. */
test('docs: fork composer', async ({ page }) => {
  test.skip(isMobile(page), 'desktop capture');
  await captureForkComposer(page, 1440, 'chat-fork-composer');
});

/**
 * The phone variant: a narrower desktop crop stays legible when a phone scales it down, which
 * the phone layout (composer below the starter prompts, two lines visible) does not.
 */
test('docs: fork composer, narrow', async ({ page }) => {
  test.skip(isMobile(page), 'desktop capture');
  await captureForkComposer(page, 1060, 'chat-fork-composer-mobile');
});
