import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const ADMIN = makeMockUser({
  email: 'debug-admin@example.com',
  name: 'Debug Admin',
  role: 'superadmin',
  sessionId: 'debug-session',
  userId: 'debug-admin',
});

const ERROR_ID = 'err-debug-1';
const INCIDENT = {
  id: '01KZ8V0GMXQ4ZCSERPRT2X2K6M',
  platformErrorId: ERROR_ID,
  nodeId: 'node-debug',
  workspaceId: 'workspace-debug',
  status: 'available',
  occurrenceCount: 77,
  lastSeenAt: '2026-07-29T10:42:00.000Z',
  artifactCount: 1,
  totalBytes: 2048,
  manifest: {
    version: 1,
    incidentId: '01KZ8V0GMXQ4ZCSERPRT2X2K6M',
    nodeId: 'node-debug',
    source: 'session-host',
    createdAt: '2026-07-29T10:00:00.000Z',
    collectors: [
      {
        name: 'structured-events',
        status: 'available',
        bytes: 1024,
        truncated: true,
        redactions: 3,
      },
    ],
    totalBytes: 1024,
    redactions: 3,
    anyTruncated: true,
  },
  preview: { health: 'degraded', malicious: '<script>alert(2)</script> is inert' },
  failureReason: null,
  expiresAt: '2026-08-05T10:00:00.000Z',
  createdAt: '2026-07-29T10:00:00.000Z',
  updatedAt: '2026-07-29T10:01:00.000Z',
  artifacts: [
    {
      id: 'artifact-safe-1',
      kind: 'safe-vm-incident-v1',
      status: 'available',
      contentType: 'application/gzip',
      sizeBytes: 2048,
      checksumSha256: 'a'.repeat(64),
      createdAt: '2026-07-29T10:00:00.000Z',
      updatedAt: '2026-07-29T10:01:00.000Z',
    },
  ],
};

const ERROR = {
  id: ERROR_ID,
  source: 'vm-agent',
  level: 'error',
  message: `Workspace transition failed for café deployment — <script> is text ${'unbroken-diagnostic-context-'.repeat(12)}`,
  stack: 'Error: transition failed\n    at reconcile (/worker/src/reconcile.ts:42:7)',
  context: { requestId: 'req-debug', retry: 3 },
  userId: 'visible-to-admin',
  nodeId: 'node-debug',
  workspaceId: 'workspace-debug',
  ipAddress: '203.0.113.9',
  userAgent: 'Audit browser',
  timestamp: '2026-07-29T10:00:00.000Z',
  incident: INCIDENT,
};

const DIAGNOSIS = {
  id: 'diag-1',
  errorId: ERROR.id,
  startTime: '2026-07-29T09:45:00.000Z',
  endTime: '2026-07-29T10:15:00.000Z',
  diagnosis: `Summary\nThe workspace transition failed after a node heartbeat gap.\n\nEvidence\n${'A bounded, redacted correlation point. '.repeat(24)}\n\nLikely cause\nThe node was unavailable during reconciliation.\n\nRecommended actions\n1. Check node health.\n2. Retry only after heartbeats recover.`,
  model: '@cf/zai-org/glm-5.2',
  turns: 3,
  inputTokens: 3100,
  outputTokens: 700,
  dailyTokensUsed: 12345,
  dailyTokenLimit: 120000,
  ideaId: null,
  createdBy: 'debug-admin',
  createdAt: '2026-07-29T10:16:00.000Z',
  usage: {
    turns: 3,
    inputTokens: 3100,
    outputTokens: 700,
    totalTokens: 3800,
    dailyTokensUsed: 12345,
    dailyTokenLimit: 120000,
  },
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
  usage: {
    turns: 1,
    inputTokens: 500,
    outputTokens: 100,
    totalTokens: 600,
    dailyTokensUsed: 600,
    dailyTokenLimit: 120000,
  },
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
  incident: INCIDENT,
};

type PaginationMode = 'complete' | 'repeated';
type IncidentFixture = typeof INCIDENT | null;

interface SetupBehavior {
  activePollingEvents?: boolean;
  cancelDelayMs?: number;
  cancelStatus?: number;
  incident?: IncidentFixture;
  retryDelayMs?: number;
  retryStatus?: number;
}

function diagnosisEvent(sequence: number) {
  const vmIncident = sequence === 2;
  return {
    id: `event-${sequence}`,
    runId: 'run-succeeded-1',
    sequence,
    stepKey: vmIncident ? 'tool:2:vm' : `tool:${sequence}:errors`,
    eventType: 'evidence',
    status: 'succeeded',
    sourceName: vmIncident ? 'get_vm_incident' : 'get_recent_errors',
    argumentsPreview: vmIncident ? 'incident err-debug-1' : 'bounded window',
    evidencePreview:
      sequence === 1
        ? '<script>alert(1)</script> is inert redacted evidence'
        : vmIncident
          ? 'second paginated evidence checkpoint'
          : `bounded evidence checkpoint ${sequence}`,
    resultCount: vmIncident ? 1 : 3,
    durationMs: vmIncident ? 18 : 42,
    retryAttempt: 0,
    errorCode: null,
    errorMessage: null,
    createdAt: new Date(Date.UTC(2026, 6, 29, 10, 16, sequence % 60)).toISOString(),
  };
}

function viewportLabel(page: Page): string {
  return String(page.viewportSize()?.width ?? 'unknown');
}

async function assertAdminViewportIsStable(page: Page) {
  const viewport = page.viewportSize();
  const main = page.locator('.sam-main-content');
  const metrics = await main.evaluate((element) => {
    const container = element.getBoundingClientRect();
    const offenders = [...element.querySelectorAll<HTMLElement>('*')]
      .map((candidate) => ({ candidate, rect: candidate.getBoundingClientRect() }))
      .filter(({ rect }) => rect.right > container.right + 1)
      .slice(0, 8)
      .map(({ candidate, rect }) => ({
        className: candidate.className,
        right: Math.round(rect.right),
        tagName: candidate.tagName,
        text: candidate.textContent?.trim().slice(0, 80),
        width: Math.round(rect.width),
      }));
    return {
      clientWidth: element.clientWidth,
      offenders,
      scrollLeft: element.scrollLeft,
      scrollWidth: element.scrollWidth,
    };
  });
  expect(metrics.scrollLeft).toBe(0);
  expect(metrics.scrollWidth, JSON.stringify(metrics.offenders)).toBeLessThanOrEqual(
    metrics.clientWidth
  );

  const diagnose = page.getByRole('button', { name: 'Diagnose', exact: true });
  const box = await diagnose.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
}

async function setup(
  page: Page,
  diagnosisStatus = 200,
  pagination: PaginationMode = 'complete',
  behavior: SetupBehavior = {}
) {
  let runningStatus: 'running' | 'cancelled' = 'running';
  let cancelRequestCount = 0;
  let paginatedRequestCount = 0;
  let activeDetailRequestCount = 0;
  let activePageRequestCount = 0;
  let releaseActivePage: (() => void) | null = null;
  const activePageGate = new Promise<void>((resolve) => {
    releaseActivePage = resolve;
  });
  const activeIncident = behavior.incident === undefined ? INCIDENT : behavior.incident;
  const activeError = { ...ERROR, incident: activeIncident };
  const activeSucceededRun = { ...SUCCEEDED_RUN, incident: activeIncident };
  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.includes('/api/auth/')) return respond(200, ADMIN);
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/credentials/agent')
      return respond(200, {
        credentials: [
          {
            agentType: 'openai-codex',
            provider: 'openai',
            credentialKind: 'api-key',
            isActive: true,
            maskedKey: 'sk-...audit',
            createdAt: '2026-07-29T09:00:00.000Z',
            updatedAt: '2026-07-29T09:00:00.000Z',
          },
        ],
      });
    if (path === '/api/credentials')
      return respond(200, [
        {
          id: 'credential-audit-hetzner',
          provider: 'hetzner',
          connected: true,
          createdAt: '2026-07-29T09:00:00.000Z',
        },
      ]);
    if (path === '/api/github/installations')
      return respond(200, [
        {
          id: 'github-installation-audit',
          userId: 'debug-admin',
          installationId: '12345',
          accountType: 'organization',
          accountName: 'debug-org',
          createdAt: '2026-07-29T09:00:00.000Z',
          updatedAt: '2026-07-29T09:00:00.000Z',
        },
      ]);
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path.startsWith('/api/projects')) return respond(200, { projects: [], nextCursor: null });
    if (path.includes('/api/chat-sessions'))
      return respond(200, { sessions: [], nextCursor: null });
    if (path.includes('/api/commands')) return respond(200, { commands: [] });
    if (
      path ===
      `/api/admin/observability/errors/${ERROR_ID}/incident/artifacts/artifact-safe-1/download`
    )
      return route.fulfill({
        status: 200,
        contentType: 'application/gzip',
        headers: {
          'Cache-Control': 'private, no-store',
          'Content-Disposition': 'attachment; filename="artifact-safe-1.tar.gz"',
        },
        body: 'safe archive',
      });
    if (path === '/api/admin/observability/errors')
      return respond(200, { errors: [activeError], total: 1, cursor: null, hasMore: false });
    if (path === '/api/admin/observability/diagnoses' && request.method() === 'GET')
      return respond(200, {
        diagnoses: [DIAGNOSIS],
        runs: [RUNNING_RUN, FAILED_RUN, activeSucceededRun],
      });
    if (path === '/api/admin/observability/diagnoses' && request.method() === 'POST') {
      return diagnosisStatus === 200
        ? respond(202, { run: RUNNING_RUN })
        : respond(diagnosisStatus, {
            error: 'BUDGET_EXHAUSTED',
            message: 'Daily deployment debugging budget exhausted',
          });
    }
    if (path === '/api/admin/observability/diagnosis-runs/run-succeeded-1')
      return respond(200, {
        run: activeSucceededRun,
        events: Array.from({ length: 100 }, (_, index) => diagnosisEvent(index + 1)),
        nextCursor: 100,
      });
    if (
      path === '/api/admin/observability/diagnosis-runs/run-succeeded-1/events' &&
      url.searchParams.get('cursor') === '100'
    ) {
      paginatedRequestCount++;
      return respond(200, {
        events: Array.from({ length: 100 }, (_, index) => diagnosisEvent(index + 101)),
        nextCursor: pagination === 'repeated' ? 100 : 200,
      });
    }
    if (
      path === '/api/admin/observability/diagnosis-runs/run-succeeded-1/events' &&
      url.searchParams.get('cursor') === '200'
    ) {
      paginatedRequestCount++;
      return respond(200, {
        events: Array.from({ length: 5 }, (_, index) => diagnosisEvent(index + 201)),
        nextCursor: null,
      });
    }
    if (
      path === '/api/admin/observability/diagnosis-runs/run-running-1/events' &&
      url.searchParams.get('cursor') === '100' &&
      behavior.activePollingEvents
    ) {
      activePageRequestCount++;
      await activePageGate;
      return respond(200, {
        events: Array.from({ length: 5 }, (_, index) => ({
          ...diagnosisEvent(index + 101),
          runId: 'run-running-1',
        })),
        nextCursor: null,
      });
    }
    if (path === '/api/admin/observability/diagnosis-runs/run-running-1') {
      activeDetailRequestCount++;
      const eventCount = behavior.activePollingEvents
        ? activeDetailRequestCount > 1
          ? 100
          : 2
        : 0;
      return respond(200, {
        run: { ...RUNNING_RUN, status: runningStatus },
        events: Array.from({ length: eventCount }, (_, index) => ({
          ...diagnosisEvent(index + 1),
          runId: 'run-running-1',
        })),
        nextCursor: eventCount === 100 ? 100 : null,
      });
    }
    if (path === '/api/admin/observability/diagnosis-runs/run-running-1/cancel') {
      cancelRequestCount++;
      await new Promise((resolve) => setTimeout(resolve, behavior.cancelDelayMs ?? 150));
      if (behavior.cancelStatus && behavior.cancelStatus !== 202) {
        return respond(behavior.cancelStatus, { message: 'Cancellation service unavailable' });
      }
      runningStatus = 'cancelled';
      return respond(202, { accepted: true });
    }
    if (path === '/api/admin/observability/diagnosis-runs/run-running-1/retry')
      return respond(202, { run: { ...RUNNING_RUN, id: 'run-running-2' } });
    if (path === '/api/admin/observability/diagnosis-runs/run-running-2')
      return respond(200, {
        run: { ...RUNNING_RUN, id: 'run-running-2' },
        events: [],
        nextCursor: null,
      });
    if (path === '/api/admin/observability/diagnosis-runs/run-failed-1')
      return respond(200, {
        run: FAILED_RUN,
        events: [
          {
            id: 'event-failed',
            runId: 'run-failed-1',
            sequence: 1,
            stepKey: 'terminal:failed',
            eventType: 'failed',
            status: 'failed',
            sourceName: 'query_cloudflare_logs',
            argumentsPreview: null,
            evidencePreview: null,
            resultCount: null,
            durationMs: 1200,
            retryAttempt: 3,
            errorCode: 'TRANSIENT_UPSTREAM',
            errorMessage: 'model timeout after durable acceptance',
            createdAt: '2026-07-29T10:18:30.000Z',
          },
        ],
        nextCursor: null,
      });
    if (path === '/api/admin/observability/diagnosis-runs/run-failed-1/retry') {
      await new Promise((resolve) => setTimeout(resolve, behavior.retryDelayMs ?? 0));
      return behavior.retryStatus && behavior.retryStatus !== 202
        ? respond(behavior.retryStatus, { message: 'Retry service unavailable' })
        : respond(202, { run: RUNNING_RUN });
    }
    if (path === '/api/admin/observability/debug/projects')
      return respond(200, {
        projects: [
          { id: 'project-1', name: 'A project with a deliberately long deployment name' },
          { id: 'project-2', name: 'Secondary project' },
        ],
      });
    if (path === '/api/admin/observability/diagnoses/diag-1/idea')
      return respond(200, { ideaId: 'idea-draft-1' });
    return respond(200, {});
  });
  return {
    activeDetailRequestCount: () => activeDetailRequestCount,
    activePageRequestCount: () => activePageRequestCount,
    cancelRequestCount: () => cancelRequestCount,
    paginatedRequestCount: () => paginatedRequestCount,
    releaseActivePage: () => releaseActivePage?.(),
  };
}

test.describe('Deployment diagnosis visual audit', () => {
  test('renders durable detail with inert evidence HTML', async ({ page }) => {
    const name = viewportLabel(page);
    await setup(page);
    let dialogOpened = false;
    page.on('dialog', () => {
      dialogOpened = true;
    });
    await page.goto('/admin/diagnoses/run-succeeded-1');
    await expect(page.getByRole('heading', { name: 'Diagnostic run' })).toBeVisible();
    await expect(page.getByText('get recent errors')).toBeVisible();
    await expect(page.getByText('get vm incident')).toBeVisible();
    await expect(
      page.getByRole('list', { name: 'Diagnosis event timeline' }).locator(':scope > li')
    ).toHaveCount(205);
    await expect(page.getByText('Completed diagnosis')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Automatic VM evidence' })).toBeVisible();
    await expect(page.getByText(/77 · last/)).toBeVisible();
    await expect(page.getByText('structured-events')).toBeVisible();
    await expect(page.getByText(/3 redactions · truncated/)).toBeVisible();
    await page.getByText('Safe evidence preview').click();
    await expect(page.getByText(/<script>alert\(2\)<\/script> is inert/)).toBeVisible();
    await page.getByRole('button', { name: 'Download safe evidence' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'downloaded' })).toBeVisible();
    await page.getByText('Redacted evidence preview').first().click();
    await expect(
      page.getByText('<script>alert(1)</script> is inert redacted evidence')
    ).toBeVisible();
    expect(dialogOpened).toBe(false);
    await assertNoOverflow(page);
    await page.reload();
    await expect(
      page.getByRole('list', { name: 'Diagnosis event timeline' }).locator(':scope > li')
    ).toHaveCount(205);
    await screenshot(page, 'debug-diagnosis-detail-' + name);
  });

  test('fails safely when event pagination repeats a cursor', async ({ page }) => {
    const requests = await setup(page, 200, 'repeated');
    await page.goto('/admin/diagnoses/run-succeeded-1');
    await expect(page.getByRole('heading', { name: 'Diagnosis unavailable' })).toBeVisible();
    await expect(
      page.getByText('Diagnosis event pagination did not make bounded forward progress')
    ).toBeVisible();
    expect(requests.paginatedRequestCount()).toBe(1);
    await assertNoOverflow(page);
  });

  test('renders the bounded-budget error state', async ({ page }) => {
    const name = viewportLabel(page);
    await setup(page, 429);
    await page.goto('/admin/errors');
    await assertAdminViewportIsStable(page);
    await page.getByRole('button', { name: 'Diagnose', exact: true }).click();
    await expect(page.getByText('Daily deployment debugging budget exhausted')).toBeVisible();
    await assertAdminViewportIsStable(page);
    await screenshot(page, `debug-diagnosis-budget-error-${name}`);
    await assertNoOverflow(page);
    const message = page.getByText(/Workspace transition failed for café deployment/);
    await expect(message).toBeVisible();
    expect(
      await message.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        whiteSpace: getComputedStyle(element).whiteSpace,
      }))
    ).toMatchObject({ whiteSpace: 'normal' });
    expect(await message.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true
    );
  });

  test('shows recoverable active and cancellation states without overflow', async ({ page }) => {
    await setup(page);
    await page.goto('/admin/diagnoses/run-running-1');
    await expect(page.getByText('model:2')).toBeVisible();
    await expect(
      page.getByText('Accepted. Waiting for the durable executor’s first checkpoint.')
    ).toBeVisible();
    const cancel = page.getByRole('button', { name: 'Cancel' });
    await cancel.click();
    await expect(page.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    await expect(
      page.getByRole('status').filter({ hasText: 'Cancellation requested' })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page).toHaveURL(/\/admin\/diagnoses\/run-running-2$/);
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await assertNoOverflow(page);
  });

  test('keeps the previous timeline visible while an active poll loads every next page', async ({
    page,
  }) => {
    const requests = await setup(page, 200, 'complete', { activePollingEvents: true });
    await page.goto('/admin/diagnoses/run-running-1');
    const events = page
      .getByRole('list', { name: 'Diagnosis event timeline' })
      .locator(':scope > li');
    await expect(events).toHaveCount(2);
    await expect.poll(requests.activePageRequestCount, { timeout: 5_000 }).toBe(1);
    expect(requests.activeDetailRequestCount()).toBeGreaterThanOrEqual(2);
    expect(await events.count()).toBe(2);
    requests.releaseActivePage();
    await expect(events).toHaveCount(105);
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

  test('suppresses duplicate copy actions and announces success and failure', async ({ page }) => {
    await page.addInitScript(() => {
      const state = window as typeof window & {
        __copyCalls: number;
        __copyMode: 'pending' | 'reject';
        __releaseCopy?: () => void;
      };
      state.__copyCalls = 0;
      state.__copyMode = 'pending';
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: () => {
            state.__copyCalls++;
            if (state.__copyMode === 'reject') return Promise.reject(new Error('Clipboard denied'));
            return new Promise<void>((resolve) => {
              state.__releaseCopy = resolve;
            });
          },
        },
      });
    });
    await setup(page);
    await page.goto('/admin/diagnoses/run-succeeded-1');
    const copy = page.getByRole('button', { name: 'Copy', exact: true });
    await copy.click();
    await expect(page.getByRole('button', { name: 'Copying…' })).toBeDisabled();
    await page.getByRole('button', { name: 'Copying…' }).click({ force: true });
    expect(
      await page.evaluate(() => (window as typeof window & { __copyCalls: number }).__copyCalls)
    ).toBe(1);
    await page.evaluate(() =>
      (window as typeof window & { __releaseCopy?: () => void }).__releaseCopy?.()
    );
    await expect(page.getByRole('status').filter({ hasText: 'Diagnosis copied.' })).toHaveText(
      'Diagnosis copied.'
    );
    await page.evaluate(() => {
      (window as typeof window & { __copyMode: 'pending' | 'reject' }).__copyMode = 'reject';
    });
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Clipboard denied');
    await expect(page.getByRole('button', { name: 'Copy', exact: true })).toBeEnabled();
    await assertNoOverflow(page);
  });

  test('keeps retry disabled while pending and recovers after failure', async ({ page }) => {
    await setup(page, 200, 'complete', { retryDelayMs: 150, retryStatus: 503 });
    await page.goto('/admin/diagnoses/run-failed-1');
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveText('Retry service unavailable');
    await expect(page.getByRole('button', { name: 'Retry' })).toBeEnabled();
    await expect(page).toHaveURL(/\/admin\/diagnoses\/run-failed-1$/);
    await assertNoOverflow(page);
  });

  test('suppresses duplicate cancellation and recovers after API failure', async ({ page }) => {
    const requests = await setup(page, 200, 'complete', {
      cancelDelayMs: 150,
      cancelStatus: 503,
    });
    await page.goto('/admin/diagnoses/run-running-1');
    await page.getByRole('button', { name: 'Cancel' }).click();
    const cancelling = page.getByRole('button', { name: 'Cancelling…' });
    await expect(cancelling).toBeDisabled();
    await cancelling.click({ force: true });
    await expect(page.getByRole('alert')).toHaveText('Cancellation service unavailable');
    expect(requests.cancelRequestCount()).toBe(1);
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    await assertNoOverflow(page);
  });

  for (const state of [
    {
      label: 'missing',
      incident: null,
      copy: 'No automatic VM evidence',
    },
    {
      label: 'pending',
      incident: { ...INCIDENT, status: 'pending', artifactCount: 0, artifacts: [] },
      copy: 'still being collected or uploaded',
    },
    {
      label: 'failed',
      incident: {
        ...INCIDENT,
        status: 'failed',
        artifactCount: 0,
        artifacts: [],
        failureReason: `Snapshot quota reached ${'unbroken-failure-context-'.repeat(12)}`,
      },
      copy: 'Snapshot quota reached',
    },
    {
      label: 'expired',
      incident: { ...INCIDENT, status: 'expired', artifactCount: 0, artifacts: [] },
      copy: 'retention limit',
    },
  ] as const) {
    test(`renders the ${state.label} incident state responsively`, async ({ page }) => {
      const name = viewportLabel(page);
      await setup(page, 200, 'complete', { incident: state.incident as IncidentFixture });
      await page.goto('/admin/diagnoses/run-succeeded-1');
      await expect(page.getByRole('heading', { name: 'Automatic VM evidence' })).toBeVisible();
      const stateCopy = page.getByText(new RegExp(state.copy, 'i'));
      await expect(stateCopy).toBeVisible();
      if (state.label === 'failed') {
        expect(
          await stateCopy.evaluate((element) => element.scrollWidth <= element.clientWidth)
        ).toBe(true);
      }
      await expect(page.getByRole('button', { name: 'Download safe evidence' })).toHaveCount(0);
      await assertNoOverflow(page);
      await screenshot(page, `debug-incident-${state.label}-${name}`);
    });
  }
});
