import { expect, type Locator, type Page, type Route, test } from '@playwright/test';

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
      'answered',
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

type PermissionBackend = {
  answerBodies: unknown[];
  detailRequests: string[];
  dropFirstAnswerReceipt: boolean;
  holdSnapshot: boolean;
  snapshotFailureStatus: 401 | 403 | null;
  snapshotRequests: number;
  initialSnapshot: ReturnType<typeof ownerSnapshot>;
  snapshot: ReturnType<typeof ownerSnapshot>;
};

function createPermissionBackend(): PermissionBackend {
  const snapshot = ownerSnapshot();
  return {
    answerBodies: [],
    detailRequests: [],
    dropFirstAnswerReceipt: false,
    holdSnapshot: false,
    snapshotFailureStatus: null,
    snapshotRequests: 0,
    initialSnapshot: snapshot,
    snapshot,
  };
}

async function setupPermissionMocks(
  page: Page,
  isMine: boolean,
  backend = createPermissionBackend(),
  detailFailureStatus?: 403 | 500
) {
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

  await page.route(
    `**/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/interactions`,
    (route: Route) => {
      backend.snapshotRequests += 1;
      if (backend.snapshotFailureStatus) {
        return route.fulfill({
          status: backend.snapshotFailureStatus,
          json: { error: 'FORBIDDEN', message: 'Forbidden' },
        });
      }
      const visibleSnapshot = backend.holdSnapshot ? backend.initialSnapshot : backend.snapshot;
      if (!isMine) {
        return route.fulfill({
          status: 200,
          json: {
            pending: visibleSnapshot.pending.map(
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
      return route.fulfill({ status: 200, json: visibleSnapshot });
    }
  );

  await page.route(
    new RegExp(
      `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/interactions/([^/]+)(?:\\?.*)?$`
    ),
    (route: Route) => {
      const interactionId = new URL(route.request().url()).pathname.split('/').at(-1) ?? '';
      backend.detailRequests.push(interactionId);
      if (!isMine) return route.fulfill({ status: 403, json: { error: 'FORBIDDEN' } });
      if (detailFailureStatus) {
        return route.fulfill({
          status: detailFailureStatus,
          json: {
            error: detailFailureStatus === 403 ? 'FORBIDDEN' : 'INTERNAL_ERROR',
            message: detailFailureStatus === 403 ? 'Forbidden' : 'Detail temporarily unavailable',
          },
        });
      }
      const summary = [...backend.snapshot.pending, ...backend.snapshot.settled].find(
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
      backend.answerBodies.push(body);
      if (backend.dropFirstAnswerReceipt) {
        backend.dropFirstAnswerReceipt = false;
        return route.abort('connectionreset');
      }
      const interactionId = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
      const pending = backend.snapshot.pending.find((item) => item.interactionId === interactionId);
      if (!pending) {
        backend.holdSnapshot = false;
        return route.fulfill({
          status: 409,
          json: { error: 'CONFLICT', message: 'another decision is already committed' },
        });
      }
      backend.snapshot = {
        ...backend.snapshot,
        pending: backend.snapshot.pending.filter((item) => item.interactionId !== interactionId),
        settled: [
          {
            ...pending,
            state: 'answered',
            answeredAt: Date.now(),
            updatedAt: Date.now(),
            deliveryState: 'pending',
          },
          ...backend.snapshot.settled,
        ],
      };
      return route.fulfill({ status: 200, json: { accepted: true, state: 'answered' } });
    }
  );

  return {
    answerBodies: backend.answerBodies,
    backend,
    detailRequests: backend.detailRequests,
    revokeSnapshotAccess: () => {
      backend.snapshotFailureStatus = 403;
    },
    dropNextAnswerReceipt: () => {
      backend.dropFirstAnswerReceipt = true;
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
    await expect(page.getByText('Permission without a tool-call anchor')).toBeAttached();
    for (const label of [
      'Answer saved',
      'Delivered to agent',
      'Delivery unconfirmed',
      'Request expired',
      'Request cancelled',
      'Request interrupted',
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeAttached();
    }

    const anchored = page.getByTestId(`acp-permission-${ANCHORED_ID}`);
    const anchoredRow = anchored.locator('xpath=ancestor::*[@data-conversation-item-id][1]');
    await expect(anchoredRow.getByText('1 tool call', { exact: false })).toBeAttached();
    await expect(anchored).toHaveAttribute('data-tool-call-id', TOOL_CALL_ID);
    const unanchored = page.getByTestId(`acp-permission-${UNANCHORED_ID}`);
    await expect(unanchored).not.toHaveAttribute('data-tool-call-id', /.+/u);
    await expect(unanchored.locator('xpath=ancestor::*[@data-conversation-item-id]')).toHaveCount(
      0
    );
    const anchoredHandle = await anchored.elementHandle();
    const unanchoredHandle = await unanchored.elementHandle();
    expect(
      await page.evaluate(
        ([first, second]) =>
          Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING),
        [anchoredHandle!, unanchoredHandle!] as const
      )
    ).toBe(true);
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
  const header = page.getByTestId('session-floating-header');
  await card.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.evaluate(
    ([cardElement, headerElement]) => {
      let ancestor = cardElement.parentElement;
      while (ancestor) {
        const overflowY = window.getComputedStyle(ancestor).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') {
          const desiredTop = headerElement.getBoundingClientRect().bottom + 16;
          const currentTop = cardElement.getBoundingClientRect().top;
          ancestor.scrollBy({ top: currentTop - desiredTop });
          return;
        }
        ancestor = ancestor.parentElement;
      }
    },
    [(await card.elementHandle())!, (await header.elementHandle())!] as const
  );
  await expect
    .poll(async () => {
      const cardBox = await card.boundingBox();
      const headerBox = await header.boundingBox();
      return cardBox && headerBox ? cardBox.y - (headerBox.y + headerBox.height) : -1;
    })
    .toBeGreaterThanOrEqual(12);
}

async function assertPermissionHitTargetsClearOfJumpButton(page: Page) {
  const jumpButton = page.getByRole('button', { name: 'Scroll to bottom' });
  const optionButtons = page
    .getByTestId(`acp-permission-${ANCHORED_ID}`)
    .getByTestId('acp-permission-options')
    .getByRole('button');
  const count = await optionButtons.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    const option = optionButtons.nth(index);
    await option.scrollIntoViewIfNeeded();
    await expect(option).toBeVisible();
    await expect(jumpButton).toBeVisible();
    const jumpBox = await jumpButton.boundingBox();
    const optionBox = await option.boundingBox();
    expect(jumpBox).not.toBeNull();
    expect(optionBox).not.toBeNull();
    expect(optionBox!.height).toBeGreaterThanOrEqual(44);
    expect(optionBox!.width).toBeGreaterThanOrEqual(44);
    const horizontalOverlap = Math.max(
      0,
      Math.min(optionBox!.x + optionBox!.width, jumpBox!.x + jumpBox!.width) -
        Math.max(optionBox!.x, jumpBox!.x)
    );
    const verticalOverlap = Math.max(
      0,
      Math.min(optionBox!.y + optionBox!.height, jumpBox!.y + jumpBox!.height) -
        Math.max(optionBox!.y, jumpBox!.y)
    );
    expect(horizontalOverlap * verticalOverlap).toBe(0);
    const optionId = await option.getAttribute('data-option-id');
    expect(
      await page.evaluate(
        ({ x, y, expectedOptionId }) => {
          const hit = document.elementFromPoint(x, y);
          return hit?.closest('button')?.getAttribute('data-option-id') === expectedOptionId;
        },
        {
          x: optionBox!.x + optionBox!.width / 2,
          y: optionBox!.y + optionBox!.height / 2,
          expectedOptionId: optionId,
        }
      )
    ).toBe(true);
  }
}

async function alignWithJumpButton(page: Page, target: Locator) {
  await expect(page.getByRole('button', { name: 'Scroll to bottom' })).toBeVisible();
  await target.evaluate((element) => {
    const jumpButton = document.querySelector<HTMLElement>('[aria-label="Scroll to bottom"]');
    if (!jumpButton) throw new Error('Jump-to-latest button is missing');
    let ancestor = element.parentElement;
    while (ancestor) {
      const overflowY = window.getComputedStyle(ancestor).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        ancestor.scrollBy({
          top: element.getBoundingClientRect().top - jumpButton.getBoundingClientRect().top,
        });
        return;
      }
      ancestor = ancestor.parentElement;
    }
    throw new Error('Scrollable conversation ancestor is missing');
  });
}

async function assertTextClearOfJumpButton(page: Page) {
  const jumpButton = page.getByRole('button', { name: 'Scroll to bottom' });
  const answeredCard = page.locator('[data-interaction-state="answered"]').first();
  const description = answeredCard.getByTestId('acp-permission-status-description');
  await alignWithJumpButton(page, description);
  await expect(description).toBeVisible();
  await expect(jumpButton).toBeVisible();

  const overlapArea = await description.evaluate((element) => {
    const jump = document.querySelector<HTMLElement>('[aria-label="Scroll to bottom"]');
    if (!jump) throw new Error('Jump-to-latest button is missing');
    const jumpBox = jump.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()].reduce((total, textBox) => {
      const width = Math.max(
        0,
        Math.min(textBox.right, jumpBox.right) - Math.max(textBox.left, jumpBox.left)
      );
      const height = Math.max(
        0,
        Math.min(textBox.bottom, jumpBox.bottom) - Math.max(textBox.top, jumpBox.top)
      );
      return total + width * height;
    }, 0);
  });
  expect(overlapArea).toBe(0);
}

async function assertRetryControlClearOfJumpButton(page: Page) {
  const jumpButton = page.getByRole('button', { name: 'Scroll to bottom' });
  const retryButton = page.getByRole('button', { name: 'Retry Reject this operation once' });
  await alignWithJumpButton(page, retryButton);
  await expect(retryButton).toBeVisible();
  await expect(jumpButton).toBeVisible();
  const jumpBox = await jumpButton.boundingBox();
  const retryBox = await retryButton.boundingBox();
  expect(jumpBox).not.toBeNull();
  expect(retryBox).not.toBeNull();
  const horizontalOverlap = Math.max(
    0,
    Math.min(retryBox!.x + retryBox!.width, jumpBox!.x + jumpBox!.width) -
      Math.max(retryBox!.x, jumpBox!.x)
  );
  const verticalOverlap = Math.max(
    0,
    Math.min(retryBox!.y + retryBox!.height, jumpBox!.y + jumpBox!.height) -
      Math.max(retryBox!.y, jumpBox!.y)
  );
  expect(horizontalOverlap * verticalOverlap).toBe(0);
}

async function openDetailFailureSurface(page: Page, status: 403 | 500) {
  await setupPermissionMocks(page, true, createPermissionBackend(), status);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  const anchored = page.getByTestId(`acp-permission-${ANCHORED_ID}`);
  await expect(
    anchored.getByText(
      status === 403
        ? 'You no longer have access to view or answer this request.'
        : 'Secure permission details are unavailable. No option was inferred.'
    )
  ).toBeVisible();
  if (status === 500) {
    await expect(anchored.getByRole('button', { name: 'Retry details' })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Reject this operation once' })).toHaveCount(0);
  await positionAnchoredCardBelowStickyHeader(page);
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
}

test.describe('ACP permission cards — Mobile', () => {
  test('renders anchored and unanchored owner requests with stress data', async ({ page }) => {
    await openPermissionSurface(page, true);
    await positionAnchoredCardBelowStickyHeader(page);
    await assertPermissionHitTargetsClearOfJumpButton(page);
    await assertTextClearOfJumpButton(page);
    await positionAnchoredCardBelowStickyHeader(page);
    await screenshot(page, 'acp-permission-chat-owner-mobile');
  });

  test('removes already-rendered secure detail after snapshot authorization is revoked', async ({
    page,
  }) => {
    const evidence = await openPermissionSurface(page, true);
    expect(evidence.detailRequests.length).toBeGreaterThan(0);
    evidence.revokeSnapshotAccess();

    await expect(page.getByText('Allow this command to modify deployment files? 🚀')).toHaveCount(
      0,
      { timeout: 5_000 }
    );
    await expect(
      page.getByRole('button', { name: 'Allow this exact operation once — no future commands' })
    ).toHaveCount(0);
    expect(evidence.backend.snapshotRequests).toBeGreaterThanOrEqual(2);
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
    await assertRetryControlClearOfJumpButton(page);
    await screenshot(page, 'acp-permission-chat-retry-mobile');
    await page.getByRole('button', { name: 'Retry Reject this operation once' }).click();
    await expect(page.getByTestId(`acp-permission-${ANCHORED_ID}`)).toHaveAttribute(
      'data-interaction-state',
      'answered'
    );
    expect(evidence.answerBodies).toHaveLength(2);
    expect(evidence.answerBodies[1]).toEqual(evidence.answerBodies[0]);
  });

  test('refreshes both tabs to the canonical answer after a conflict', async ({
    page,
    context,
  }) => {
    const backend = createPermissionBackend();
    backend.holdSnapshot = true;
    const otherTab = await context.newPage();
    await setupPermissionMocks(page, true, backend);
    await setupPermissionMocks(otherTab, true, backend);
    await Promise.all([
      page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`),
      otherTab.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`),
    ]);
    await expect(
      page.getByRole('button', { name: 'Allow this exact operation once — no future commands' })
    ).toBeVisible();
    await expect(
      otherTab.getByRole('button', { name: 'Reject this operation once' })
    ).toBeVisible();

    await page
      .getByRole('button', { name: 'Allow this exact operation once — no future commands' })
      .click();
    await expect.poll(() => backend.answerBodies.length).toBe(1);
    await otherTab.getByRole('button', { name: 'Reject this operation once' }).click();

    const canonicalCard = otherTab.getByTestId(`acp-permission-${ANCHORED_ID}`);
    await expect(canonicalCard).toHaveAttribute('data-interaction-state', 'answered');
    await expect(canonicalCard.getByText('Answer saved', { exact: true })).toBeVisible();
    expect(backend.answerBodies).toHaveLength(2);
    await otherTab.close();
  });

  test('shows secure detail retry without inferred options', async ({ page }) => {
    await openDetailFailureSurface(page, 500);
    await screenshot(page, 'acp-permission-chat-detail-error-mobile');
  });

  test('removes secure controls after detail access is revoked', async ({ page }) => {
    await openDetailFailureSurface(page, 403);
    await screenshot(page, 'acp-permission-chat-detail-revoked-mobile');
  });
});

test.describe('ACP permission cards — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('renders anchored and unanchored owner requests with stress data', async ({ page }) => {
    await openPermissionSurface(page, true);
    await positionAnchoredCardBelowStickyHeader(page);
    await assertPermissionHitTargetsClearOfJumpButton(page);
    await positionAnchoredCardBelowStickyHeader(page);
    await screenshot(page, 'acp-permission-chat-owner-desktop');
  });

  test('shows generic waiting only to a noncreator', async ({ page }) => {
    const evidence = await openPermissionSurface(page, false);
    expect(evidence.detailRequests).toEqual([]);
    await screenshot(page, 'acp-permission-chat-noncreator-desktop');
  });

  test('shows secure detail retry without inferred options', async ({ page }) => {
    await openDetailFailureSurface(page, 500);
    await screenshot(page, 'acp-permission-chat-detail-error-desktop');
  });

  test('removes secure controls after detail access is revoked', async ({ page }) => {
    await openDetailFailureSurface(page, 403);
    await screenshot(page, 'acp-permission-chat-detail-revoked-desktop');
  });
});

test.describe('ACP permission cards — Narrow mobile', () => {
  test.use({ viewport: { width: 320, height: 667 }, isMobile: true, hasTouch: true });

  test('keeps exact option hit targets clear of jump-to-latest at 320px', async ({ page }) => {
    const evidence = await openPermissionSurface(page, true);
    await positionAnchoredCardBelowStickyHeader(page);
    await assertPermissionHitTargetsClearOfJumpButton(page);
    await assertTextClearOfJumpButton(page);
    await positionAnchoredCardBelowStickyHeader(page);
    await screenshot(page, 'acp-permission-chat-owner-narrow-mobile');
    evidence.dropNextAnswerReceipt();
    await page.getByRole('button', { name: 'Reject this operation once' }).click();
    await assertRetryControlClearOfJumpButton(page);
    await screenshot(page, 'acp-permission-chat-retry-narrow-mobile');
  });
});
