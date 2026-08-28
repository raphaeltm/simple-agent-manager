import { expect, type Locator, type Page, test } from '@playwright/test';
import type {
  AdminProjectEventInspectorResponse,
  ProjectSummary,
} from '@simple-agent-manager/shared';

import { assertNoOverflow, makeMockUser, screenshot, setupAuditRoutes } from './audit-helpers';

const ADMIN = makeMockUser({
  email: 'eventing-admin@example.com',
  name: 'Eventing Admin',
  role: 'superadmin',
  sessionId: 'eventing-admin-session',
  userId: 'eventing-admin',
});

const NOW = Date.UTC(2026, 7, 28, 12, 0, 0);
const PROJECT_ID = 'project-event-inspector-ulid-01M1457MFVR0TCFGMSNPJTWPJG-with-long-suffix';
const EMPTY_PROJECT_ID = 'project-event-inspector-empty';
const ERROR_PROJECT_ID = 'project-event-inspector-error';
const LONG =
  'reconciled-project-event-subscription-delivery-status-with-extra-long-unbroken-token-'.repeat(5);

const PROJECTS: ProjectSummary[] = [
  {
    id: PROJECT_ID,
    name: `Eventing Inspector ${LONG}`,
    repository: `raphaeltm/simple-agent-manager-${LONG}`,
    githubRepoId: 1957,
    defaultBranch: 'main',
    repoProvider: 'github',
    status: 'active',
    activeWorkspaceCount: 2,
    activeSessionCount: 7,
    lastActivityAt: '2026-08-28T12:00:00.000Z',
    createdAt: '2026-08-01T12:00:00.000Z',
    taskCountsByStatus: { in_progress: 3, completed: 18 },
    linkedWorkspaces: 2,
  },
  {
    id: EMPTY_PROJECT_ID,
    name: 'Empty Eventing Project',
    repository: 'raphaeltm/no-events',
    githubRepoId: null,
    defaultBranch: 'main',
    repoProvider: 'github',
    status: 'active',
    activeWorkspaceCount: 0,
    activeSessionCount: 0,
    lastActivityAt: null,
    createdAt: '2026-08-01T12:00:00.000Z',
    taskCountsByStatus: {},
    linkedWorkspaces: 0,
  },
  {
    id: ERROR_PROJECT_ID,
    name: 'ProjectData Error Fixture',
    repository: 'raphaeltm/error-fixture',
    githubRepoId: null,
    defaultBranch: 'main',
    repoProvider: 'github',
    status: 'active',
    activeWorkspaceCount: 0,
    activeSessionCount: 1,
    lastActivityAt: '2026-08-28T11:00:00.000Z',
    createdAt: '2026-08-01T12:00:00.000Z',
    taskCountsByStatus: {},
    linkedWorkspaces: 0,
  },
];

function emptyInspector(projectId: string): AdminProjectEventInspectorResponse {
  return {
    generatedAt: NOW,
    limit: 25,
    project: {
      id: projectId,
      name: 'Empty Eventing Project',
      repository: 'raphaeltm/no-events',
      repoProvider: 'github',
      status: 'active',
      activeSessionCount: 0,
      lastActivityAt: null,
    },
    totals: {
      activeSubscriptions: 0,
      terminalSubscriptions: 0,
      recentEvents: 0,
      recentMatches: 0,
      recentBatches: 0,
      recentAttempts: 0,
      attentionBatches: 0,
      attentionAttempts: 0,
    },
    subscriptions: [],
    events: [],
    matches: [],
    batches: [],
    attempts: [],
    accounting: [],
    hasMore: false,
  };
}

function manyInspector(): AdminProjectEventInspectorResponse {
  const subscriptions = Array.from({ length: 5 }, (_, index) => {
    const number = index + 1;
    return {
      id: `sub-${number}-${LONG}`,
      owner: {
        type: number % 2 === 0 ? ('standing_watch' as const) : ('agent' as const),
        id: `owner-${number}-${LONG}`,
        name: `Owner ${number} ${number === 3 ? '<script>alert("owner")</script>' : LONG}`,
      },
      state: number === 5 ? ('expired' as const) : ('active' as const),
      reason: `Subscription ${number} watches normalized events only. ${LONG}`,
      filter: {
        version: 1 as const,
        source: ['github', `source-${LONG}`],
        eventType: number % 2 === 0 ? 'pull_request.review_submitted' : 'workflow_run.completed',
        subjectType: 'pull_request',
        subjectId: [`subject-${number}-${LONG}`],
        severity: number % 2 === 0 ? ('critical' as const) : ('info' as const),
      },
      matchKeyCount: number * 3,
      requestedDelivery:
        number % 2 === 0 ? ('runtime_steer' as const) : ('existing_session_prompt' as const),
      resolvedDelivery:
        number % 2 === 0
          ? ('recorded_not_injected' as const)
          : ('queued_for_prompt_delivery' as const),
      target: {
        sessionId: `session-${number}-${LONG}`,
        taskId: `task-${number}-${LONG}`,
        runtimeId: number % 2 === 0 ? null : `runtime-${number}-${LONG}`,
        agentId: `agent-${number}-${LONG}`,
      },
      createdAt: NOW - number * 100_000,
      updatedAt: NOW - number * 50_000,
      expiresAt: number === 5 ? NOW - 10_000 : NOW + number * 60_000,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      lastMatchedAt: NOW - number * 10_000,
    };
  });

  const events = Array.from({ length: 9 }, (_, index) => {
    const number = index + 1;
    return {
      id: `evt-${number}-${LONG}`,
      source: number % 2 === 0 ? 'github' : `webhook-${LONG}`,
      eventType: number % 2 === 0 ? 'pull_request.opened' : 'workflow_run.completed',
      subject: { type: 'pull_request', id: `${number}-${LONG}` },
      severity:
        number % 3 === 0
          ? ('critical' as const)
          : number % 2 === 0
            ? ('warning' as const)
            : ('info' as const),
      state: number === 4 ? 'conflicted' : 'recorded',
      display: {
        title: `Untrusted event ${number}: <script>alert("event-${number}")</script> ${LONG}`,
        summary: `This text is model/event content, not instruction text. It includes markdown-looking **commands**, /do, and ${LONG}`,
        url: `javascript:alert("event-${number}")/${LONG}`,
        labels: [`label-${number}-${LONG}`, '<script>alert("label")</script>', 'priority:critical'],
        untrusted: true as const,
      },
      occurredAt: NOW - number * 20_000,
      receivedAt: NOW - number * 19_000,
      updatedAt: NOW - number * 18_000,
      duplicateCount: number,
      conflictCount: number === 4 ? 2 : 0,
      hasRawPayloadRef: number % 2 === 0,
    };
  });

  const matches = Array.from({ length: 8 }, (_, index) => {
    const number = index + 1;
    const subscription = subscriptions[index % subscriptions.length];
    return {
      id: `match-${number}-${LONG}`,
      eventId: events[index % events.length].id,
      subscriptionId: subscription.id,
      state: number % 4 === 0 ? ('recorded_not_injected' as const) : ('batch_created' as const),
      matchedAt: NOW - number * 9_000,
      lifecycleCheckedAt: NOW - number * 8_000,
      batchId: `batch-${(index % 4) + 1}-${LONG}`,
      reason: `Lifecycle reason ${number} ${LONG}`,
    };
  });

  const batches = Array.from({ length: 4 }, (_, index) => {
    const number = index + 1;
    const subscription = subscriptions[index % subscriptions.length];
    return {
      id: `batch-${number}-${LONG}`,
      subscriptionId: subscription.id,
      state:
        number === 2
          ? ('failed' as const)
          : number === 3
            ? ('ambiguous' as const)
            : ('delivered' as const),
      requestedDelivery: subscription.requestedDelivery,
      resolvedDelivery: subscription.resolvedDelivery,
      target: subscription.target,
      eventCount: number + 1,
      matchCount: number + 2,
      createdAt: NOW - number * 7_000,
      updatedAt: NOW - number * 6_000,
      terminalAt: number === 2 ? NOW - 5_000 : null,
      terminalReason: number === 2 ? `Adapter timeout ${LONG}` : null,
      adapterDecision: {
        action: number === 2 ? 'unsupported' : 'queue_prompt_delivery',
        reason: number === 2 ? 'unsupported_delivery' : 'adapter_supported',
        adapterId: `adapter-${number}-${LONG}`,
        adapterKind: number === 2 ? 'record' : 'durable_queue',
        capability: number === 2 ? 'record_only' : 'durable_prompt_queue',
        agentType: number % 2 === 0 ? 'claude' : 'codex',
        protocol: 'project-events',
        protocolVersion: '1',
        durableAck: number !== 2,
        supported: number !== 2,
        authorized: true,
        terminal: number === 2,
      },
    };
  });

  const attempts = Array.from({ length: 8 }, (_, index) => {
    const number = index + 1;
    return {
      id: `attempt-${number}-${LONG}`,
      batchId: batches[index % batches.length].id,
      attemptNumber: number,
      state:
        number % 3 === 0
          ? ('failed' as const)
          : number % 2 === 0
            ? ('retry' as const)
            : ('accepted' as const),
      adapter: `durable-queue-${LONG}`,
      protocolVersion: '1',
      runtimeId: `runtime-${number}-${LONG}`,
      receiptId: `receipt-${number}-${LONG}`,
      errorCode: number % 3 === 0 ? `DELIVERY_TIMEOUT_${LONG}` : null,
      errorMessage:
        number % 3 === 0 ? `Delivery attempt carried long diagnostic text ${LONG}` : null,
      startedAt: NOW - number * 5_000,
      completedAt: number % 3 === 0 ? NOW - number * 4_000 : null,
      createdAt: NOW - number * 5_000,
    };
  });

  return {
    generatedAt: NOW,
    limit: 25,
    project: {
      id: PROJECT_ID,
      name: `Eventing Inspector ${LONG}`,
      repository: `raphaeltm/simple-agent-manager-${LONG}`,
      repoProvider: 'github',
      status: 'active',
      activeSessionCount: 7,
      lastActivityAt: '2026-08-28T12:00:00.000Z',
    },
    totals: {
      activeSubscriptions: 4,
      terminalSubscriptions: 1,
      recentEvents: events.length,
      recentMatches: matches.length,
      recentBatches: batches.length,
      recentAttempts: attempts.length,
      attentionBatches: 2,
      attentionAttempts: 4,
    },
    subscriptions,
    events,
    matches,
    batches,
    attempts,
    accounting: [
      {
        projectId: PROJECT_ID,
        category: `project_events_${LONG}`,
        recordCount: 128,
        estimatedBytes: 512_000,
        oldestCreatedAt: NOW - 10_000_000,
        newestCreatedAt: NOW,
        measuredAt: NOW,
      },
      {
        projectId: PROJECT_ID,
        category: `project_event_delivery_attempts_${LONG}`,
        recordCount: 2048,
        estimatedBytes: 8_388_608,
        oldestCreatedAt: NOW - 20_000_000,
        newestCreatedAt: NOW - 10_000,
        measuredAt: NOW,
      },
    ],
    hasMore: true,
  };
}

async function setupMocks(page: Page) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, ADMIN.user.id);

  await setupAuditRoutes(page, (path, respond) => {
    if (path === '/api/auth/get-session') return respond(200, ADMIN);
    if (path === '/api/projects') return respond(200, { projects: PROJECTS, nextCursor: null });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [], total: 0 });
    if (path === '/api/trial-status' || path === '/api/trial/status') {
      return respond(200, { available: false, isTrial: false });
    }
    if (path === '/api/credentials') return respond(200, []);
    if (path === '/api/credentials/agent') return respond(200, { credentials: [] });
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/notifications/unread-count') return respond(200, { count: 0 });
    if (path === '/api/notifications') {
      return respond(200, { notifications: [], unreadCount: 0, nextCursor: null });
    }
    if (path.startsWith('/api/admin/project-events/')) {
      const projectId = decodeURIComponent(path.split('/')[4] ?? '');
      if (projectId === EMPTY_PROJECT_ID) return respond(200, emptyInspector(projectId));
      if (projectId === ERROR_PROJECT_ID) {
        return respond(500, {
          error: 'INTERNAL_ERROR',
          message: 'ProjectData unavailable for audit',
        });
      }
      return respond(200, manyInspector());
    }
    return undefined;
  });
}

async function assertChangedSurfaceStable(page: Page) {
  await assertNoOverflow(page);
  const metrics = await page.getByTestId('admin-project-events-page').evaluate((root) => {
    const rootRect = root.getBoundingClientRect();
    const offenders = [...root.querySelectorAll<HTMLElement>('*')]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.right > rootRect.right + 1)
      .slice(0, 8)
      .map(({ element, rect }) => ({
        className: String(element.className).slice(0, 100),
        right: Math.round(rect.right),
        text: element.textContent?.trim().slice(0, 80),
      }));
    return { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, offenders };
  });
  expect(metrics.scrollWidth, JSON.stringify(metrics.offenders)).toBeLessThanOrEqual(
    metrics.clientWidth + 1
  );
}

async function visitCaptureAndAssert(page: Page, path: string, screenshotName: string) {
  await setupMocks(page);
  await page.goto(path);
  await expect(page.getByTestId('admin-project-events-page')).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await assertChangedSurfaceStable(page);
  await screenshot(page, screenshotName);
}

async function captureScrolledState(page: Page, locator: Locator, screenshotName: string) {
  await locator.scrollIntoViewIfNeeded();
  await assertChangedSurfaceStable(page);
  await screenshot(page, screenshotName);
}

test.describe('Admin project eventing inspector', () => {
  test('project picker with no selected project', async ({ page }) => {
    await visitCaptureAndAssert(page, '/admin/project-events', 'admin-project-events-picker');
    const emptyPrompt = page.getByText('Choose a project to inspect');
    await expect(emptyPrompt).toBeVisible();
    await captureScrolledState(page, emptyPrompt, 'admin-project-events-picker-state');
  });

  test('empty eventing status', async ({ page }) => {
    await visitCaptureAndAssert(
      page,
      `/admin/project-events?projectId=${EMPTY_PROJECT_ID}`,
      'admin-project-events-empty'
    );
    const emptyState = page.getByText('No eventing records yet');
    await expect(emptyState).toBeVisible();
    await captureScrolledState(page, emptyState, 'admin-project-events-empty-state');
  });

  test('dense eventing status with long untrusted content', async ({ page }) => {
    await visitCaptureAndAssert(
      page,
      `/admin/project-events?projectId=${PROJECT_ID}`,
      'admin-project-events-dense-long'
    );
    const inspector = page.getByTestId('project-event-inspector');
    await expect(inspector).toBeVisible();
    await expect(inspector.locator('script')).toHaveCount(0);
    await expect(inspector.getByRole('link', { name: /javascript/i })).toHaveCount(0);
    await expect(inspector.getByText('raw payload hidden').first()).toBeVisible();
    await captureScrolledState(page, inspector, 'admin-project-events-dense-long-inspector');
  });

  test('inspector read failure', async ({ page }) => {
    await visitCaptureAndAssert(
      page,
      `/admin/project-events?projectId=${ERROR_PROJECT_ID}`,
      'admin-project-events-error'
    );
    const error = page.getByText('ProjectData unavailable for audit');
    await expect(error).toBeVisible();
    await captureScrolledState(page, error, 'admin-project-events-error-state');
  });
});
