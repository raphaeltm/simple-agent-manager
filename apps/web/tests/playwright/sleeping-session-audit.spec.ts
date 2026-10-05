/**
 * Visual audit for a slept VM conversation (rule 17).
 *
 * Since PR #2230 a slept conversation keeps its own task row: `sleeping` with a
 * null execution step while idle, `queued` while a wake is in flight. The
 * project chat page used to restore `ProvisioningIndicator` for any task that
 * was neither terminal nor `in_progress`, so an idle slept chat rendered
 * "Starting... Waiting for task runner..." with a timer counting from the
 * task's original start, and a waking one rendered that block on top of the
 * dedicated wake banner.
 *
 * This spec mounts the real route against mocked APIs in both shapes and
 * asserts the provisioning block stays hidden while the surface the user needs
 * — the wake composer, or the wake banner — is live (rule 62: an absence
 * assertion needs a liveness assertion beside it). Overflow is checked through
 * `assertNoOverflow`, which also walks clipped overflow (rule 56).
 */

import { expect, type Page, test } from '@playwright/test';

import {
  assertNoOverflow,
  awaitOwnTaskFetchOutcome,
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

const SESSION = {
  id: 'session-1',
  projectId: 'proj-test-1',
  taskId: 'task-session-1',
  // Long topic and branch: a nowrap descendant is what drags a fit-content page
  // root past a 375px viewport (rule 56). SessionHeader renders `topic`.
  topic: 'Investigate inactive workspace on running node that refuses to go away',
  status: 'sleeping',
  workspaceId: null,
  nodeId: null,
  branch: 'sam/something-wacky-going-take-8645tk-with-an-even-longer-suffix',
  // Numeric like the real list item: the sidebar renders
  // `formatRelativeTime(lastMessageAt ?? startedAt)`, and an ISO string here
  // prints "Invalid Date" in every screenshot.
  startedAt: Date.parse('2026-01-15T10:00:00Z'),
  lastMessageAt: Date.parse('2026-01-15T10:02:00Z'),
  createdAt: Date.parse('2026-01-15T10:00:00Z'),
  updatedAt: Date.parse('2026-01-15T10:05:00Z'),
  stoppedAt: null,
};

const MESSAGES = [
  {
    id: 'msg-1',
    sessionId: 'session-1',
    role: 'user',
    content: 'Something wacky is going on. Take a look at the one active workspace.',
    messageIndex: 0,
    createdAt: '2026-01-15T10:01:00Z',
  },
  {
    id: 'msg-2',
    sessionId: 'session-1',
    role: 'assistant',
    content:
      'Only a confident `stalled` result permits intervention; uncertainty gets a later recheck. ' +
      'Recovery keeps the workspace and agent context and records the interruption as a tool failure.',
    messageIndex: 1,
    createdAt: '2026-01-15T10:02:00Z',
  },
];

/** `services/session-sleep-teardown.ts`: what the task looks like while idle asleep. */
const IDLE_SLEEPING_TASK = {
  id: 'task-session-1',
  status: 'sleeping',
  executionStep: null,
  errorMessage: null,
  outputBranch: 'sam/something-wacky-going-take-8645tk',
  startedAt: '2026-01-15T08:00:00Z',
  workspaceId: null,
};

/** `services/session-recovery.ts`: the same task once a wake has been claimed. */
const WAKING_TASK = {
  ...IDLE_SLEEPING_TASK,
  status: 'queued',
  executionStep: 'node_selection',
};

const IDLE_STATE = makeIdleSessionState();

interface Scenario {
  ownTask: typeof IDLE_SLEEPING_TASK;
  state: typeof IDLE_STATE;
}

const IDLE_SCENARIO: Scenario = { ownTask: IDLE_SLEEPING_TASK, state: IDLE_STATE };
const WAKING_SCENARIO: Scenario = {
  ownTask: WAKING_TASK,
  state: { ...IDLE_STATE, recoveryStatus: 'waking', wakePhase: 'node_provisioning' },
};

async function setupApiMocks(page: Page, scenario: Scenario) {
  await setupSleepingChatMocks(page, {
    user: MOCK_USER,
    project: MOCK_PROJECT,
    session: SESSION,
    messages: MESSAGES,
    state: scenario.state,
    ownTask: scenario.ownTask,
  });
}

/** Suppress the first-run onboarding wizard so screenshots capture the chat. */
async function dismissOnboarding(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-test-1', 'true');
  });
}

async function expectNoProvisioningBlock(page: Page) {
  // Both strings are unique to ProvisioningIndicator's non-terminal branch.
  await expect(page.getByText('Usually takes 2-4 minutes.')).toHaveCount(0);
  await expect(page.getByText('Waiting for task runner...')).toHaveCount(0);
}

for (const viewport of [
  { name: 'Mobile', width: 375, height: 667, isMobile: true },
  { name: 'Desktop', width: 1280, height: 800, isMobile: false },
]) {
  test.describe(`Sleeping session — ${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
    });

    test('idle slept chat shows the wake composer, not the provisioning block', async ({
      page,
    }) => {
      await dismissOnboarding(page);
      await setupApiMocks(page, IDLE_SCENARIO);
      await page.goto('/projects/proj-test-1/chat/session-1');

      // Liveness: the transcript and the wake composer are what a sleeping
      // session should show. An ErrorBoundary crash would also render zero
      // provisioning blocks, so assert the real surface first.
      await expect(page.getByPlaceholder('Send a message to wake the agent...')).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.getByText('Only a confident')).toBeVisible();
      await expect(page.locator('body')).not.toContainText('Do you have a cloud hosting account?');

      // The restore effect runs after the session list commits. If it fetched the
      // task (the pre-fix path) the block follows that response; wait for that
      // outcome, bounded, before asserting the absence.
      await awaitOwnTaskFetchOutcome(page, 'task-session-1');
      await expectNoProvisioningBlock(page);
      await expect(page.getByTestId('wake-progress-banner')).toHaveCount(0);

      await assertNoOverflow(page);
      await screenshot(page, `sleeping-session-idle-${viewport.name.toLowerCase()}`);
    });

    test('waking chat shows only the wake banner', async ({ page }) => {
      await dismissOnboarding(page);
      await setupApiMocks(page, WAKING_SCENARIO);
      await page.goto('/projects/proj-test-1/chat/session-1');

      await page.waitForSelector('[data-testid="wake-progress-banner"]', { timeout: 10_000 });
      await expect(page.getByTestId('wake-progress-label')).toHaveText('Provisioning a server...');
      await expect(page.locator('body')).not.toContainText('Do you have a cloud hosting account?');

      // The session's own task is `queued` here, exactly the shape that used to
      // restore ProvisioningIndicator on top of this banner (rule 24).
      await awaitOwnTaskFetchOutcome(page, 'task-session-1');
      await expectNoProvisioningBlock(page);
      await expect(page.getByPlaceholder('Send a message to wake the agent...')).toHaveCount(0);

      await assertNoOverflow(page);
      await screenshot(page, `sleeping-session-waking-${viewport.name.toLowerCase()}`);
    });
  });
}
