/**
 * Visual audit for the chat's notices in SAM Glass (rule 17).
 *
 * - Provisioning is a notice slab in the conversation column with a stage track.
 * - A wake is a status capsule floating over the top of the conversation pane, not a
 *   strip in the column. The capsule must stay inside the pane and, on phones, clear of
 *   the tool rail on the pane's right edge: both are layout relationships, so they are
 *   asserted as measured coordinates.
 *
 * Mounts the real project chat route against mocked APIs. Long branch names and the
 * longest wait-reason label are the overflow stress cases (rule 56).
 */

import { expect, type Page, test } from '@playwright/test';

import {
  assertNoOverflow,
  makeIdleSessionState,
  makeMockProject,
  makeMockUser,
  screenshot,
  setupSleepingChatMocks,
} from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  role: 'superadmin',
  sessionId: 'session-test-1',
  userId: 'user-test-1',
});

const MOCK_PROJECT = makeMockProject();

const LONG_BRANCH =
  'sam/investigate-slow-chat-session-loading-and-reconnection-issues-with-an-unbroken-suffix';

function makeSession(status: 'active' | 'sleeping') {
  return {
    id: 'session-1',
    projectId: 'proj-test-1',
    taskId: 'task-session-1',
    topic: 'Investigate slow chat session loading and reconnection issues',
    status,
    workspaceId: null,
    nodeId: null,
    branch: LONG_BRANCH,
    startedAt: Date.parse('2026-01-15T10:00:00Z'),
    lastMessageAt: Date.parse('2026-01-15T10:02:00Z'),
    createdAt: Date.parse('2026-01-15T10:00:00Z'),
    updatedAt: Date.parse('2026-01-15T10:05:00Z'),
    stoppedAt: null,
    viewerAccess: 'owner',
  };
}

const MESSAGES = [
  {
    id: 'msg-1',
    sessionId: 'session-1',
    role: 'user',
    content: 'Sometimes when I switch chats the old one keeps loading for ages. Why?',
    messageIndex: 0,
    createdAt: '2026-01-15T10:01:00Z',
  },
  {
    id: 'msg-2',
    sessionId: 'session-1',
    role: 'assistant',
    content: 'Tracing the session switch path in useChatWebSocket.ts and useSessionLifecycle.ts.',
    messageIndex: 1,
    createdAt: '2026-01-15T10:02:00Z',
  },
];

async function dismissOnboarding(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-test-1', 'true');
  });
}

async function openProvisioningChat(page: Page) {
  await dismissOnboarding(page);
  await setupSleepingChatMocks(page, {
    user: MOCK_USER,
    project: MOCK_PROJECT,
    session: makeSession('active'),
    messages: MESSAGES,
    state: makeIdleSessionState(),
    // First boot: the session's own task is still in the runner's pre-agent steps and has
    // never started (a started task would be a wake; see useProvisioningTracker gate 3).
    ownTask: {
      id: 'task-session-1',
      status: 'queued',
      executionStep: 'workspace_ready',
      errorMessage: null,
      outputBranch: LONG_BRANCH,
      startedAt: null,
      workspaceId: null,
    },
  });
  await page.goto('/projects/proj-test-1/chat/session-1');
  await expect(page.getByTestId('provisioning-indicator')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('body')).not.toContainText('Do you have a cloud hosting account?');
}

async function openWakingChat(page: Page, waitReason: string | null) {
  await dismissOnboarding(page);
  await setupSleepingChatMocks(page, {
    user: MOCK_USER,
    project: MOCK_PROJECT,
    session: makeSession('sleeping'),
    messages: MESSAGES,
    state: makeIdleSessionState({
      recoveryStatus: 'waking',
      wakePhase: waitReason ? 'waiting_for_node_capacity' : 'workspace_ready',
      waitReason,
      waitRetryAt: waitReason ? new Date(Date.now() + 120_000).toISOString() : null,
    }),
    ownTask: {
      id: 'task-session-1',
      status: 'queued',
      executionStep: 'node_selection',
      errorMessage: null,
      outputBranch: 'sam/test',
      startedAt: '2026-01-15T10:00:00Z',
      workspaceId: null,
    },
  });
  await page.goto('/projects/proj-test-1/chat/session-1');
  await expect(page.getByTestId('wake-progress-banner')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('body')).not.toContainText('Do you have a cloud hosting account?');
}

/** The capsule floats inside the conversation pane and clear of the phone tool rail. */
async function assertCapsuleInsidePane(page: Page) {
  const capsule = await page.getByTestId('wake-progress-banner').boundingBox();
  const log = await page.getByRole('log', { name: 'Conversation' }).boundingBox();
  expect(capsule).not.toBeNull();
  expect(log).not.toBeNull();
  // Over the top of the conversation, not stacked above it in the column.
  expect(capsule!.y).toBeGreaterThanOrEqual(log!.y);
  expect(capsule!.x).toBeGreaterThanOrEqual(log!.x - 1);

  // The capsule must end before the conversation does, and before the tool rail (inside
  // the pane on phones, its own pane beside it on desktop). The rail renders for an
  // owned session in both layouts.
  const rail = await page.getByTestId('session-tool-rail').boundingBox();
  expect(rail).not.toBeNull();
  expect(capsule!.x + capsule!.width).toBeLessThanOrEqual(log!.x + log!.width + 1);
  expect(capsule!.x + capsule!.width).toBeLessThanOrEqual(rail!.x + 1);
}

for (const viewport of [
  { name: 'Mobile', width: 375, height: 667, isMobile: true },
  { name: 'Desktop', width: 1280, height: 800, isMobile: false },
]) {
  test.describe(`Chat notices — ${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
    });

    test('provisioning renders as a notice slab with a stage track', async ({ page }) => {
      await openProvisioningChat(page);
      const notice = page.getByTestId('provisioning-indicator');
      await expect(notice).toContainText('Installing dependencies · 3 of 4');
      await expect(notice).toContainText('This usually takes 2–4 minutes.');
      const track = notice.getByTestId('stage-track');
      await expect(track.locator('[data-stage-state="done"]')).toHaveCount(2);
      await expect(track.locator('[data-stage-state="current"]')).toHaveCount(1);

      // The slab sits in the column above the session header, inside the viewport.
      const noticeBox = await notice.boundingBox();
      expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(viewport.width);

      await assertNoOverflow(page);
      await screenshot(page, `chat-notices-provisioning-${viewport.name.toLowerCase()}`);
    });

    test('a wake floats as a capsule over the conversation', async ({ page }) => {
      await openWakingChat(page, null);
      await expect(page.getByTestId('wake-progress-label')).toHaveText('Restoring your session...');
      // Liveness beside the layout checks: the transcript is still on screen underneath.
      await expect(page.getByText('Tracing the session switch path')).toBeVisible();
      await assertCapsuleInsidePane(page);
      await assertNoOverflow(page);
      await screenshot(page, `chat-notices-waking-${viewport.name.toLowerCase()}`);
    });

    test('a long wait reason wraps inside the capsule', async ({ page }) => {
      await openWakingChat(page, 'capacity_pool_node_limit');
      await expect(page.getByTestId('wake-progress-banner')).toHaveAttribute(
        'data-tone',
        'warning'
      );
      await expect(page.getByTestId('wake-progress-label')).toContainText(
        "This project's server limit is reached."
      );
      await assertCapsuleInsidePane(page);
      await assertNoOverflow(page);
      await screenshot(page, `chat-notices-wake-wait-${viewport.name.toLowerCase()}`);
    });
  });
}
