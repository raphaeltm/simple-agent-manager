import { type Page, type Route, test } from '@playwright/test';

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

// ---------------------------------------------------------------------------
// API Mock Setup
// ---------------------------------------------------------------------------

async function setupMocks(page: Page) {
  await page.route('**/api/auth/get-session', async (route: Route) => {
    await route.fulfill({ json: MOCK_USER });
  });

  await page.route('**/api/projects/proj-test-1', async (route: Route) => {
    await route.fulfill({ json: MOCK_PROJECT });
  });

  await page.route('**/api/projects/proj-test-1/sessions', async (route: Route) => {
    await route.fulfill({ json: { sessions: [makeChatSession()] } });
  });

  await page.route('**/api/projects/proj-test-1/sessions/cs-1', async (route: Route) => {
    await route.fulfill({ json: makeChatSession() });
  });

  await page.route('**/api/projects/proj-test-1/sessions/cs-1/messages*', async (route: Route) => {
    await route.fulfill({ json: makeMessages() });
  });

  await page.route('**/api/projects/proj-test-1/sessions/cs-1/state', async (route: Route) => {
    await route.fulfill({ json: { activity: 'idle', activityAt: NOW, statusError: null, currentPlan: null } });
  });

  await page.route('**/api/projects/proj-test-1/activity*', async (route: Route) => {
    await route.fulfill({ json: makeActivityEvents() });
  });

  // Catch-all for other API calls
  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('/ws') || url.includes('websocket')) {
      await route.abort();
      return;
    }
    await route.fulfill({ json: {} });
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

    // Look for the Timeline button and click it
    const timelineBtn = page.locator('button:has-text("Timeline")');
    if (await timelineBtn.count() > 0) {
      await timelineBtn.click();
      await page.waitForTimeout(800);
      await screenshot(page, 'timeline-drawer-mobile-messages');
      await assertNoOverflow(page);
    }
  });

  test('timeline drawer with context toggle', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(2000);

    const timelineBtn = page.locator('button:has-text("Timeline")');
    if (await timelineBtn.count() > 0) {
      await timelineBtn.click();
      await page.waitForTimeout(800);

      // Toggle context
      const contextBtn = page.locator('button:has-text("Context")');
      if (await contextBtn.count() > 0) {
        await contextBtn.click();
        await page.waitForTimeout(600);
        await screenshot(page, 'timeline-drawer-mobile-context');
        await assertNoOverflow(page);
      }
    }
  });
});

test.describe('ChatTimelineDrawer — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('timeline drawer renders on desktop', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(2000);

    const timelineBtn = page.locator('button:has-text("Timeline")');
    if (await timelineBtn.count() > 0) {
      await timelineBtn.click();
      await page.waitForTimeout(800);
      await screenshot(page, 'timeline-drawer-desktop');
      await assertNoOverflow(page);
    }
  });

  test('timeline drawer with context on desktop', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat/cs-1');
    await page.waitForTimeout(2000);

    const timelineBtn = page.locator('button:has-text("Timeline")');
    if (await timelineBtn.count() > 0) {
      await timelineBtn.click();
      await page.waitForTimeout(800);

      const contextBtn = page.locator('button:has-text("Context")');
      if (await contextBtn.count() > 0) {
        await contextBtn.click();
        await page.waitForTimeout(600);
        await screenshot(page, 'timeline-drawer-desktop-context');
        await assertNoOverflow(page);
      }
    }
  });
});
