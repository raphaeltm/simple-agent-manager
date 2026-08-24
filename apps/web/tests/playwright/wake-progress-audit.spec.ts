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

import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  role: 'superadmin',
  sessionId: 'session-test-1',
  userId: 'user-test-1',
});

const MOCK_PROJECT = {
  id: 'proj-test-1',
  name: 'Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

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
  const session = makeSleepingSession();

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications/preferences')) return respond(200, {});
    if (path.startsWith('/api/notifications')) {
      return respond(200, { notifications: [], unreadCount: 0 });
    }
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/provider-catalog')) return respond(200, { catalogs: [] });
    if (path.startsWith('/api/github/installations')) return respond(200, []);
    if (path.startsWith('/api/report-issue/config')) return respond(200, { enabled: false });
    if (path === '/api/trial-status') return respond(200, {});
    if (path === '/api/agents') return respond(200, []);

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      // Envelope shapes matter: the client reads `.sessions`, `.items`,
      // `.commands` and `.messages`. Returning a bare array here crashes the app
      // into its ErrorBoundary, where an overflow-only assertion would still pass.
      if (subPath === '/sessions') return respond(200, { sessions: [session], total: 1 });
      if (subPath === '/agent-profiles') return respond(200, { items: [] });
      if (subPath === '/cached-commands') return respond(200, { commands: [] });
      if (subPath === '/credential-attribution-health') return respond(200, {});

      // Session detail — the shape wake-state.ts produces mid-wake.
      if (subPath.match(/^\/sessions\/[^/]+$/)) {
        return respond(200, {
          session,
          messages: MESSAGES,
          hasMore: false,
          state: {
            activity: 'idle',
            activityAt: 0,
            statusError: null,
            currentPlan: null,
            planUpdatedAt: null,
            promptStartedAt: null,
            agentType: null,
            lastStopReason: null,
            runtimeWorkState: null,
            runtimeWorkCount: null,
            runtimeWorkSource: null,
            runtimeWorkUpdatedAt: null,
            runtimeWorkProgressAt: null,
            recoveryStatus: options.recoveryStatus ?? 'waking',
            wakePhase: options.wakePhase,
          },
        });
      }

      if (subPath.match(/\/sessions\/[^/]+\/messages/)) {
        return respond(200, { messages: MESSAGES, hasMore: false });
      }
      if (subPath === '/tasks') return respond(200, []);
      // The session's OWN task. Realistic state matters here: `useProjectChatState`
      // only populates `provisioning` (and thus renders ProvisioningIndicator) for
      // a task that is neither terminal nor in_progress. A slept session's task is
      // in_progress, so the big provisioning block correctly stays hidden and the
      // wake banner is the only indicator. An empty `{}` here fakes an
      // undefined-status task and renders BOTH — a mock artifact, not real UI.
      if (subPath.match(/^\/tasks\/[^/]+$/)) {
        return respond(200, {
          id: 'task-session-1',
          status: 'in_progress',
          executionStep: 'running',
          errorMessage: null,
          outputBranch: 'sam/test',
          startedAt: '2026-01-15T10:00:00Z',
          workspaceId: 'ws-test-1',
        });
      }
      if (subPath === '/agents') return respond(200, []);
      if (subPath === '/skills') return respond(200, []);
      if (subPath === '') return respond(200, MOCK_PROJECT);
      return respond(200, {});
    }

    if (path === '/api/projects') return respond(200, [MOCK_PROJECT]);
    return respond(200, {});
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
