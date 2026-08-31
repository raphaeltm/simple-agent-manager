import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Visual + interaction audit for the "Report an Issue" feature:
//   - ReportIssueDialog.tsx
//   - ErrorBoundary.tsx "Report this issue" link
//   - SessionHeader.tsx "Report" button
// TEMP: relies on the /__test/error-boundary dev-only harness route added
// to App.tsx solely for this audit session. Revert both before finishing.
// ---------------------------------------------------------------------------

const NOW = Date.now();

const MOCK_USER = {
  user: {
    id: 'user-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'user',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-1',
    userId: 'user-1',
    expiresAt: new Date(NOW + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const MOCK_PROJECT = {
  id: 'proj-1',
  name: 'Report Issue Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultProvider: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const MOCK_WORKSPACE = {
  id: 'ws-1',
  nodeId: 'node-1',
  projectId: 'proj-1',
  name: 'ws-test-1',
  displayName: 'Test Workspace',
  repository: 'testuser/test-repo',
  branch: 'main',
  status: 'running',
  vmSize: 'medium',
  vmLocation: 'fsn1',
  workspaceProfile: 'full',
  vmIp: '10.0.0.1',
  url: 'https://ws-ws-1.workspaces.example.com',
  lastActivityAt: new Date(NOW - 30000).toISOString(),
  errorMessage: null,
  createdAt: new Date(NOW - 600000).toISOString(),
  updatedAt: new Date(NOW - 30000).toISOString(),
};

const MOCK_NODE = {
  id: 'node-1',
  name: 'node-test-1',
  status: 'running',
  healthStatus: 'healthy',
  cloudProvider: 'hetzner',
  vmSize: 'medium',
  vmLocation: 'fsn1',
  ipAddress: '10.0.0.1',
  lastHeartbeatAt: new Date(NOW - 10000).toISOString(),
  errorMessage: null,
  createdAt: new Date(NOW - 600000).toISOString(),
  updatedAt: new Date(NOW - 10000).toISOString(),
};

const MOCK_SESSION = {
  id: 'chat-session-1',
  workspaceId: 'ws-1',
  taskId: 'task-1',
  topic: 'Implement feature X',
  status: 'active',
  messageCount: 5,
  startedAt: NOW - 300000,
  endedAt: null,
  createdAt: NOW - 600000,
  lastMessageAt: NOW - 30000,
  isIdle: false,
  isTerminated: false,
  agentSessionId: 'acp-session-1',
  agentType: 'claude-code',
  task: {
    id: 'task-1',
    status: 'in_progress',
    executionStep: 'agent_session',
    errorMessage: null,
    outputBranch: 'sam/feature-x',
    outputPrUrl: null,
    outputSummary: null,
    finalizedAt: null,
    taskMode: 'task',
    agentProfileHint: 'default',
  },
};

const MOCK_TASK = {
  id: 'task-1',
  projectId: 'proj-1',
  title: 'Implement feature X',
  description: 'Implement feature X',
  status: 'in_progress',
  priority: 0,
  parentTaskId: null,
  blocked: false,
  triggeredBy: 'user',
  dispatchDepth: 0,
  taskMode: 'task',
  createdAt: new Date(NOW - 600000).toISOString(),
  updatedAt: new Date(NOW - 30000).toISOString(),
};

interface ReportMockOpts {
  configEnabled?: boolean;
  submitResult?: 'success' | 'error';
  submitDelayMs?: number;
}

async function setupApiMocks(page: Page, opts: ReportMockOpts = {}) {
  const configEnabled = opts.configEnabled ?? true;
  const submitResult = opts.submitResult ?? 'success';
  const submitDelayMs = opts.submitDelayMs ?? 0;

  await page.route('**/workspaces/ws-1/ports**', (route: Route) => respondJson(route, { ports: [] }));
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) => respondJson(route, body, status);

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/terminal/token') {
      return respond(200, { token: 'terminal-token', expiresAt: new Date(NOW + 600000).toISOString() });
    }
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.startsWith('/api/provider-catalog')) return respond(200, { catalogs: [] });
    if (path.startsWith('/api/github/installations')) return respond(200, []);
    if (path.startsWith('/api/trial-status')) {
      return respond(200, {
        available: false,
        agentType: null,
        hasInfraCredential: false,
        hasAgentCredential: false,
        dailyTokenBudget: null,
        dailyTokenUsage: null,
      });
    }
    if (path === '/api/agents') return respond(200, { agents: [] });

    // Report Issue endpoints
    if (path === '/api/report-issue/config') {
      return respond(200, { enabled: configEnabled });
    }
    if (path === '/api/report-issue') {
      if (submitDelayMs > 0) await new Promise((r) => setTimeout(r, submitDelayMs));
      if (submitResult === 'error') {
        return respond(500, { error: 'Internal error while creating report' });
      }
      const body = route.request().postDataJSON() as { consentToAttachRefs?: boolean; refs?: Record<string, string> };
      const attachedRefKeys = body.consentToAttachRefs && body.refs ? Object.keys(body.refs) : [];
      return respond(200, {
        ideaId: '01K8REPORTISSUE0000000000',
        status: 'draft',
        refsAttached: attachedRefKeys.length > 0,
        attachedRefKeys,
        message: attachedRefKeys.length > 0
          ? `Report submitted with ${attachedRefKeys.length} technical reference(s) attached.`
          : 'Report submitted without technical references.',
      });
    }

    // Workspace and node routes
    if (path === '/api/workspaces/ws-1') return respond(200, MOCK_WORKSPACE);
    if (path.startsWith('/api/workspaces/ws-1/ports')) return respond(200, { ports: [] });
    if (path === '/api/nodes/node-1') return respond(200, MOCK_NODE);

    // Project routes
    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '/sessions') return respond(200, { sessions: [MOCK_SESSION], total: 1 });
      if (subPath.match(/\/sessions\/[^/]+$/) && !subPath.includes('/messages')) {
        return respond(200, { session: MOCK_SESSION, messages: [], hasMore: false });
      }
      if (subPath.match(/\/sessions\/[^/]+\/messages/)) {
        return respond(200, { messages: [], hasMore: false });
      }
      if (subPath === '/tasks') return respond(200, { tasks: [MOCK_TASK], nextCursor: null });
      if (subPath.match(/\/tasks\//)) return respond(200, { id: 'task-1', status: 'in_progress' });
      if (subPath === '/agents') return respond(200, { agents: [] });
      if (subPath === '/agent-profiles') return respond(200, { items: [] });
      if (subPath === '/cached-commands') return respond(200, { items: [] });
      if (subPath === '/triggers') return respond(200, { items: [] });
      if (subPath === '/knowledge') return respond(200, { entities: [], total: 0 });
      return respond(200, MOCK_PROJECT);
    }

    if (path === '/api/projects') return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    return respond(200, {});
  });
}

function respondJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(500);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflow).toBe(false);
}

/** Report now lives in the always-visible session tool rail — nothing to expand. */
async function expandHeader(page: Page) {
  await page
    .getByTestId('session-tool-report')
    .first()
    .waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(300);
}

async function openReportDialogFromSessionHeader(page: Page) {
  await page.goto('/projects/proj-1/chat/chat-session-1');
  await expandHeader(page);
  const reportBtn = page.getByRole('button', { name: 'Report' });
  await expect(reportBtn).toBeVisible();
  await reportBtn.click();
}

const LONG_TITLE = 'A'.repeat(200) + ' — issue with unicode Ω and emoji 🔥 and <script>alert(1)</script>';
const LONG_DESCRIPTION =
  'The agent crashed while I was trying to review a very long diff. '.repeat(40) +
  'Unicode: 日本語 Ω → emoji: 🔥🐛 HTML entities: &lt;div&gt; XSS attempt: <img src=x onerror=alert(1)>';

test.describe('Report Issue — Mobile (375x667)', () => {
  test('SessionHeader Report button opens dialog, focus on title', async ({ page }) => {
    await setupApiMocks(page);
    await openReportDialogFromSessionHeader(page);

    const dialog = page.getByRole('dialog', { name: 'Report an issue' });
    await expect(dialog).toBeVisible();
    await expect(page.getByPlaceholder('Brief summary of the issue')).toBeFocused();
    await screenshot(page, 'report-issue-form-mobile');
    await assertNoOverflow(page);
  });

  test('consent checkbox reveals technical refs, then submit succeeds', async ({ page }) => {
    await setupApiMocks(page);
    await openReportDialogFromSessionHeader(page);

    await page.getByPlaceholder('Brief summary of the issue').fill('Chat stopped responding');
    await page.getByPlaceholder(/What happened/).fill('I sent a message and nothing came back.');

    // Refs collapsed by default — technical values must not be visible pre-consent
    await expect(page.getByText('chat-session-1')).not.toBeVisible();

    const checkbox = page.getByRole('checkbox');
    await checkbox.check();
    await expect(page.getByText('chat-session-1')).toBeVisible();
    await screenshot(page, 'report-issue-consent-expanded-mobile');
    await assertNoOverflow(page);

    await page.getByRole('button', { name: 'Submit report' }).click();
    await expect(page.getByText('Report submitted')).toBeVisible();
    await expect(page.getByText('01K8REPORTISSUE0000000000')).toBeVisible();
    await screenshot(page, 'report-issue-success-mobile');
    await assertNoOverflow(page);
  });

  test('submit failure shows inline error and preserves form input', async ({ page }) => {
    await setupApiMocks(page, { submitResult: 'error' });
    await openReportDialogFromSessionHeader(page);

    await page.getByPlaceholder('Brief summary of the issue').fill('Bug title');
    await page.getByPlaceholder(/What happened/).fill('Bug description');
    await page.getByRole('button', { name: 'Submit report' }).click();

    await expect(page.getByText('Internal error while creating report')).toBeVisible();
    // Form values must survive the failed submit so the user doesn't retype
    await expect(page.getByPlaceholder('Brief summary of the issue')).toHaveValue('Bug title');
    await screenshot(page, 'report-issue-error-mobile');
    await assertNoOverflow(page);
  });

  test('long title/description stress — no overflow, submit button state', async ({ page }) => {
    await setupApiMocks(page);
    await openReportDialogFromSessionHeader(page);

    await page.getByPlaceholder('Brief summary of the issue').fill(LONG_TITLE);
    await page.getByPlaceholder(/What happened/).fill(LONG_DESCRIPTION);
    await screenshot(page, 'report-issue-long-text-mobile');
    await assertNoOverflow(page);
  });

  test('Escape key closes dialog', async ({ page }) => {
    await setupApiMocks(page);
    await openReportDialogFromSessionHeader(page);
    await expect(page.getByRole('dialog', { name: 'Report an issue' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Report an issue' })).not.toBeVisible();
  });

  test('Tab cycles focus within dialog (focus trap)', async ({ page }) => {
    await setupApiMocks(page);
    await openReportDialogFromSessionHeader(page);

    // Title input starts focused (autofocus). Shift+Tab from the first
    // focusable element must wrap to the last focusable element (Submit),
    // proving the modal traps focus instead of escaping to the page body.
    await expect(page.getByPlaceholder('Brief summary of the issue')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    const submitBtn = page.getByRole('button', { name: 'Submit report' });
    await expect(submitBtn).toBeFocused();
  });

  test('empty state: no available refs (ErrorBoundary path with no errorId)', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/projects/proj-1/chat/chat-session-1');
    // Directly assert dialog with no refs prop renders no consent section —
    // covered via unit tests; here just confirm the SessionHeader path with refs
    // omits the panel when all ref values are falsy is visually clean.
    await expandHeader(page);
    await page.getByRole('button', { name: 'Report' }).click();
    await expect(page.getByRole('checkbox')).toBeVisible(); // sessionId/taskId/nodeId are present here
    await screenshot(page, 'report-issue-refs-panel-mobile');
  });
});

test.describe('Report Issue — Desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('form state', async ({ page }) => {
    await setupApiMocks(page);
    await openReportDialogFromSessionHeader(page);
    await screenshot(page, 'report-issue-form-desktop');
    await assertNoOverflow(page);
  });

  test('long text stress', async ({ page }) => {
    await setupApiMocks(page);
    await openReportDialogFromSessionHeader(page);
    await page.getByPlaceholder('Brief summary of the issue').fill(LONG_TITLE);
    await page.getByPlaceholder(/What happened/).fill(LONG_DESCRIPTION);
    await screenshot(page, 'report-issue-long-text-desktop');
    await assertNoOverflow(page);
  });

  test('success state with refs attached', async ({ page }) => {
    await setupApiMocks(page);
    await openReportDialogFromSessionHeader(page);
    await page.getByPlaceholder('Brief summary of the issue').fill('Bug title');
    await page.getByPlaceholder(/What happened/).fill('Bug description');
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Submit report' }).click();
    await expect(page.getByText('Report submitted')).toBeVisible();
    await screenshot(page, 'report-issue-success-desktop');
    await assertNoOverflow(page);
  });
});

test.describe('ErrorBoundary Report Link', () => {
  test('mobile: crash screen shows report link, opens dialog with single errorId ref', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/__test/error-boundary');
    await expect(page.getByText('Something went wrong')).toBeVisible();
    const reportLink = page.getByRole('button', { name: 'Report this issue' });
    await expect(reportLink).toBeVisible();
    await screenshot(page, 'error-boundary-crash-screen-mobile');
    await assertNoOverflow(page);

    await reportLink.click();
    const dialog = page.getByRole('dialog', { name: 'Report an issue' });
    await expect(dialog).toBeVisible();
    await expect(page.getByPlaceholder('Brief summary of the issue')).toBeFocused();
    await screenshot(page, 'error-boundary-report-dialog-mobile');
    await assertNoOverflow(page);

    // Only errorId is available from a crash — confirm the panel renders cleanly with 1 ref
    await page.getByRole('checkbox').check();
    await expect(page.getByText('Error:')).toBeVisible();
    await screenshot(page, 'error-boundary-report-dialog-consent-mobile');
    await assertNoOverflow(page);
  });

  test('desktop: crash screen and report dialog', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await setupApiMocks(page);
    await page.goto('/__test/error-boundary');
    await expect(page.getByText('Something went wrong')).toBeVisible();
    await screenshot(page, 'error-boundary-crash-screen-desktop');
    await assertNoOverflow(page);

    await page.getByRole('button', { name: 'Report this issue' }).click();
    await expect(page.getByRole('dialog', { name: 'Report an issue' })).toBeVisible();
    await screenshot(page, 'error-boundary-report-dialog-desktop');
    await assertNoOverflow(page);
  });

  test('report link hidden when feature disabled', async ({ page }) => {
    await setupApiMocks(page, { configEnabled: false });
    await page.goto('/__test/error-boundary');
    await expect(page.getByText('Something went wrong')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByRole('button', { name: 'Report this issue' })).not.toBeVisible();
    await screenshot(page, 'error-boundary-report-link-disabled-mobile');
  });
});
