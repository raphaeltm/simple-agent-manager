import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  screenshot,
  setupProjectChatMocks,
} from './audit-helpers';

const PROJECT_ID = 'project-acp-permissions';
const SESSION_ID = 'session-acp-permissions';
const TOOL_CALL_ID = 'tool-call-dangerous-command';
const ANCHORED_ID = '11111111-1111-4111-8111-111111111111';
const UNANCHORED_ID = '22222222-2222-4222-8222-222222222222';

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'ACP permission visual stress fixture',
  repository: 'sam/permission-fixture',
  repoProvider: 'github',
  createdAt: '2026-09-30T00:00:00Z',
  updatedAt: '2026-09-30T00:00:00Z',
};

function session(isMine: boolean) {
  return {
    id: SESSION_ID,
    workspaceId: null,
    taskId: 'task-permission-ui',
    topic:
      'Permission review with an intentionally long session title that validates wrapping on a narrow phone without clipping any controls',
    status: 'active',
    messageCount: 33,
    createdByUserId: 'owner-user',
    createdBy: {
      id: 'owner-user',
      name: 'Session Owner',
      email: 'owner@example.com',
      image: null,
      avatarUrl: null,
    },
    isMine,
    createdAt: Date.now() - 120_000,
    startedAt: Date.now() - 120_000,
    endedAt: null,
    cleanupAt: null,
    isIdle: false,
    agentCompletedAt: null,
    agentSessionId: 'agent-session-permission-fixture',
    agentType: 'openai-codex',
    attention: {
      markerId: 'attention-permission',
      kind: 'needs_input',
      createdAt: Date.now() - 20_000,
      expiresAt: null,
      reason: 'acp_interaction_pending',
      options: [],
    },
  };
}

const LONG_TOKEN = `https://example.com/${'permission-segment-'.repeat(18)}?payload=%3Cscript%3Ealert(1)%3C%2Fscript%3E`;

const MOCK_MESSAGES = [
  ...Array.from({ length: 30 }, (_, index) => ({
    id: `history-${index}`,
    sessionId: SESSION_ID,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content:
      index === 29
        ? `Please run the next operation after checking the exact permission. ${LONG_TOKEN}`
        : `Stress history message ${index + 1} — unicode ✅ 漢字 & <script>alert(1)</script>`,
    toolMetadata: null,
    createdAt: Date.now() - (90 - index) * 1_000,
    sequence: index + 1,
  })),
  {
    id: 'tool-start',
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: {
      toolCallId: TOOL_CALL_ID,
      title: 'Bash: deploy the release after reviewing the permission',
      kind: 'execute',
      status: 'in_progress',
      content: [],
    },
    createdAt: Date.now() - 8_000,
    sequence: 31,
  },
];

function ownerSnapshot() {
  const now = Date.now();
  return {
    pending: [
      {
        interactionId: ANCHORED_ID,
        kind: 'permission',
        state: 'pending',
        createdAt: now - 7_000,
        updatedAt: now - 7_000,
        deadlineAt: now + 90 * 60_000,
        answeredAt: null,
        deliveryState: null,
        attentionMarkerId: 'attention-permission',
        toolCallId: TOOL_CALL_ID,
      },
      {
        interactionId: UNANCHORED_ID,
        kind: 'permission',
        state: 'pending',
        createdAt: now - 6_000,
        updatedAt: now - 6_000,
        deadlineAt: now + 29 * 60_000,
        answeredAt: null,
        deliveryState: null,
        attentionMarkerId: 'attention-unanchored',
        toolCallId: null,
      },
    ],
    settled: [
      'delivery_confirmed',
      'delivery_unconfirmed',
      'expired',
      'cancelled',
      'interrupted',
    ].map((state, index) => ({
      interactionId: `33333333-3333-4333-8333-33333333333${index}`,
      kind: 'permission',
      state,
      createdAt: now - (index + 10) * 60_000,
      updatedAt: now - (index + 5) * 60_000,
      deadlineAt: now - (index + 1) * 60_000,
      answeredAt: state.startsWith('delivery') ? now - (index + 6) * 60_000 : null,
      deliveryState:
        state === 'delivery_confirmed'
          ? 'confirmed'
          : state === 'delivery_unconfirmed'
            ? 'unconfirmed'
            : null,
      attentionMarkerId: null,
      toolCallId: TOOL_CALL_ID,
    })),
    cursor: null,
  };
}

const DETAILS: Record<string, Record<string, unknown>> = {
  [ANCHORED_ID]: {
    title: 'Allow this command to modify deployment files? 🚀',
    description: `The agent supplied this long description and URL: ${LONG_TOKEN}`,
    options: [
      { id: 'reject-once-exact', kind: 'reject_once', name: 'Reject this operation once' },
      {
        id: 'allow-once-exact',
        kind: 'allow_once',
        name: 'Allow this exact operation once — no future commands',
      },
    ],
  },
  [UNANCHORED_ID]: {
    permissionName: 'Permission without a tool-call anchor',
    description: 'This request must remain visible at the conversation tail.',
    options: [
      { id: 'custom-safe-option', kind: 'custom', name: 'Continue with the bounded action' },
      { id: 'reject-unanchored', kind: 'reject_once', name: 'Do not continue' },
    ],
  },
};

async function setupPermissionMocks(page: Page, isMine: boolean) {
  const mockSession = session(isMine);
  await setupProjectChatMocks(page, {
    projectId: PROJECT_ID,
    project: MOCK_PROJECT,
    session: mockSession,
    messages: MOCK_MESSAGES,
    user: isMine
      ? { id: 'owner-user', name: 'Session Owner', email: 'owner@example.com' }
      : { id: 'member-user', name: 'Project Member', email: 'member@example.com' },
  });

  let snapshot = ownerSnapshot();
  const detailRequests: string[] = [];
  const answerBodies: unknown[] = [];
  let dropFirstAnswerReceipt = false;

  await page.route(
    `**/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/interactions`,
    (route: Route) => {
      if (!isMine) {
        return route.fulfill({
          status: 200,
          json: {
            pending: snapshot.pending.map(
              ({ interactionId, kind, state, createdAt, deadlineAt }) => ({
                interactionId,
                kind,
                state,
                createdAt,
                deadlineAt,
              })
            ),
            settled: [],
            cursor: null,
          },
        });
      }
      return route.fulfill({ status: 200, json: snapshot });
    }
  );

  await page.route(
    new RegExp(
      `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/interactions/([^/]+)(?:\\?.*)?$`
    ),
    (route: Route) => {
      const interactionId = new URL(route.request().url()).pathname.split('/').at(-1) ?? '';
      detailRequests.push(interactionId);
      if (!isMine) return route.fulfill({ status: 403, json: { error: 'FORBIDDEN' } });
      const summary = [...snapshot.pending, ...snapshot.settled].find(
        (item) => item.interactionId === interactionId
      );
      return route.fulfill({
        status: summary ? 200 : 404,
        json: summary
          ? { summary, detail: DETAILS[interactionId] ?? null }
          : { error: 'NOT_FOUND', message: 'Not found' },
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }
  );

  await page.route(
    new RegExp(
      `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/interactions/([^/]+)/answer(?:\\?.*)?$`
    ),
    async (route: Route) => {
      const body = route.request().postDataJSON();
      answerBodies.push(body);
      if (dropFirstAnswerReceipt) {
        dropFirstAnswerReceipt = false;
        return route.abort('connectionreset');
      }
      const interactionId = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
      const pending = snapshot.pending.find((item) => item.interactionId === interactionId);
      if (!pending) {
        return route.fulfill({
          status: 409,
          json: { error: 'CONFLICT', message: 'another decision is already committed' },
        });
      }
      snapshot = {
        ...snapshot,
        pending: snapshot.pending.filter((item) => item.interactionId !== interactionId),
        settled: [
          {
            ...pending,
            state: 'answered',
            answeredAt: Date.now(),
            updatedAt: Date.now(),
            deliveryState: 'pending',
          },
          ...snapshot.settled,
        ],
      };
      return route.fulfill({ status: 200, json: { accepted: true, state: 'answered' } });
    }
  );

  return {
    answerBodies,
    detailRequests,
    dropNextAnswerReceipt: () => {
      dropFirstAnswerReceipt = true;
    },
  };
}

async function openPermissionSurface(page: Page, isMine: boolean) {
  const evidence = await setupPermissionMocks(page, isMine);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  if (isMine) {
    await expect(page.getByText('Allow this command to modify deployment files? 🚀')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reject this operation once' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Allow this exact operation once — no future commands' })
    ).toBeVisible();
    await expect(page.locator('[aria-checked="true"]')).toHaveCount(0);
  } else {
    await expect(
      page.getByText('Waiting for the session creator to review this permission request.').first()
    ).toBeVisible();
  }
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
  return evidence;
}

async function positionAnchoredCardBelowStickyHeader(page: Page) {
  const card = page.getByTestId(`acp-permission-${ANCHORED_ID}`);
  await card.evaluate((element) => {
    let ancestor = element.parentElement;
    while (ancestor) {
      const overflowY = window.getComputedStyle(ancestor).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        ancestor.scrollBy({ top: -64 });
        return;
      }
      ancestor = ancestor.parentElement;
    }
  });
}

test.describe('ACP permission cards — Mobile', () => {
  test('renders anchored and unanchored owner requests with stress data', async ({ page }) => {
    await openPermissionSurface(page, true);
    await positionAnchoredCardBelowStickyHeader(page);
    await screenshot(page, 'acp-permission-chat-owner-mobile');
  });

  test('shows generic waiting only to a noncreator', async ({ page }) => {
    const evidence = await openPermissionSurface(page, false);
    expect(evidence.detailRequests).toEqual([]);
    await screenshot(page, 'acp-permission-chat-noncreator-mobile');
  });

  test('retries a lost receipt with the same exact idempotency body', async ({ page }) => {
    const evidence = await openPermissionSurface(page, true);
    evidence.dropNextAnswerReceipt();
    await page.getByRole('button', { name: 'Reject this operation once' }).click();
    await page.getByRole('button', { name: 'Retry Reject this operation once' }).click();
    await expect(page.getByText('Answer saved')).toBeVisible();
    expect(evidence.answerBodies).toHaveLength(2);
    expect(evidence.answerBodies[1]).toEqual(evidence.answerBodies[0]);
  });
});

test.describe('ACP permission cards — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('renders anchored and unanchored owner requests with stress data', async ({ page }) => {
    await openPermissionSurface(page, true);
    await screenshot(page, 'acp-permission-chat-owner-desktop');
  });

  test('shows generic waiting only to a noncreator', async ({ page }) => {
    const evidence = await openPermissionSurface(page, false);
    expect(evidence.detailRequests).toEqual([]);
    await screenshot(page, 'acp-permission-chat-noncreator-desktop');
  });
});
