import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  role: 'superadmin',
  sessionId: 'session-test-1',
  userId: 'user-test-1',
});

const MOCK_PROJECT = {
  id: 'proj-test-1',
  name: 'Timeline Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function makeChatSession() {
  return {
    id: 'cs-1',
    projectId: 'proj-test-1',
    status: 'active',
    topic: 'Implement timeline feature',
    workspaceId: 'ws-test-1',
    agentSessionId: 'as-1',
    isIdle: false,
    agentCompletedAt: null,
    task: {
      id: 'task-1',
      status: 'in_progress',
      title: 'Implement feature',
      outputBranch: 'sam/feature-branch',
      outputPrUrl: null,
      errorMessage: null,
      outputSummary: null,
    },
    createdAt: '2026-03-20T10:00:00Z',
    updatedAt: '2026-03-20T10:00:00Z',
  };
}

const NOW = Date.now();

function makeMessages() {
  return {
    messages: [
      { id: 'msg-1', sessionId: 'cs-1', role: 'user', content: 'Please implement the new timeline feature for our chat interface', toolMetadata: null, createdAt: NOW - 600_000 },
      { id: 'msg-2', sessionId: 'cs-1', role: 'assistant', content: 'I\'ll implement the timeline feature now.', toolMetadata: null, createdAt: NOW - 590_000 },
      { id: 'msg-3', sessionId: 'cs-1', role: 'user', content: 'Can you also add support for activity events in the timeline?', toolMetadata: null, createdAt: NOW - 300_000 },
      { id: 'msg-4', sessionId: 'cs-1', role: 'assistant', content: 'Sure, I\'ll add activity event integration.', toolMetadata: null, createdAt: NOW - 290_000 },
      { id: 'msg-5', sessionId: 'cs-1', role: 'user', content: 'Great, make sure the drawer matches the ChatFilePanel glass styling', toolMetadata: null, createdAt: NOW - 60_000 },
    ],
    hasMore: false,
  };
}

function makeActivityEvents() {
  return {
    events: [
      { id: 'evt-1', eventType: 'workspace.created', actorType: 'system', actorId: null, workspaceId: 'ws-test-1', sessionId: 'cs-1', taskId: null, payload: null, createdAt: NOW - 610_000 },
      { id: 'evt-2', eventType: 'session.started', actorType: 'system', actorId: null, workspaceId: null, sessionId: 'cs-1', taskId: null, payload: null, createdAt: NOW - 605_000 },
      { id: 'evt-3', eventType: 'task.status_changed', actorType: 'system', actorId: null, workspaceId: null, sessionId: 'cs-1', taskId: 'task-1', payload: { toStatus: 'in_progress' }, createdAt: NOW - 500_000 },
      { id: 'evt-4', eventType: 'task.status_changed', actorType: 'system', actorId: null, workspaceId: null, sessionId: 'cs-1', taskId: 'task-1', payload: { toStatus: 'completed' }, createdAt: NOW - 30_000 },
    ],
    hasMore: false,
  };
}

function makeNotifications() {
  return {
    notifications: [
      {
        id: 'notif-1',
        projectId: 'proj-test-1',
        taskId: 'task-1',
        sessionId: 'cs-1',
        type: 'progress',
        urgency: 'low',
        title: 'Progress: Dependencies',
        body: 'Dependency installation finished successfully',
        actionUrl: '/projects/proj-test-1/chat/cs-1',
        metadata: {
          fullMessage: 'Dependency installation finished successfully. Running focused timeline tests next.',
        },
        readAt: null,
        dismissedAt: null,
        createdAt: new Date(NOW - 520_000).toISOString(),
      },
      {
        id: 'notif-2',
        projectId: 'proj-test-1',
        taskId: 'task-1',
        sessionId: 'cs-1',
        type: 'progress',
        urgency: 'low',
        title: 'Progress: Audit',
        body: 'Opened the timeline drawer for local visual verification',
        actionUrl: '/projects/proj-test-1/chat/cs-1',
        metadata: null,
        readAt: null,
        dismissedAt: null,
        createdAt: new Date(NOW - 120_000).toISOString(),
      },
    ],
    unreadCount: 2,
    nextCursor: null,
  };
}

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    const { pathname } = new URL(url);

    if (pathname.includes('/ws') || url.includes('websocket')) {
      await route.abort();
      return;
    }

    if (pathname === '/api/auth/session' || pathname === '/api/auth/get-session') {
      await route.fulfill({ json: MOCK_USER });
      return;
    }

    if (pathname === '/api/projects') {
      await route.fulfill({ json: { projects: [MOCK_PROJECT], nextCursor: null } });
      return;
    }

    if (pathname === '/api/nodes') {
      await route.fulfill({ json: [] });
      return;
    }

    if (pathname === '/api/chats') {
      await route.fulfill({ json: { sessions: [], total: 0 } });
      return;
    }

    if (pathname === '/api/github/installations') {
      await route.fulfill({ json: [] });
      return;
    }

    if (pathname === '/api/credentials') {
      await route.fulfill({ json: [] });
      return;
    }

    if (pathname === '/api/trial-status') {
      await route.fulfill({
        json: {
          available: false,
          agentType: null,
          hasInfraCredential: false,
          hasAgentCredential: false,
          dailyTokenBudget: null,
          dailyTokenUsage: null,
        },
      });
      return;
    }

    if (pathname === '/api/agents') {
      await route.fulfill({ json: { agents: [] } });
      return;
    }

    if (pathname === '/api/providers/catalog') {
      await route.fulfill({ json: { catalogs: [] } });
      return;
    }

    if (pathname === '/api/projects/proj-test-1/agent-profiles') {
      await route.fulfill({ json: { items: [] } });
      return;
    }

    if (pathname === '/api/projects/proj-test-1/tasks') {
      await route.fulfill({ json: { tasks: [], nextCursor: null } });
      return;
    }

    if (pathname === '/api/projects/proj-test-1/sessions/cs-1/messages') {
      await route.fulfill({ json: makeMessages() });
      return;
    }

    if (pathname === '/api/projects/proj-test-1/sessions/cs-1/state') {
      await route.fulfill({ json: { activity: 'idle', activityAt: NOW, statusError: null, currentPlan: null } });
      return;
    }

    if (pathname === '/api/projects/proj-test-1/sessions/cs-1') {
      await route.fulfill({
        json: {
          session: makeChatSession(),
          messages: makeMessages().messages,
          hasMore: false,
          state: { activity: 'idle', activityAt: NOW, statusError: null, currentPlan: null },
        },
      });
      return;
    }

    if (pathname === '/api/projects/proj-test-1/sessions') {
      await route.fulfill({ json: { sessions: [makeChatSession()] } });
      return;
    }

    if (pathname === '/api/projects/proj-test-1/activity') {
      await route.fulfill({ json: makeActivityEvents() });
      return;
    }

    if (pathname === '/api/notifications') {
      await route.fulfill({ json: makeNotifications() });
      return;
    }

    if (pathname === '/api/projects/proj-test-1') {
      await route.fulfill({ json: MOCK_PROJECT });
      return;
    }

    await route.fulfill({ json: {} });
  });
}

async function openTimeline(page: Page) {
  const timelineBtn = page.getByRole('button', { name: /^Timeline$/ });
  if (!(await timelineBtn.first().isVisible().catch(() => false))) {
    const detailsBtn = page.getByLabel('Show session details').first();
    if (await detailsBtn.isVisible().catch(() => false)) {
      await detailsBtn.click();
    }
  }
  await timelineBtn.waitFor({ state: 'visible', timeout: 10_000 });
  await timelineBtn.click();
  await page.getByText('Status update').first().waitFor({ state: 'visible', timeout: 5_000 });
  await page.getByText('Dependency installation finished successfully. Running focused timeline tests next.').waitFor({
    state: 'visible',
    timeout: 5_000,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('ChatTimelineDrawer — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('timeline drawer renders with user messages', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(2000);

    await openTimeline(page);
    await page.waitForTimeout(800);
    await screenshot(page, 'timeline-drawer-mobile-messages');
    await assertNoOverflow(page);
  });

  test('timeline drawer with context toggle', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(2000);

    await openTimeline(page);
    await page.waitForTimeout(800);

    const contextBtn = page.locator('button:has-text("Context")');
    await contextBtn.click();
    await page.waitForTimeout(600);
    await screenshot(page, 'timeline-drawer-mobile-context');
    await assertNoOverflow(page);
  });
});

test.describe('ChatTimelineDrawer — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('timeline drawer renders on desktop', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(2000);

    await openTimeline(page);
    await page.waitForTimeout(800);
    await screenshot(page, 'timeline-drawer-desktop');
    await assertNoOverflow(page);
  });

  test('timeline drawer with context on desktop', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(2000);

    await openTimeline(page);
    await page.waitForTimeout(800);

    const contextBtn = page.locator('button:has-text("Context")');
    await contextBtn.click();
    await page.waitForTimeout(600);
    await screenshot(page, 'timeline-drawer-desktop-context');
    await assertNoOverflow(page);
  });

  test('clicking a user-message entry closes the drawer and highlights the message', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(2000);

    await openTimeline(page);
    await page.waitForTimeout(500);

    const dialog = page.getByRole('dialog');
    // Click a user-message entry inside the timeline (scoped to the dialog so it
    // does not match the same text in the underlying chat transcript).
    await dialog.getByText('Please implement the new timeline feature for our chat interface').click();

    // The drawer closes and the jumped-to message flashes.
    await expect(dialog).toBeHidden({ timeout: 3000 });
    await expect(page.locator('.sam-message-highlight').first()).toBeVisible({ timeout: 3000 });
    await screenshot(page, 'timeline-drawer-jump-highlight');
  });

  test('clicking a status-update entry closes the drawer (jumps to nearest message)', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(2000);

    await openTimeline(page);
    await page.waitForTimeout(500);

    const dialog = page.getByRole('dialog');
    await dialog.getByText('Dependency installation finished successfully. Running focused timeline tests next.').click();

    await expect(dialog).toBeHidden({ timeout: 3000 });
    await expect(page.locator('.sam-message-highlight').first()).toBeVisible({ timeout: 3000 });
  });
});
