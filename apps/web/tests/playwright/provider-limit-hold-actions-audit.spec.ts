/**
 * Visual audit for the owner's two exits from a provider-limit admission hold (rule 17):
 *
 * - "Start anyway" on the waiting notice, for a task that has never started.
 * - "Cancel task" in the tool rail instead of "Complete", which a queued task cannot do.
 *
 * Mounts the real project chat route against mocked APIs. The long reason and long topic
 * are the overflow stress cases (rule 56). The blocked case is the control: it keeps the
 * existing Resume action and offers no Start anyway.
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

const USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  sessionId: 'session-test-1',
  userId: 'user-test-1',
});
const PROJECT = makeMockProject();
const WAITING = 'Waiting for provider limit reset at 06:58 UTC (2026-11-11).';
const BLOCKED =
  'Blocked: provider limit wait budget exhausted. Review the provider limit before resuming.';

type Variant =
  'waiting' | 'stress' | 'blocked' | 'callback' | 'callback-stress' | 'callback-reader';

function session(variant: Variant) {
  return {
    id: 'session-1',
    projectId: 'proj-test-1',
    taskId: 'task-1',
    topic:
      variant === 'stress' || variant === 'callback-stress'
        ? 'Run SAM PR Shepherd for raphaeltm/simple-agent-manager '.repeat(4)
        : 'Run SAM PR Shepherd for raphaeltm/simple-agent-manager',
    status: variant.startsWith('callback') ? 'sleeping' : 'active',
    workspaceId: null,
    nodeId: null,
    branch: 'sam/pr-shepherd-steady-state-43258a',
    startedAt: Date.parse('2026-11-10T12:00:00Z'),
    lastMessageAt: Date.parse('2026-11-10T12:01:00Z'),
    createdAt: Date.parse('2026-11-10T12:00:00Z'),
    updatedAt: Date.parse('2026-11-10T12:01:00Z'),
    stoppedAt: null,
    viewerAccess: variant === 'callback-reader' ? 'reader' : 'owner',
    isMine: variant !== 'callback-reader',
    task: {
      id: 'task-1',
      status: 'queued',
      executionStep: 'node_selection',
      providerLimitReason:
        variant === 'blocked'
          ? BLOCKED
          : variant === 'stress' || variant === 'callback-stress'
            ? `${WAITING} ${'unbroken'.repeat(30)}`
            : WAITING,
      providerLimitVersion: 'wait-1',
      providerLimitCanStartAnyway: variant !== 'blocked' && !variant.startsWith('callback'),
      providerLimitCanResumeAnyway: variant.startsWith('callback') && variant !== 'callback-reader',
    },
  };
}

const MESSAGES = [
  {
    id: 'msg-1',
    sessionId: 'session-1',
    role: 'user',
    content:
      'Run the SAM PR Shepherd for raphaeltm/simple-agent-manager. Triage all open PRs and merge ready work.',
    messageIndex: 0,
    createdAt: '2026-11-10T12:00:00Z',
  },
  {
    id: 'msg-2',
    sessionId: 'session-1',
    role: 'system',
    content: WAITING,
    messageIndex: 1,
    createdAt: '2026-11-10T12:01:00Z',
  },
];

async function openHeldChat(page: Page, variant: Variant) {
  await page.addInitScript(() => {
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-test-1', 'true');
  });
  await setupSleepingChatMocks(page, {
    user: USER,
    project: PROJECT,
    session: session(variant),
    messages: MESSAGES,
    state: makeIdleSessionState(),
    ownTask: {
      id: 'task-1',
      status: 'queued',
      executionStep: 'node_selection',
      errorMessage: null,
      outputBranch: 'sam/pr-shepherd-steady-state-43258a',
      startedAt: null,
      workspaceId: null,
      admissionState: variant === 'blocked' ? 'provider_limit_blocked' : 'provider_limit_waiting',
    },
  });
  // Registered after the catch-all mocks: Playwright matches the newest route first.
  const calls = { startAnyway: 0, status: [] as unknown[] };
  await page.route('**/api/projects/*/tasks/task-1/provider-limit/start-anyway', (route) => {
    calls.startAnyway++;
    return route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'starting', taskId: 'task-1' }),
    });
  });
  await page.route('**/api/projects/*/tasks/task-1/status', (route) => {
    calls.status.push(route.request().postDataJSON());
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'task-1', status: 'cancelled' }),
    });
  });
  await page.goto('/projects/proj-test-1/chat/session-1');
  await expect(page.getByTestId('provider-limit-notice')).toBeVisible({ timeout: 10_000 });
  return calls;
}

for (const viewport of [
  { name: 'narrow', width: 320, height: 667, isMobile: true },
  { name: 'mobile', width: 375, height: 667, isMobile: true },
  { name: 'desktop', width: 1280, height: 800, isMobile: false },
]) {
  test.describe(`Provider-limit hold actions — ${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
    });

    test('light theme saved session has a readable action and error', async ({ page }) => {
      await page.addInitScript(() => window.localStorage.setItem('sam-theme', 'light'));
      await openHeldChat(page, 'callback');
      await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'sam-light');
      const notice = page.getByTestId('provider-limit-notice');
      await expect(notice.getByRole('button', { name: 'Resume anyway' })).toBeVisible();
      await assertNoOverflow(page);
      await screenshot(page, `provider-force-resume-light-${viewport.name}`);
    });

    test('saved waiting session exposes Resume anyway and retains the pending state', async ({
      page,
    }) => {
      const calls = await openHeldChat(page, 'callback');
      const notice = page.getByTestId('provider-limit-notice');
      await expect(notice).toContainText('same account');
      const button = notice.getByRole('button', { name: 'Resume anyway' });
      await expect(button).toBeVisible();
      await assertNoOverflow(page);
      await screenshot(page, `provider-force-resume-waiting-${viewport.name}`);
      await button.click();
      await expect(notice.getByRole('button', { name: 'Waking…' })).toBeDisabled();
      expect(calls.startAnyway).toBe(1);
      await screenshot(page, `provider-force-resume-pending-${viewport.name}`);
    });

    test('saved session error remains readable with long text and permits retry', async ({
      page,
    }) => {
      await openHeldChat(page, 'callback-stress');
      await page.route('**/api/projects/*/tasks/task-1/provider-limit/start-anyway', (route) =>
        route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 'CONFLICT',
            message: 'The selected account changed; refresh and review before resuming.',
          }),
        })
      );
      const notice = page.getByTestId('provider-limit-notice');
      await notice.getByRole('button', { name: 'Resume anyway' }).click();
      await expect(notice.getByRole('alert')).toContainText('selected account changed');
      await expect(notice.getByRole('button', { name: 'Resume anyway' })).toBeEnabled();
      await assertNoOverflow(page);
      await screenshot(page, `provider-force-resume-error-stress-${viewport.name}`);
    });

    test('reader sees the saved provider hold without an owner override', async ({ page }) => {
      await openHeldChat(page, 'callback-reader');
      const notice = page.getByTestId('provider-limit-notice');
      await expect(notice.getByRole('button', { name: 'Resume anyway' })).toHaveCount(0);
      await expect(notice).toContainText('Waiting for provider limit reset');
      await assertNoOverflow(page);
      await screenshot(page, `provider-force-resume-reader-${viewport.name}`);
    });

    test('waiting hold offers Start anyway on the notice and Cancel task in the rail', async ({
      page,
    }) => {
      const calls = await openHeldChat(page, 'waiting');
      const notice = page.getByTestId('provider-limit-notice');
      await expect(notice).toContainText('Waiting for provider limit reset');
      await expect(notice).toContainText('extra credits');
      const start = notice.getByRole('button', { name: 'Start anyway' });
      await expect(start).toBeVisible();
      // Held before start: no VM is being provisioned, so no provisioning slab. Wait for the
      // own-task fetch that would restore it, so the absence is observed after that ran.
      await page.waitForResponse((r) => r.url().endsWith('/tasks/task-1'));
      await page.waitForTimeout(500);
      await expect(page.getByTestId('provisioning-indicator')).toHaveCount(0);
      const rail = page.getByTestId('session-tool-rail');
      await expect(rail.getByRole('button', { name: /Cancel this task/ })).toBeVisible();
      await expect(rail.getByRole('button', { name: /Mark this task complete/ })).toHaveCount(0);
      await assertNoOverflow(page);
      await screenshot(page, `provider-hold-waiting-${viewport.name}`);

      await start.click();
      await expect(notice.getByRole('button', { name: 'Starting…' })).toBeDisabled();
      expect(calls.startAnyway).toBe(1);
      await screenshot(page, `provider-hold-start-anyway-clicked-${viewport.name}`);
    });

    test('Cancel task confirms before cancelling', async ({ page }) => {
      const calls = await openHeldChat(page, 'waiting');
      await page
        .getByTestId('session-tool-rail')
        .getByRole('button', { name: /Cancel this task/ })
        .click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toContainText('Cancel this task?');
      await expect(dialog).toContainText('after a provider limit resets');
      await assertNoOverflow(page);
      await screenshot(page, `provider-hold-cancel-dialog-${viewport.name}`);
      await dialog.getByRole('button', { name: 'Cancel task' }).click();
      await expect.poll(() => calls.status).toEqual([{ toStatus: 'cancelled' }]);
    });

    test('long reason and topic wrap without overflow', async ({ page }) => {
      await openHeldChat(page, 'stress');
      await expect(
        page.getByTestId('provider-limit-notice').getByRole('button', { name: 'Start anyway' })
      ).toBeVisible();
      await assertNoOverflow(page);
      await screenshot(page, `provider-hold-stress-${viewport.name}`);
    });

    test('a blocked hold keeps Resume and offers no Start anyway (control)', async ({ page }) => {
      await openHeldChat(page, 'blocked');
      const notice = page.getByTestId('provider-limit-notice');
      await expect(notice.getByRole('button', { name: 'Resume task' })).toBeVisible();
      await expect(notice.getByRole('button', { name: 'Start anyway' })).toHaveCount(0);
      await assertNoOverflow(page);
      await screenshot(page, `provider-hold-blocked-${viewport.name}`);
    });
  });
}
