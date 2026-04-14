/**
 * Playwright visual audit — Retry & Fork buttons + dialogs.
 *
 * Covers: SessionHeader compact row with retry/fork icons,
 * RetryDialog, ForkDialog.
 *
 * Scenarios: normal, long text, loading states, error states,
 * session without task (buttons hidden), special characters.
 *
 * Viewports: iPhone SE 375x667 (mobile) + Desktop 1280x800.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock data constants
// ---------------------------------------------------------------------------

/** BetterAuth session response shape for /api/auth/get-session */
const AUTH_SESSION = {
  user: {
    id: 'u1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'sess-auth-1',
    userId: 'u1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

/** ProjectDetailResponse — must include summary field */
const MOCK_PROJECT = {
  id: 'proj-1',
  name: 'Backend API',
  repository: 'org/backend',
  githubRepoId: 12345,
  githubRepoNodeId: 'R_abc',
  defaultBranch: 'main',
  userId: 'u1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultWorkspaceProfile: null,
  defaultDevcontainerConfigName: null,
  defaultAgentType: null,
  description: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  summary: {
    activeWorkspaceCount: 0,
    activeSessionCount: 1,
    lastActivityAt: new Date().toISOString(),
    taskCountsByStatus: { failed: 1 },
    linkedWorkspaces: 0,
  },
};

const MOCK_TASK = {
  id: 'task-1',
  projectId: 'proj-1',
  userId: 'u1',
  title: 'Fix auth',
  description: 'Fix the authentication flow in the API middleware.',
  status: 'failed',
  errorMessage: 'Agent crashed unexpectedly after 47 steps',
  outputBranch: 'sam/fix-auth-flow',
  outputPrUrl: null,
  trigger: null,
  triggerExecution: null,
  parentTaskId: null,
  taskMode: 'task',
  priority: 0,
  blocked: false,
  agentProfileHint: null,
  dispatchDepth: 0,
  workspaceId: null,
  startedAt: null,
  completedAt: null,
  finalizedAt: null,
  executionStep: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  // TaskDetailResponse requires dependencies array
  dependencies: [],
};

const NOW = Date.now();

/** Stopped chat session with a failed task — retry/fork buttons appear. */
function makeTaskSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sess-task-1',
    workspaceId: null,
    taskId: 'task-1',
    topic: 'Fix the authentication flow',
    status: 'stopped',
    messageCount: 12,
    startedAt: NOW - 3600000,
    endedAt: NOW - 1800000,
    createdAt: NOW - 3600000,
    lastMessageAt: NOW - 1800000,
    isIdle: false,
    agentCompletedAt: NOW - 1800000,
    isTerminated: true,
    workspaceUrl: null,
    cleanupAt: null,
    agentSessionId: null,
    task: {
      id: 'task-1',
      status: 'failed',
      errorMessage: 'Agent crashed unexpectedly after 47 steps',
      outputBranch: 'sam/fix-auth-flow',
      outputPrUrl: null,
    },
    ...overrides,
  };
}

/** Chat session without a task — buttons must NOT appear. */
function makeNoTaskSession() {
  return {
    id: 'sess-no-task',
    workspaceId: null,
    taskId: null,
    topic: 'Quick question about API design',
    status: 'stopped',
    messageCount: 3,
    startedAt: NOW - 7200000,
    endedAt: NOW - 7100000,
    createdAt: NOW - 7200000,
    lastMessageAt: NOW - 7100000,
    isIdle: false,
    agentCompletedAt: null,
    isTerminated: true,
    workspaceUrl: null,
    cleanupAt: null,
    agentSessionId: null,
    task: null,
  };
}

const LONG_TITLE_SESSION = makeTaskSession({
  topic:
    'This is an extremely long task topic that describes in very verbose detail what the agent was asked to do, spanning well over two hundred characters in total to stress test the header compact row truncation and wrapping on narrow mobile viewports where every pixel matters',
  task: {
    id: 'task-1',
    status: 'failed',
    errorMessage:
      'Agent exceeded maximum allowed turns (200) without completing the task. The last known operation was: attempting to run the full test suite across all packages. Memory limit exceeded.',
    outputBranch:
      'sam/extremely-long-branch-name-that-goes-on-and-on',
    outputPrUrl: null,
  },
});

const SPECIAL_CHARS_SESSION = makeTaskSession({
  id: 'sess-special',
  topic: '<script>alert("xss")</script> & "Fix" \'things\' — résumé 日本語 emoji 🎉',
  task: {
    id: 'task-1',
    status: 'failed',
    errorMessage: null,
    outputBranch: null,
    outputPrUrl: null,
  },
});

const COMPLETED_SESSION = makeTaskSession({
  id: 'sess-done',
  topic: 'Add OAuth login',
  task: {
    id: 'task-1',
    status: 'completed',
    errorMessage: null,
    outputBranch: 'sam/add-oauth',
    outputPrUrl: 'https://github.com/org/backend/pull/42',
  },
});

// ---------------------------------------------------------------------------
// Mock API helper — correct response shapes discovered through debug runs
// ---------------------------------------------------------------------------

async function setupApiMocks(
  page: Page,
  sessions: unknown[],
  options: {
    taskDescription?: string;
    summaryError?: boolean;
  } = {},
) {
  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    const method = route.request().method();
    // Extract the /api/... path+query portion
    const pathMatch = url.match(/\/api\/.*/);
    const p = pathMatch ? pathMatch[0] : '';

    // BetterAuth session — called by useSession hook at startup
    if (p.startsWith('/api/auth/get-session')) {
      return route.fulfill({ json: AUTH_SESSION });
    }
    if (p.startsWith('/api/auth/')) {
      return route.fulfill({ json: {} });
    }

    // Notifications WebSocket upgrade triggers HTTP first — return empty
    if (p.startsWith('/api/notifications')) {
      return route.fulfill({ json: { notifications: [], total: 0 } });
    }

    // Project detail (called by Project.tsx)
    if (p === '/api/projects/proj-1' || p.startsWith('/api/projects/proj-1?')) {
      return route.fulfill({ json: { project: MOCK_PROJECT } });
    }
    // Project list (fallback)
    if (p === '/api/projects' || p.startsWith('/api/projects?')) {
      return route.fulfill({ json: { projects: [MOCK_PROJECT], total: 1 } });
    }

    // GitHub installations — must be array, NOT { installations: [] }
    if (p.startsWith('/api/github/installations')) {
      return route.fulfill({ json: [] });
    }

    // Slash commands (cached-commands or commands)
    if (p.includes('/cached-commands') || p.includes('/commands')) {
      return route.fulfill({ json: { commands: [] } });
    }

    // Credentials — listCredentials() expects the response to BE the array directly
    if (p === '/api/credentials' || p.startsWith('/api/credentials?')) {
      return route.fulfill({ json: [] });
    }

    // Trial status
    if (p.startsWith('/api/trial-status') || p.startsWith('/api/trial')) {
      return route.fulfill({ json: { available: false } });
    }

    // Agents list
    if (p === '/api/agents' || p.startsWith('/api/agents?')) {
      return route.fulfill({ json: { agents: [] } });
    }

    // Agent profiles — listAgentProfiles() expects { items: AgentProfile[] }
    if (p.includes('/agent-profiles')) {
      return route.fulfill({ json: { items: [] } });
    }

    // Task detail (individual task fetch — for Retry dialog pre-fill)
    // Must include dependencies: [] (TaskDetailResponse shape)
    if (p.includes('/tasks/task-1') && method === 'GET') {
      return route.fulfill({
        json: {
          ...MOCK_TASK,
          description:
            options.taskDescription ?? MOCK_TASK.description,
        },
      });
    }

    // Task list
    if (p.includes('/tasks') && method === 'GET') {
      return route.fulfill({ json: { tasks: [MOCK_TASK], total: 1 } });
    }

    // Session summarize
    if (p.includes('/summarize')) {
      if (options.summaryError) {
        return route.fulfill({ status: 500, json: { error: 'AI service unavailable' } });
      }
      return route.fulfill({
        json: {
          summary:
            'The agent attempted to fix the authentication flow. It updated the JWT validation middleware and wrote unit tests. The tests revealed an edge case with token expiry that was not fully resolved before the session ended.',
          messageCount: 12,
          filteredCount: 8,
          method: 'ai',
        },
      });
    }

    // Session messages
    if (p.includes('/messages') && method === 'GET') {
      return route.fulfill({ json: { messages: [], total: 0 } });
    }

    // Individual session — getChatSession expects { session, messages, hasMore }
    if (p.match(/\/sessions\/[^/?]+(\?|$)/) && method === 'GET') {
      const sessionId = p.match(/\/sessions\/([^/?]+)/)?.[1];
      const found = sessions.find(
        (s) => (s as Record<string, unknown>).id === sessionId,
      );
      if (found) return route.fulfill({ json: { session: found, messages: [], hasMore: false } });
      return route.fulfill({ status: 404, json: { error: 'Not found' } });
    }

    // Sessions list
    if (p.includes('/sessions') && method === 'GET') {
      return route.fulfill({ json: { sessions, total: sessions.length } });
    }

    // Transcribe API URL
    if (p.includes('/transcribe')) {
      return route.fulfill({ json: { url: null } });
    }

    // Workspace data — not needed for these tests
    if (p.startsWith('/api/workspaces/')) {
      return route.fulfill({ status: 404, json: { error: 'Not found' } });
    }

    // Error reporting and analytics — ignore
    if (p.startsWith('/api/client-errors') || p.startsWith('/api/t')) {
      return route.fulfill({ json: {} });
    }

    // Default fallback
    return route.fulfill({ json: {} });
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
}

/** Navigate to a project chat session. Waits for auth + initial data load. */
async function gotoSession(page: Page, sessions: unknown[], sessionId: string) {
  await setupApiMocks(page, sessions);
  await page.goto(`http://localhost:4175/projects/proj-1/chat/${sessionId}`);
  // Allow auth, project fetch, sessions fetch and session detail fetch to complete
  await page.waitForTimeout(3000);
}

// ---------------------------------------------------------------------------
// Mobile Tests
// ---------------------------------------------------------------------------

test.describe('Retry & Fork Buttons — Mobile (375x667)', () => {
  test('session header shows Retry and Fork buttons when task exists', async ({ page }) => {
    await gotoSession(page, [makeTaskSession()], 'sess-task-1');

    await expect(page.getByRole('button', { name: 'Retry task' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fork session' })).toBeVisible();

    // Verify touch target meets 44px minimum (min-w-[44px] min-h-[44px])
    const box = await page.getByRole('button', { name: 'Retry task' }).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);

    await assertNoOverflow(page);
    await screenshot(page, 'retry-fork-header-with-task-mobile');
  });

  test('session header hides buttons when session has no task', async ({ page }) => {
    await gotoSession(page, [makeNoTaskSession()], 'sess-no-task');

    await expect(page.getByRole('button', { name: 'Retry task' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Fork session' })).not.toBeVisible();

    await assertNoOverflow(page);
    await screenshot(page, 'retry-fork-header-no-task-mobile');
  });

  test('long topic truncates cleanly — compact row does not overflow', async ({ page }) => {
    await gotoSession(page, [LONG_TITLE_SESSION], 'sess-task-1');

    await assertNoOverflow(page);
    await screenshot(page, 'retry-fork-header-long-topic-mobile');
  });

  test('special characters in topic do not break layout', async ({ page }) => {
    await gotoSession(page, [SPECIAL_CHARS_SESSION], 'sess-special');

    await assertNoOverflow(page);
    await screenshot(page, 'retry-fork-header-special-chars-mobile');
  });

  test('Retry dialog — opens and shows title', async ({ page }) => {
    await gotoSession(page, [makeTaskSession()], 'sess-task-1');

    await page.getByRole('button', { name: 'Retry task' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Retry task' })).toBeVisible();

    await assertNoOverflow(page);
    await screenshot(page, 'retry-dialog-opening-mobile');
  });

  test('Retry dialog — loaded with original task description pre-filled', async ({ page }) => {
    await setupApiMocks(page, [makeTaskSession()], {
      taskDescription: 'Fix the authentication flow in the API middleware and ensure all edge cases are handled.',
    });
    await page.goto('http://localhost:4175/projects/proj-1/chat/sess-task-1');
    await page.waitForTimeout(3000);

    await page.getByRole('button', { name: 'Retry task' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForTimeout(800);

    await assertNoOverflow(page);
    await screenshot(page, 'retry-dialog-loaded-mobile');
  });

  test('Retry dialog — summary error still allows submit', async ({ page }) => {
    await setupApiMocks(page, [makeTaskSession()], { summaryError: true });
    await page.goto('http://localhost:4175/projects/proj-1/chat/sess-task-1');
    await page.waitForTimeout(3000);

    await page.getByRole('button', { name: 'Retry task' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForTimeout(800);

    await assertNoOverflow(page);
    await screenshot(page, 'retry-dialog-summary-error-mobile');
  });

  test('Retry dialog — long task description wraps in textarea', async ({ page }) => {
    await setupApiMocks(page, [LONG_TITLE_SESSION], {
      taskDescription:
        'A'.repeat(400) + ' — end of very long task description that must wrap cleanly inside the textarea without causing layout overflow on mobile.',
    });
    await page.goto('http://localhost:4175/projects/proj-1/chat/sess-task-1');
    await page.waitForTimeout(3000);

    await page.getByRole('button', { name: 'Retry task' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForTimeout(800);

    await assertNoOverflow(page);
    await screenshot(page, 'retry-dialog-long-description-mobile');
  });

  test('Retry dialog — Escape key closes it', async ({ page }) => {
    await gotoSession(page, [makeTaskSession()], 'sess-task-1');

    await page.getByRole('button', { name: 'Retry task' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('Fork dialog — opens with "Continue from previous session" heading', async ({ page }) => {
    await gotoSession(page, [makeTaskSession()], 'sess-task-1');

    await page.getByRole('button', { name: 'Fork session' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Continue from previous session' }),
    ).toBeVisible();

    await assertNoOverflow(page);
    await screenshot(page, 'fork-dialog-opening-mobile');
  });

  test('Fork dialog — MCP template pre-filled in message field after load', async ({ page }) => {
    await gotoSession(page, [makeTaskSession()], 'sess-task-1');

    await page.getByRole('button', { name: 'Fork session' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForTimeout(800);

    const msgArea = page.getByPlaceholder('Describe the next task...');
    await expect(msgArea).toBeVisible();
    const value = await msgArea.inputValue();
    expect(value).toContain('get_session_messages');

    await assertNoOverflow(page);
    await screenshot(page, 'fork-dialog-loaded-mobile');
  });

  test('Fork dialog — summary error shows warning, message field still editable', async ({
    page,
  }) => {
    await setupApiMocks(page, [makeTaskSession()], { summaryError: true });
    await page.goto('http://localhost:4175/projects/proj-1/chat/sess-task-1');
    await page.waitForTimeout(3000);

    await page.getByRole('button', { name: 'Fork session' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForTimeout(800);

    await assertNoOverflow(page);
    await screenshot(page, 'fork-dialog-summary-error-mobile');
  });

  test('Fork dialog — Escape key closes it', async ({ page }) => {
    await gotoSession(page, [makeTaskSession()], 'sess-task-1');

    await page.getByRole('button', { name: 'Fork session' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog')).not.toBeVisible();
  });

  test('completed session — both buttons visible (retry/fork apply regardless of outcome)', async ({
    page,
  }) => {
    await gotoSession(page, [COMPLETED_SESSION], 'sess-done');

    await expect(page.getByRole('button', { name: 'Retry task' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fork session' })).toBeVisible();

    await assertNoOverflow(page);
    await screenshot(page, 'retry-fork-completed-session-mobile');
  });
});

// ---------------------------------------------------------------------------
// Desktop Tests
// ---------------------------------------------------------------------------

test.describe('Retry & Fork Buttons — Desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('session header compact row with Retry and Fork buttons', async ({ page }) => {
    await gotoSession(page, [makeTaskSession()], 'sess-task-1');

    await expect(page.getByRole('button', { name: 'Retry task' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fork session' })).toBeVisible();

    await assertNoOverflow(page);
    await screenshot(page, 'retry-fork-header-desktop');
  });

  test('Retry dialog — desktop layout with loaded content', async ({ page }) => {
    await setupApiMocks(page, [makeTaskSession()], {
      taskDescription: 'Fix the authentication flow in the API middleware.',
    });
    await page.goto('http://localhost:4175/projects/proj-1/chat/sess-task-1');
    await page.waitForTimeout(3000);

    await page.getByRole('button', { name: 'Retry task' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForTimeout(800);

    await assertNoOverflow(page);
    await screenshot(page, 'retry-dialog-desktop');
  });

  test('Fork dialog — desktop layout with MCP template', async ({ page }) => {
    await gotoSession(page, [makeTaskSession()], 'sess-task-1');

    await page.getByRole('button', { name: 'Fork session' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.waitForTimeout(800);

    const msgArea = page.getByPlaceholder('Describe the next task...');
    await expect(msgArea).toBeVisible();
    const value = await msgArea.inputValue();
    expect(value).toContain('get_session_messages');

    await assertNoOverflow(page);
    await screenshot(page, 'fork-dialog-desktop');
  });

  test('long topic — compact row does not overflow on desktop', async ({ page }) => {
    await gotoSession(page, [LONG_TITLE_SESSION], 'sess-task-1');

    await assertNoOverflow(page);
    await screenshot(page, 'retry-fork-long-title-desktop');
  });

  test('no task session — buttons absent on desktop', async ({ page }) => {
    await gotoSession(page, [makeNoTaskSession()], 'sess-no-task');

    await expect(page.getByRole('button', { name: 'Retry task' })).not.toBeVisible();
    await expect(page.getByRole('button', { name: 'Fork session' })).not.toBeVisible();

    await assertNoOverflow(page);
    await screenshot(page, 'retry-fork-no-task-desktop');
  });
});
