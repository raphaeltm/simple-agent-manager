/**
 * Visual audit for the phase-level wake banner (rule 17).
 *
 * Mounts the real project chat route against mocked APIs with a *sleeping* session
 * whose state carries `recoveryStatus: 'waking'` plus a `wakePhase`, which is
 * exactly the shape `routes/chat/wake-state.ts` returns during a real wake.
 *
 * Overflow is asserted through `assertNoOverflow`, which also walks for clipped
 * overflow — the banner sits inside the project Outlet wrapper where
 * `overflow-x-hidden` would hide a blown-out layout from a document-level check
 * (rule 56).
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

/** Every phase a user can actually sit through, plus the pre-step window. */
const PHASES = [
  { phase: null, label: 'Waking and restoring session...', name: 'pending' },
  { phase: 'node_provisioning', label: 'Provisioning a server...', name: 'provisioning' },
  { phase: 'workspace_creation', label: 'Recreating your workspace...', name: 'workspace' },
  { phase: 'workspace_ready', label: 'Restoring your session...', name: 'restoring' },
  { phase: 'attachment_transfer', label: 'Restoring your files...', name: 'files' },
  { phase: 'agent_session', label: 'Starting the agent...', name: 'agent' },
] as const;

function makeSleepingSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    projectId: 'proj-test-1',
    taskId: 'task-session-1',
    // Long topic: a nowrap descendant here is exactly what drags a fit-content
    // page root past a 375px viewport (rule 56). SessionHeader renders `topic`,
    // NOT `title` — an earlier fixture used `title` and silently rendered the
    // short "Chat <id>" fallback, so the overflow stress case never ran.
    topic:
      'Investigate the extremely long running production incident with a title that will not fit',
    status: 'sleeping',
    workspaceId: 'ws-test-1',
    nodeId: 'node-test-1',
    branch: 'sam/a-very-long-branch-name-that-should-not-break-the-layout-either',
    createdAt: '2026-01-15T10:00:00Z',
    updatedAt: '2026-01-15T10:05:00Z',
    stoppedAt: null,
    ...overrides,
  };
}

const MESSAGES = [
  {
    id: 'msg-1',
    sessionId: 'session-1',
    role: 'user',
    content: 'Please look into the failing deploy.',
    messageIndex: 0,
    createdAt: '2026-01-15T10:01:00Z',
  },
  {
    id: 'msg-2',
    sessionId: 'session-1',
    role: 'assistant',
    content: 'Looking into it now.',
    messageIndex: 1,
    createdAt: '2026-01-15T10:02:00Z',
  },
];

async function setupApiMocks(
  page: Page,
  options: { wakePhase: string | null; recoveryStatus?: string } = { wakePhase: null }
) {
  const recoveryStatus = options.recoveryStatus ?? 'waking';
  // The session's OWN task. Since PR #2230 a slept conversation keeps its
  // original task row: `queued` with `node_selection` once a wake is claimed
  // (services/session-recovery.ts), `in_progress`/`running` once restored.
  // Realistic state matters: `useProvisioningTracker` must not restore
  // ProvisioningIndicator for a sleeping session even though its task is
  // `queued`, or both progress blocks render at once. An empty `{}` here
  // fakes an undefined-status task — a mock artifact, not real UI.
  const restored = recoveryStatus !== 'waking';
  await setupSleepingChatMocks(page, {
    user: MOCK_USER,
    project: MOCK_PROJECT,
    session: makeSleepingSession(),
    messages: MESSAGES,
    // Session detail state — the shape wake-state.ts produces mid-wake.
    state: makeIdleSessionState({ recoveryStatus, wakePhase: options.wakePhase }),
    ownTask: {
      id: 'task-session-1',
      status: restored ? 'in_progress' : 'queued',
      executionStep: restored ? 'running' : 'node_selection',
      errorMessage: null,
      outputBranch: 'sam/test',
      startedAt: '2026-01-15T10:00:00Z',
      workspaceId: restored ? 'ws-test-1' : null,
    },
  });
}

/**
 * Suppress the first-run onboarding wizard.
 *
 * Without this it mounts a full-screen modal over the chat. The banner is still
 * in the DOM and still "visible" to Playwright, so assertions pass — but every
 * screenshot captures the wizard and the overflow check measures the wizard's
 * layout instead of the chat's. Established pattern, e.g.
 * `agent-settings-audit.spec.ts`.
 */
async function dismissOnboarding(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-test-1', 'true');
  });
}

async function gotoWakingChat(page: Page) {
  await page.goto('/projects/proj-test-1/chat/session-1');
  await page.waitForSelector('[data-testid="wake-progress-banner"]', { timeout: 10_000 });
  // Guard the screenshot/overflow evidence: if the wizard ever reappears, fail
  // loudly rather than silently auditing the wrong surface again.
  await expect(page.locator('body')).not.toContainText('Do you have a cloud hosting account?');
}

for (const viewport of [
  { name: 'Mobile', width: 375, height: 667, isMobile: true },
  { name: 'Desktop', width: 1280, height: 800, isMobile: false },
]) {
  test.describe(`Wake progress banner — ${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
    });

    for (const { phase, label, name } of PHASES) {
      test(`renders "${name}" phase without overflow`, async ({ page }) => {
        await dismissOnboarding(page);
        await setupApiMocks(page, { wakePhase: phase });
        await gotoWakingChat(page);

        // The load-bearing assertion: the user can read WHICH phase the wake is
        // in. A spinner alone would satisfy a screenshot but not this.
        await expect(page.getByTestId('wake-progress-label')).toHaveText(label);

        // The composer must not contradict the banner by advertising a wake that
        // is already in flight (the duplicate-wake trap this feature exists for).
        await expect(page.getByPlaceholder('Send a message to wake the agent...')).toHaveCount(0);

        // No duplicate progress UI (rule 24). `ProvisioningIndicator` covers the
        // task-launch path and is fed by the session's own task; the wake banner
        // covers the wake path and is fed by the recovery task. They must never
        // both claim the screen — if this fires, the two have started to overlap.
        await expect(page.getByText('Usually takes 2-4 minutes.')).toHaveCount(0);

        await assertNoOverflow(page);
        await screenshot(page, `wake-progress-${name}-${viewport.name.toLowerCase()}`);
      });
    }

    test('hides the banner once the wake is restored', async ({ page }) => {
      // Discriminating control: proves the banner is driven by the wake signal
      // rather than merely rendering whenever a session is sleeping.
      //
      // The absence assertion is only meaningful if the app actually rendered.
      // An ErrorBoundary crash also produces zero banners, and that is not
      // hypothetical — it is exactly what a wrong mock envelope caused while this
      // spec was being written. So assert the app is alive first.
      await dismissOnboarding(page);
      await setupApiMocks(page, { wakePhase: 'running', recoveryStatus: 'restored' });
      await page.goto('/projects/proj-test-1/chat/session-1');
      await page.waitForTimeout(1500);

      await expect(page.locator('body')).not.toContainText('Something went wrong');
      await expect(page.getByTestId('wake-progress-banner')).toHaveCount(0);
      await assertNoOverflow(page);
    });
  });
}
