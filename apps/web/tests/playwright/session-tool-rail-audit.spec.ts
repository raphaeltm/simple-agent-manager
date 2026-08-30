/**
 * Visual + behavioural audit for the session tool rail, against the REAL project chat.
 *
 * The rail replaces the collapsed session-header disclosure as the home for the
 * session's controls. Before this change all seven of Files/Git/Workspace/Timeline/
 * Comments/Report/Complete lived inside that disclosure and Retry/Fork were unlabeled
 * icons in the title row — nine controls behind one 14px chevron.
 *
 * Everything here drives the real production controls; nothing sets rail state directly
 * (`.claude/rules/62-tests-must-observe-the-real-trigger.md`).
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
} from './audit-helpers';

const PROJECT_ID = 'proj-rail-1';
const SESSION_ID = 'cs-rail-1';
const WORKSPACE_ID = 'ws-rail-1';
const STORAGE_KEY = 'sam-session-tool-strip-mode';

const MOCK_USER = makeMockUser({
  email: 'rail@example.com',
  name: 'Rail Tester',
  role: 'superadmin',
  sessionId: 'session-rail-1',
  userId: 'user-rail-1',
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Tool Rail Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: MOCK_USER.user.id,
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const NOW = Date.now();

const LONG_TOPIC =
  'Identify the source and purpose of every running task, then reconcile the supersession ledger against the ProjectData Durable Object so the active-agent count stops reporting ten times the real compute';

interface SessionOptions {
  long?: boolean;
  /** `active` exposes Files/Git/Workspace; other states do not. */
  state?: 'active' | 'sleeping';
  workspaceId?: string | null;
  taskStatus?: string;
}

function makeChatSession(options: SessionOptions = {}) {
  const {
    long = false,
    state = 'active',
    workspaceId = WORKSPACE_ID,
    taskStatus = 'in_progress',
  } = options;
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    status: state === 'sleeping' ? 'active' : 'active',
    topic: long ? LONG_TOPIC : 'Identify source and purpose of running tasks',
    workspaceId,
    agentSessionId: 'as-rail-1',
    isIdle: state === 'sleeping',
    isMine: true,
    agentCompletedAt: state === 'sleeping' ? NOW - 600_000 : null,
    messageCount: 4,
    startedAt: NOW - 3_600_000,
    endedAt: null,
    taskId: 'task-rail-1',
    task: {
      id: 'task-rail-1',
      status: taskStatus,
      title: 'Identify running tasks',
      outputBranch: 'sam/layered-resource-management',
      outputPrUrl: 'https://github.com/testuser/test-repo/pull/1974',
      errorMessage: null,
      outputSummary: null,
      taskMode: 'conversation',
    },
    createdAt: '2026-08-30T10:00:00Z',
    updatedAt: '2026-08-30T10:00:00Z',
  };
}

const LONG_TOKEN =
  'sam/layered-resource-management-with-an-extremely-long-branch-name-that-will-not-wrap-0123456789';

function makeMessages(long = false) {
  return {
    messages: [
      {
        id: 'msg-1',
        sessionId: SESSION_ID,
        role: 'user',
        content:
          'Where did the running tasks come from, and what is each one actually doing right now?',
        toolMetadata: null,
        createdAt: NOW - 600_000,
      },
      {
        id: 'msg-2',
        sessionId: SESSION_ID,
        role: 'assistant',
        content: long
          ? `Both Wave 1 tasks are done and their commits are on \`${LONG_TOKEN}\`.\n\nSee https://github.com/testuser/test-repo/blob/main/apps/api/src/durable-objects/project-data/knowledge.ts#L128-L214`
          : 'Both Wave 1 tasks are done and their commits are on `sam/layered-resource-management`.',
        toolMetadata: null,
        createdAt: NOW - 590_000,
      },
      {
        id: 'msg-3',
        sessionId: SESSION_ID,
        role: 'user',
        content: 'Good — dispatch Wave 2 when you can.',
        toolMetadata: null,
        createdAt: NOW - 300_000,
      },
      {
        id: 'msg-4',
        sessionId: SESSION_ID,
        role: 'assistant',
        content: 'Wave 2 dispatched. The next implementation task is actively running.',
        toolMetadata: null,
        createdAt: NOW - 290_000,
      },
    ],
    hasMore: false,
  };
}

interface MockOptions extends SessionOptions {
  /** Seeds the persisted strip mode before the app boots. */
  mode?: 'icons' | 'labels' | 'hidden';
  reportEnabled?: boolean;
  messagesLong?: boolean;
  empty?: boolean;
}

async function setupMocks(page: Page, options: MockOptions = {}) {
  const { mode, reportEnabled = true, messagesLong = false, empty = false } = options;

  await page.addInitScript(
    ({ userId, storageKey, seededMode }) => {
      window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
      if (seededMode) window.localStorage.setItem(storageKey, seededMode);
    },
    { userId: MOCK_USER.user.id, storageKey: STORAGE_KEY, seededMode: mode ?? '' }
  );

  const session = makeChatSession(options);
  const messages = empty ? { messages: [], hasMore: false } : makeMessages(messagesLong);
  const state = { activity: 'idle', activityAt: NOW, statusError: null, currentPlan: null };

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
    if (pathname === `/api/projects/${PROJECT_ID}`) {
      await route.fulfill({ json: MOCK_PROJECT });
      return;
    }
    if (pathname === '/api/report-issue/config') {
      await route.fulfill({ json: { enabled: reportEnabled } });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/messages`) {
      await route.fulfill({ json: messages });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/state`) {
      await route.fulfill({ json: state });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}`) {
      await route.fulfill({
        json: { session, messages: messages.messages, hasMore: false, state },
      });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions`) {
      await route.fulfill({ json: { sessions: [session], total: 1 } });
      return;
    }
    if (pathname === `/api/workspaces/${WORKSPACE_ID}`) {
      await route.fulfill({
        json: {
          id: WORKSPACE_ID,
          nodeId: 'node-rail-1',
          projectId: PROJECT_ID,
          name: 'tool-rail',
          repository: 'testuser/test-repo',
          branch: 'sam/chat-session-tool-rail',
          status: 'running',
          vmSize: 'medium',
          vmLocation: 'nbg1',
          workspaceProfile: 'lightweight',
          vmIp: '203.0.113.42',
          lastActivityAt: new Date(NOW - 60_000).toISOString(),
          errorMessage: null,
          createdAt: new Date(NOW - 3_600_000).toISOString(),
          updatedAt: new Date(NOW - 60_000).toISOString(),
          chatSessionId: SESSION_ID,
        },
      });
      return;
    }
    if (pathname === '/api/nodes' || pathname === '/api/credentials') {
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
    if (pathname === '/api/agents') {
      await route.fulfill({ json: { agents: [] } });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/agent-profiles`) {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/tasks`) {
      await route.fulfill({ json: { tasks: [], nextCursor: null } });
      return;
    }
    await route.fulfill({ json: {} });
  });
}

async function openChat(page: Page, options: MockOptions = {}) {
  await setupMocks(page, options);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  // Liveness: a crashed page has no rail and no overflow, so every other assertion in
  // this file would pass vacuously without this. In `hidden` mode the rail collapses to
  // its pull-tab, so wait for whichever form this scenario expects.
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  const anchor =
    options.mode === 'hidden'
      ? page.getByTestId('session-tool-rail-tab')
      : page.getByTestId('session-tool-details');
  await expect(anchor.first()).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(600);
}

async function capture(page: Page, name: string) {
  await screenshot(page, name);
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
}

test.describe('Session tool rail — discoverability', () => {
  test('every control is reachable without opening any disclosure', async ({ page }) => {
    await openChat(page, { state: 'active' });

    // This is the whole point of the change: all nine controls on first paint.
    for (const id of [
      'files',
      'git',
      'workspace',
      'timeline',
      'comments',
      'retry',
      'fork',
      'report',
      'complete',
      'details',
    ]) {
      await expect(page.getByTestId(`session-tool-${id}`)).toBeVisible();
    }

    // And the details panel is still shut — nothing was expanded to get here.
    await expect(page.getByText('References')).toHaveCount(0);

    await capture(page, 'tool-rail-active-icons');
  });

  test('icon-only controls carry full-sentence accessible names', async ({ page }) => {
    await openChat(page, { state: 'active' });

    // An unlabeled icon is exactly the problem being fixed. In icon mode the glyph is
    // the entire visible affordance, so the accessible name has to carry the meaning.
    for (const [id, name] of [
      ['files', 'Browse workspace files'],
      ['git', 'Review uncommitted changes'],
      ['timeline', 'Jump through session history'],
      ['retry', 'Retry — re-run this task'],
      ['complete', 'Mark this task complete'],
      ['details', 'Show session details, IDs and infrastructure'],
    ] as const) {
      await expect(page.getByTestId(`session-tool-${id}`)).toHaveAttribute('aria-label', name);
    }
  });

  test('a sleeping session hides the workspace-bound tools but keeps the rest', async ({
    page,
  }) => {
    await openChat(page, { state: 'sleeping' });

    await expect(page.getByTestId('session-tool-files')).toHaveCount(0);
    await expect(page.getByTestId('session-tool-git')).toHaveCount(0);
    await expect(page.getByTestId('session-tool-workspace')).toHaveCount(0);
    // Liveness beside those absences.
    await expect(page.getByTestId('session-tool-timeline')).toBeVisible();
    await expect(page.getByTestId('session-tool-comments')).toBeVisible();

    await capture(page, 'tool-rail-sleeping-icons');
  });
});

test.describe('Session tool rail — expand and contract', () => {
  test('cycles icons → labels → hidden → icons through its own control', async ({ page }) => {
    await openChat(page, { state: 'active' });

    const rail = page.getByTestId('session-tool-rail');
    await expect(rail).toHaveAttribute('data-mode', 'icons');
    // Icon mode shows no label text.
    await expect(page.getByTestId('session-tool-timeline')).not.toContainText('Timeline');

    await page.getByTestId('session-tool-rail-cycle').click();
    await expect(rail).toHaveAttribute('data-mode', 'labels');
    await expect(page.getByTestId('session-tool-timeline')).toContainText('Timeline');
    await capture(page, 'tool-rail-active-labels');

    await page.getByTestId('session-tool-rail-cycle').click();
    await expect(rail).toHaveCount(0);
    await expect(page.getByTestId('session-tool-rail-tab')).toBeVisible();
    await capture(page, 'tool-rail-active-hidden');

    await page.getByTestId('session-tool-rail-tab').click();
    await expect(page.getByTestId('session-tool-rail')).toHaveAttribute('data-mode', 'icons');
  });

  test('remembers the chosen mode across a reload', async ({ page }) => {
    await openChat(page, { state: 'active' });
    await page.getByTestId('session-tool-rail-cycle').click();
    await expect(page.getByTestId('session-tool-rail')).toHaveAttribute('data-mode', 'labels');

    await page.reload();
    await expect(page.getByTestId('session-tool-rail')).toHaveAttribute('data-mode', 'labels', {
      timeout: 15_000,
    });
  });

  test('hidden mode still exposes a labelled pull-tab', async ({ page }) => {
    await openChat(page, { state: 'active', mode: 'hidden' });
    const tab = page.getByTestId('session-tool-rail-tab');
    await expect(tab).toBeVisible();
    await expect(tab).toHaveAttribute('aria-label', /activate for icons only/i);
  });
});

test.describe('Session tool rail — layout', () => {
  test('labels overlay on mobile and push on desktop', async ({ page }) => {
    // A 158px labels rail is 42% of a 375px viewport. Left pushing, it collapsed message
    // bubbles to ~200px with code spans breaking mid-token, so on mobile it floats
    // instead. Asserting the reserved gutter — not just "the rail is visible" — is what
    // makes this discriminating.
    await openChat(page, { state: 'active', mode: 'labels' });

    const gutter = await page.evaluate(() => {
      const rail = document.querySelector('[data-testid="session-tool-rail"]');
      const spacer = rail?.previousElementSibling as HTMLElement | null;
      return spacer ? spacer.getBoundingClientRect().width : -1;
    });

    const width = page.viewportSize()?.width ?? 0;
    if (width <= 767) {
      expect(gutter).toBeLessThan(80); // icon-width gutter — the rail overlays
    } else {
      expect(gutter).toBeGreaterThan(150); // full labels width — the rail pushes
    }
  });

  test('survives an expanded session-details panel', async ({ page }) => {
    await openChat(page, { state: 'active' });
    await page.getByTestId('session-tool-details').click();
    await expect(page.getByText('References')).toBeVisible();

    // The details panel makes the floating header taller than the viewport. The rail is
    // anchored to the messages container rather than to the header, so it must stay on
    // screen. Assert coordinates, not `toBeVisible()` — an element parked below the fold
    // still counts as "visible" to Playwright.
    const box = await page.getByTestId('session-tool-rail').boundingBox();
    const viewportHeight = page.viewportSize()?.height ?? 0;
    expect(box).not.toBeNull();
    expect(box!.y).toBeLessThan(viewportHeight * 0.5);
    expect(box!.height).toBeGreaterThan(100);

    await capture(page, 'tool-rail-details-open');
  });

  test('long titles and unbroken tokens do not overflow', async ({ page }) => {
    await openChat(page, { state: 'active', long: true, messagesLong: true });
    await capture(page, 'tool-rail-long-content');
  });

  test('renders over an empty conversation', async ({ page }) => {
    await openChat(page, { state: 'active', empty: true });
    await expect(page.getByTestId('session-tool-details')).toBeVisible();
    await capture(page, 'tool-rail-empty-conversation');
  });

  test('every tool stays reachable when the rail overflows', async ({ page }) => {
    await openChat(page, { state: 'active' });

    // Ten tools on a short viewport can exceed the rail's height. The list must be a
    // real scroller, not clipped — otherwise Complete and Details become unreachable.
    const list = page.getByTestId('session-tool-rail').locator('> div').last();
    const overflowY = await list.evaluate((el) => getComputedStyle(el).overflowY);
    expect(['auto', 'scroll']).toContain(overflowY);

    for (const id of ['files', 'complete', 'details']) {
      const tool = page.getByTestId(`session-tool-${id}`);
      await tool.scrollIntoViewIfNeeded();
      await expect(tool).toBeInViewport();
    }
  });

  test('does not collide with the scroll-to-bottom button', async ({ page }) => {
    await openChat(page, { state: 'active' });
    const scrollBtn = page.getByRole('button', { name: 'Scroll to bottom' });
    if (await scrollBtn.isVisible().catch(() => false)) {
      const scrollBox = await scrollBtn.boundingBox();
      const railBox = await page.getByTestId('session-tool-rail').boundingBox();
      expect(scrollBox).not.toBeNull();
      expect(railBox).not.toBeNull();
      // The scroll button lives inside the narrowed chat column, so its right edge must
      // stay left of the rail.
      expect(scrollBox!.x + scrollBox!.width).toBeLessThanOrEqual(railBox!.x + 1);
    }
  });
});

test.describe('Session tool rail — actions', () => {
  test('Report opens the report dialog', async ({ page }) => {
    await openChat(page, { state: 'active', reportEnabled: true });
    await page.getByTestId('session-tool-report').click();
    await expect(page.getByRole('dialog', { name: 'Report an issue' })).toBeVisible();
  });

  test('Report is absent when the platform disables it', async ({ page }) => {
    await openChat(page, { state: 'active', reportEnabled: false });
    await expect(page.getByTestId('session-tool-report')).toHaveCount(0);
    await expect(page.getByTestId('session-tool-details')).toBeVisible();
  });

  test('Complete asks for confirmation before mutating', async ({ page }) => {
    await openChat(page, { state: 'active' });
    await page.getByTestId('session-tool-complete').click();
    await expect(page.getByText('Mark task as complete?')).toBeVisible();
  });

  test('Complete is absent for an already-completed task', async ({ page }) => {
    await openChat(page, { state: 'active', taskStatus: 'completed' });
    await expect(page.getByTestId('session-tool-complete')).toHaveCount(0);
    await expect(page.getByTestId('session-tool-details')).toBeVisible();
  });

  test('Timeline opens the timeline drawer', async ({ page }) => {
    await openChat(page, { state: 'active' });
    await page.getByTestId('session-tool-timeline').click();
    await expect(page.getByRole('dialog', { name: 'Session timeline' })).toBeVisible();
  });

  test('Workspace is a real link to the workspace view', async ({ page }) => {
    await openChat(page, { state: 'active' });
    await expect(page.getByTestId('session-tool-workspace')).toHaveAttribute(
      'href',
      `/workspaces/${WORKSPACE_ID}`
    );
  });
});
