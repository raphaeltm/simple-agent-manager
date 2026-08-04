import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const ADMIN = makeMockUser({
  email: 'debug-admin@example.com',
  name: 'Debug Admin',
  role: 'superadmin',
  sessionId: 'debug-session',
  userId: 'debug-admin',
});

const ERROR = {
  id: 'err-debug-1', source: 'api', level: 'error',
  message: 'Workspace transition failed for café deployment — <script> is text',
  stack: 'Error: transition failed\n    at reconcile (/worker/src/reconcile.ts:42:7)',
  context: { requestId: 'req-debug', retry: 3 },
  userId: 'visible-to-admin', nodeId: 'node-debug', workspaceId: 'workspace-debug',
  ipAddress: '203.0.113.9', userAgent: 'Audit browser', timestamp: '2026-07-29T10:00:00.000Z',
};

const DIAGNOSIS = {
  id: 'diag-1', errorId: ERROR.id,
  startTime: '2026-07-29T09:45:00.000Z', endTime: '2026-07-29T10:15:00.000Z',
  diagnosis: `Summary\nThe workspace transition failed after a node heartbeat gap.\n\nEvidence\n${'A bounded, redacted correlation point. '.repeat(24)}\n\nLikely cause\nThe node was unavailable during reconciliation.\n\nRecommended actions\n1. Check node health.\n2. Retry only after heartbeats recover.`,
  model: '@cf/zai-org/glm-5.2', turns: 3, inputTokens: 3100, outputTokens: 700,
  dailyTokensUsed: 12345, dailyTokenLimit: 120000, ideaId: null,
  createdBy: 'debug-admin', createdAt: '2026-07-29T10:16:00.000Z',
  usage: { turns: 3, inputTokens: 3100, outputTokens: 700, totalTokens: 3800, dailyTokensUsed: 12345, dailyTokenLimit: 120000 },
};

const RUNNING_RUN = {
  id: 'run-running-1',
  status: 'running',
  errorId: ERROR.id,
  startTime: '2026-07-29T09:45:00.000Z',
  endTime: '2026-07-29T10:15:00.000Z',
  createdBy: 'debug-admin',
  createdAt: '2026-07-29T10:20:00.000Z',
  updatedAt: '2026-07-29T10:20:10.000Z',
  startedAt: '2026-07-29T10:20:02.000Z',
  completedAt: null,
  diagnosisId: null,
  errorMessage: null,
  usage: { turns: 1, inputTokens: 500, outputTokens: 100, totalTokens: 600, dailyTokensUsed: 600, dailyTokenLimit: 120000 },
  retryOfRunId: null,
  currentStep: 'model:2',
  heartbeatAt: '2026-07-29T10:20:10.000Z',
  attempt: 0,
  executorVersion: 'diagnosis-runner-v1',
  cancelRequestedAt: null,
  deadlineAt: '2026-07-29T10:35:00.000Z',
};

const FAILED_RUN = {
  ...RUNNING_RUN,
  id: 'run-failed-1',
  status: 'failed',
  startedAt: '2026-07-29T10:18:02.000Z',
  completedAt: '2026-07-29T10:18:30.000Z',
  errorMessage: 'model timeout after durable acceptance',
};

const SUCCEEDED_RUN = {
  ...RUNNING_RUN,
  id: 'run-succeeded-1',
  status: 'succeeded',
  startedAt: '2026-07-29T10:16:02.000Z',
  completedAt: '2026-07-29T10:16:30.000Z',
  diagnosisId: DIAGNOSIS.id,
  diagnosis: DIAGNOSIS,
};

async function setup(page: Page, diagnosisStatus = 200) {
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const respond = (status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.includes('/api/auth/')) return respond(200, ADMIN);
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/projects')) return respond(200, { projects: [], nextCursor: null });
    if (path.includes('/api/chat-sessions')) return respond(200, { sessions: [], nextCursor: null });
    if (path.includes('/api/commands')) return respond(200, { commands: [] });
    if (path === '/api/admin/observability/errors') return respond(200, { errors: [ERROR], total: 1, cursor: null, hasMore: false });
    if (path === '/api/admin/observability/diagnoses' && request.method() === 'GET') return respond(200, { diagnoses: [DIAGNOSIS], runs: [RUNNING_RUN, FAILED_RUN, SUCCEEDED_RUN] });
    if (path === '/api/admin/observability/diagnoses' && request.method() === 'POST') {
      return diagnosisStatus === 200 ? respond(202, { run: RUNNING_RUN }) : respond(diagnosisStatus, { error: 'BUDGET_EXHAUSTED', message: 'Daily deployment debugging budget exhausted' });
    }
    if (path === '/api/admin/observability/diagnosis-runs/run-succeeded-1') return respond(200, { run: SUCCEEDED_RUN, events: [{ id: 'event-1', runId: 'run-succeeded-1', sequence: 1, stepKey: 'tool:1:errors', eventType: 'evidence', status: 'succeeded', sourceName: 'get_recent_errors', argumentsPreview: 'bounded window', evidencePreview: '<script>alert(1)</script> is inert redacted evidence', resultCount: 3, durationMs: 42, retryAttempt: 0, errorCode: null, errorMessage: null, createdAt: '2026-07-29T10:16:10.000Z' }], nextCursor: 1 });
    if (path === '/api/admin/observability/diagnosis-runs/run-running-1') return respond(200, { run: RUNNING_RUN, events: [], nextCursor: null });
    if (path === '/api/admin/observability/diagnosis-runs/run-running-1/cancel') return respond(202, { accepted: true });
    if (path === '/api/admin/observability/diagnosis-runs/run-failed-1') return respond(200, { run: FAILED_RUN, events: [{ id: 'event-failed', runId: 'run-failed-1', sequence: 1, stepKey: 'terminal:failed', eventType: 'failed', status: 'failed', sourceName: 'query_cloudflare_logs', argumentsPreview: null, evidencePreview: null, resultCount: null, durationMs: 1200, retryAttempt: 3, errorCode: 'TRANSIENT_UPSTREAM', errorMessage: 'model timeout after durable acceptance', createdAt: '2026-07-29T10:18:30.000Z' }], nextCursor: 1 });
    if (path === '/api/admin/observability/diagnosis-runs/run-failed-1/retry') return respond(202, { run: RUNNING_RUN });
    if (path === '/api/admin/observability/debug/projects') return respond(200, { projects: [
      { id: 'project-1', name: 'A project with a deliberately long deployment name' },
      { id: 'project-2', name: 'Secondary project' },
    ] });
    if (path === '/api/admin/observability/diagnoses/diag-1/idea') return respond(200, { ideaId: 'idea-draft-1' });
    return respond(200, {});
  });
}

test.describe('Deployment diagnosis visual audit', () => {
  test('renders durable detail with inert evidence HTML', async ({ page }) => {
    const name = page.viewportSize()?.width === 375 ? 'mobile' : 'desktop';
    await setup(page);
    let dialogOpened = false;
    page.on('dialog', () => { dialogOpened = true; });
    await page.goto('/admin/diagnoses/run-succeeded-1');
    await expect(page.getByRole('heading', { name: 'Diagnostic run' })).toBeVisible();
    await expect(page.getByText('get recent errors')).toBeVisible();
    await expect(page.getByText('Completed diagnosis')).toBeVisible();
    await page.getByText('Redacted evidence preview').click();
    await expect(page.getByText('<script>alert(1)</script> is inert redacted evidence')).toBeVisible();
    expect(dialogOpened).toBe(false);
    await assertNoOverflow(page);
    await screenshot(page, 'debug-diagnosis-detail-' + name);
  });

  test('renders the bounded-budget error state', async ({ page }) => {
    const name = page.viewportSize()?.width === 375 ? 'mobile' : 'desktop';
    await setup(page, 429);
    await page.goto('/admin/errors');
    await page.getByRole('button', { name: 'Diagnose', exact: true }).click();
    await expect(page.getByText('Daily deployment debugging budget exhausted')).toBeVisible();
    await screenshot(page, `debug-diagnosis-budget-error-${name}`);
    await assertNoOverflow(page);
  });

  test('shows recoverable active and cancellation states without overflow', async ({ page }) => {
    await setup(page);
    await page.goto('/admin/diagnoses/run-running-1');
    await expect(page.getByText('model:2')).toBeVisible();
    await expect(page.getByText('Accepted. Waiting for the durable executor’s first checkpoint.')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await assertNoOverflow(page);
  });

  test('shows sanitized terminal failure and retry navigation', async ({ page }) => {
    await setup(page);
    await page.goto('/admin/diagnoses/run-failed-1');
    await expect(page.getByText('Run failed safely')).toBeVisible();
    await expect(page.getByText('model timeout after durable acceptance').first()).toBeVisible();
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page).toHaveURL(/\/admin\/diagnoses\/run-running-1$/);
    await assertNoOverflow(page);
  });
});
