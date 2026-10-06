/**
 * Documentation screenshots for two chat states the docs teach a reader to recognise:
 * a sleeping chat whose wake failed, and an agent reply containing a Mermaid diagram.
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
 * The committed PNGs were then palette-compressed (about 5x smaller, no visible change), from
 * apps/www: sharp(file).png({ palette: true, quality: 90, effort: 10, dither: 0.6 }).
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { makeMockUser, seedTheme } from './audit-helpers';
import { fulfillDocsChatRoute, neighboringDocsSessions } from './docs-chat-fixtures';
import { docsShot } from './docs-shot';

const PROJECT_ID = 'proj-docs-states';

/**
 * Anchored to the real clock, not a fixed date: the UI renders relative times ("2m ago"),
 * so a fixed date would read "Just now" or "3d ago" depending on when the spec runs.
 */
const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

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
  taskStatus: 'in_progress' | 'completed' | 'failed';
  taskMode: 'task' | 'conversation';
  lastMessageAt: number;
  attention?: { kind: 'wake_failed'; reason: string };
  errorMessage?: string;
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

/** Neighbouring rows so the list shows Wake failed among the states it is compared with. */
const OTHER_SESSIONS: SessionFixture[] = neighboringDocsSessions(NOW);

function sessionPayload(fixture: SessionFixture) {
  const taskId = `task-${fixture.id}`;
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
      outputBranch: `sam/${fixture.id}`,
      outputPrUrl: null,
      errorMessage: fixture.errorMessage ?? null,
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

const MESSAGES: Record<string, ReturnType<typeof message>[]> = {
  [WAKE_FAILED.id]: wakeFailedMessages(),
  [DIAGRAM.id]: diagramMessages(),
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
async function setupMocks(page: Page) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);

  const sessions = ALL_SESSIONS.map(sessionPayload);

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    const { pathname } = new URL(url);

    if (pathname.endsWith('/ws') || url.includes('websocket')) return route.abort();

    return fulfillDocsChatRoute(route, {
      project: MOCK_PROJECT,
      user: MOCK_USER,
      sessions,
      messages: MESSAGES,
      state: sessionState(),
    });
  });
}

async function openChat(page: Page, sessionId: string) {
  await seedTheme(page, 'dark');
  await setupMocks(page);
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
