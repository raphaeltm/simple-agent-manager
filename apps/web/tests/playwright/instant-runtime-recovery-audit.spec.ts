import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, seedTheme } from './audit-helpers';

const PROJECT_ID = 'proj-instant-recovery-audit';
const SESSION_ID = 'chat-instant-recovery-audit';
const WORKSPACE_ID = 'workspace-instant-recovery-audit';
const AGENT_SESSION_ID = 'agent-instant-recovery-audit';
const NOW = Date.now();

type RecoveryScenario = 'normal' | 'waking' | 'degraded';

const PROJECT = {
  id: PROJECT_ID,
  name: 'Instant Recovery Audit',
  repository: 'test-user/instant-recovery-audit',
  defaultBranch: 'main',
  createdAt: new Date(NOW - 86_400_000).toISOString(),
  updatedAt: new Date(NOW).toISOString(),
};

const MESSAGES = [
  {
    id: 'message-before-break',
    sessionId: SESSION_ID,
    role: 'user',
    content: 'Keep the staged, unstaged, and untracked markers while I step away.',
    toolMetadata: null,
    createdAt: NOW - 1_200_000,
    sequence: 1,
  },
  {
    id: 'message-before-idle',
    sessionId: SESSION_ID,
    role: 'assistant',
    content:
      'The work is partway complete. I saved the safe checkpoint and will continue from this same chat when you return.',
    toolMetadata: null,
    createdAt: NOW - 1_190_000,
    sequence: 2,
  },
];

function makeSession(scenario: RecoveryScenario) {
  const idle = scenario === 'waking';
  return {
    id: SESSION_ID,
    workspaceId: WORKSPACE_ID,
    taskId: null,
    topic: 'Resume the exact Instant session after a short break',
    status: 'active',
    messageCount: MESSAGES.length,
    createdAt: NOW - 1_300_000,
    updatedAt: NOW - 1_190_000,
    endedAt: null,
    cleanupAt: NOW + 3_600_000,
    isIdle: idle,
    agentCompletedAt: idle ? NOW - 60_000 : null,
    agentSessionId: AGENT_SESSION_ID,
    agentType: 'codex',
  };
}

function respond(route: Route, status: number, body: unknown) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function setupMocks(page: Page, scenario: RecoveryScenario) {
  const session = makeSession(scenario);
  const auth = makeMockUser({
    email: 'instant-recovery@example.com',
    name: 'Instant Recovery Auditor',
    role: 'superadmin',
    sessionId: 'browser-session-instant-recovery',
    userId: 'user-instant-recovery',
  });

  await page.addInitScript(() => {
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-instant-recovery', 'true');
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === '/api/auth/get-session') return respond(route, 200, auth);
    if (path.startsWith('/api/notifications')) {
      return respond(route, 200, { notifications: [], unreadCount: 0 });
    }
    if (path === '/api/github/installations') return respond(route, 200, []);
    if (path === '/api/credentials') return respond(route, 200, []);
    if (path === '/api/trial/status') return respond(route, 200, { available: false });
    if (path === '/api/agents') return respond(route, 200, { agents: [] });
    if (path === '/api/projects') {
      return respond(route, 200, { projects: [PROJECT], nextCursor: null });
    }
    if (path === '/api/workspaces') return respond(route, 200, []);
    if (path === `/api/projects/${PROJECT_ID}`) return respond(route, 200, PROJECT);
    if (path === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}`) {
      return respond(route, 200, {
        session,
        messages: MESSAGES,
        hasMore: false,
        state: {
          activity: 'idle',
          activityAt: NOW - 1_190_000,
          statusError: null,
          currentPlan: [
            { content: 'Preserve the current filesystem checkpoint', status: 'completed' },
            { content: 'Continue after the user returns', status: 'pending' },
          ],
          planUpdatedAt: NOW - 1_190_000,
          promptStartedAt: null,
          agentType: 'codex',
          lastStopReason: null,
        },
      });
    }
    if (path === `/api/projects/${PROJECT_ID}/sessions`) {
      return respond(route, 200, { sessions: [session], total: 1, hasMore: false });
    }
    if (path === `/api/projects/${PROJECT_ID}/tasks`) {
      return respond(route, 200, { tasks: [], total: 0 });
    }
    if (path === `/api/projects/${PROJECT_ID}/agent-profiles`) {
      return respond(route, 200, { items: [] });
    }
    if (path.startsWith(`/api/projects/${PROJECT_ID}/commands`)) {
      return respond(route, 200, { commands: [] });
    }
    if (path === `/api/workspaces/${WORKSPACE_ID}`) {
      return respond(route, 200, {
        id: WORKSPACE_ID,
        name: 'instant-recovery-audit',
        nodeId: 'node-instant-recovery-audit',
        projectId: PROJECT_ID,
        status: scenario === 'waking' ? 'sleeping' : 'running',
      });
    }
    if (path === '/api/nodes/node-instant-recovery-audit') {
      return respond(route, 200, {
        id: 'node-instant-recovery-audit',
        name: 'Instant runtime',
        status: scenario === 'waking' ? 'sleeping' : 'ready',
      });
    }
    if (path === '/api/terminal/token') {
      return respond(route, 200, { token: 'visual-audit-token' });
    }
    if (path.endsWith('/idle-reset')) {
      return respond(route, 200, { cleanupAt: NOW + 3_600_000 });
    }
    if (path === `/api/workspaces/${WORKSPACE_ID}/agent-sessions/${AGENT_SESSION_ID}/resume`) {
      if (scenario === 'waking') {
        // Intentionally keep the real resume request pending so the visible
        // waking/restoring state can be audited without timing races.
        return;
      }
      return respond(route, 200, { id: AGENT_SESSION_ID, status: 'running' });
    }
    if (path === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/prompt`) {
      if (scenario === 'degraded') {
        return respond(route, 503, {
          error: 'RUNTIME_RECOVERY_DEGRADED',
          message:
            'The Instant runtime woke without a usable checkpoint. Your transcript is safe, but verify local files before continuing — résumé 🚧 <script>alert("not executed")</script> ' +
            'A_very_long_unbroken_marker_name_that_must_wrap_without_pushing_the_Dismiss_button_off_screen_0123456789.',
        });
      }
      return respond(route, 200, { status: 'accepted', sessionId: AGENT_SESSION_ID });
    }

    return respond(route, 200, {});
  });
}

async function openConversation(page: Page) {
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  await expect(page.getByRole('log', { name: 'Conversation' })).toBeVisible();
  await expect(page.getByText('The work is partway complete.')).toBeVisible();
}

async function sendFollowUp(page: Page, content: string) {
  const composer = page.getByPlaceholder(/send a message/i);
  await composer.fill(content);
  await page.getByRole('button', { name: /^send$/i }).click();
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`Instant runtime recovery — ${theme}`, () => {
    test.beforeEach(async ({ page }) => {
      await seedTheme(page, theme);
    });

    test('normal conversation preserves context', async ({ page }) => {
      await setupMocks(page, 'normal');
      await openConversation(page);
      await screenshot(page, `instant-recovery-normal-${theme}`);
      await assertNoOverflow(page);
    });

    test('waking and restoring remains inline with the transcript', async ({ page }) => {
      await setupMocks(page, 'waking');
      await openConversation(page);
      await sendFollowUp(page, 'Continue from the exact checkpoint.');
      await expect(page.getByText('Waking and restoring Instant session...')).toBeVisible();
      await screenshot(page, `instant-recovery-waking-${theme}`);
      await assertNoOverflow(page);
    });

    test('long degraded message wraps and remains dismissible', async ({ page }) => {
      await setupMocks(page, 'degraded');
      await openConversation(page);
      await sendFollowUp(page, 'Continue after the replacement.');
      const recoveryAlert = page.getByRole('alert').filter({ hasText: 'transcript is safe' });
      await expect(recoveryAlert).toBeVisible();
      await expect(page.getByRole('button', { name: 'Dismiss' })).toBeVisible();
      await expect(page.getByText(/<script>alert\("not executed"\)<\/script>/)).toBeVisible();
      const contentFitsAlert = await recoveryAlert.evaluate((alert) => {
        const bounds = alert.getBoundingClientRect();
        const childrenFit = Array.from(alert.children).every((child) => {
          const childBounds = child.getBoundingClientRect();
          return childBounds.left >= bounds.left - 1 && childBounds.right <= bounds.right + 1;
        });
        return childrenFit && alert.scrollWidth <= alert.clientWidth + 1;
      });
      expect(contentFitsAlert).toBe(true);
      await screenshot(page, `instant-recovery-degraded-long-special-${theme}`);
      await assertNoOverflow(page);
    });
  });
}
