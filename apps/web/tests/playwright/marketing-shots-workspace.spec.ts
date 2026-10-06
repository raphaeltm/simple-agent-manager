/**
 * Marketing screenshots — Dashboard, project Notifications, Idea detail,
 * Library browser + Document viewer, and Project Settings (Agents). Renders
 * the REAL production components with mocked API data and captures the
 * images embedded in the public marketing site (apps/www/src/data/features.ts
 * -> apps/www/public/images/features).
 *
 * Run with the marketing output flag to write committed images:
 *   MARKETING_SHOTS=1 PLAYWRIGHT_BASE_URL=http://localhost:4173 \
 *     npx playwright test tests/playwright/marketing-shots-workspace.spec.ts \
 *     --project="Desktop (1280x800)"
 *   MARKETING_SHOTS=1 MARKETING_THEME=light PLAYWRIGHT_BASE_URL=http://localhost:4173 \
 *     npx playwright test tests/playwright/marketing-shots-workspace.spec.ts \
 *     --project="Desktop (1280x800)"
 *
 * Without MARKETING_SHOTS the images land in the gitignored tmp dir, so the
 * spec is safe to run as part of the normal visual-audit sweep.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, type AuditResponder, setupAuditRoutes } from './audit-helpers';
import {
  dismissOnboarding,
  MARKETING_USER,
  MARKETING_VIEWPORT,
  marketingShot,
  NORTHWIND,
  OPAQUE_BACKDROP_COLOR,
} from './marketing-shots-helpers';

test.use(MARKETING_VIEWPORT);
test.describe.configure({ timeout: 90_000 });

// ---------------------------------------------------------------------------
// Shared Northwind world
// ---------------------------------------------------------------------------

const PROJECT_ID = NORTHWIND.projectId;
const BASE = `/api/projects/${PROJECT_ID}`;
const NOW = Date.now();
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const PROJECT = {
  id: PROJECT_ID,
  name: NORTHWIND.projectName,
  description: 'Payments ingestion, reconciliation, and the merchant-facing API.',
  repository: NORTHWIND.repository,
  defaultBranch: NORTHWIND.defaultBranch,
  userId: NORTHWIND.owner.id,
  installationId: 'inst-northwind',
  githubInstallationId: 'inst-northwind',
  repoProvider: 'github',
  status: 'active',
  defaultVmSize: null,
  defaultAgentType: 'claude-code',
  defaultWorkspaceProfile: null,
  defaultProvider: null,
  defaultLocation: null,
  agentDefaults: {
    'claude-code': { model: 'claude-opus-5', permissionMode: 'acceptEdits' },
    'openai-codex': { model: 'gpt-5.5-codex', permissionMode: null },
  },
  createdAt: '2026-01-05T00:00:00Z',
  updatedAt: iso(0),
  summary: {
    activeWorkspaceCount: 2,
    activeSessionCount: 3,
    lastActivityAt: iso(-2 * 60_000),
    taskCountsByStatus: { in_progress: 2, completed: 41 },
    linkedWorkspaces: 2,
  },
};

/**
 * Handles the app-chrome endpoints every authenticated page hits (nav,
 * sidebar, notifications, project switcher, etc). Real-looking rows for
 * credentials/github installations — an empty/unconfigured response makes
 * `useSetupStatus` render a glowing "Complete Setup" CTA in the sidebar on
 * every capture (see marketing-shots-compute.spec.ts's commonChromeHandler).
 * Returns `undefined` for anything it doesn't recognize so per-surface
 * handlers can layer routes before falling back to this.
 */
function commonHandler(path: string, respond: AuditResponder): Promise<void> | undefined {
  if (path.startsWith('/api/auth/')) return respond(200, MARKETING_USER);
  if (path === '/api/projects') return respond(200, { projects: [PROJECT], nextCursor: null });
  if (path === `/api/projects/${PROJECT_ID}`) return respond(200, PROJECT);
  if (path === `${BASE}/members`)
    return respond(200, {
      members: [
        { userId: NORTHWIND.owner.id, role: 'owner', status: 'active', user: { ...NORTHWIND.owner, image: null } },
      ],
      inviteLinks: [],
      accessRequests: [],
    });
  if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
  if (path === '/api/github/installations') {
    return respond(200, [
      {
        id: 'inst-northwind',
        userId: NORTHWIND.owner.id,
        installationId: 'inst-northwind',
        accountType: 'Organization',
        accountName: 'northwind-labs',
        createdAt: PROJECT.createdAt,
        updatedAt: PROJECT.createdAt,
      },
    ]);
  }
  if (path === '/api/credentials/agent') {
    return respond(200, {
      credentials: [
        {
          agentType: 'claude-code',
          provider: 'anthropic',
          credentialKind: 'api-key',
          isActive: true,
          maskedKey: 'sk-ant-****nwnd',
          createdAt: PROJECT.createdAt,
          updatedAt: PROJECT.createdAt,
        },
      ],
    });
  }
  if (path === '/api/credentials') {
    return respond(200, [
      { provider: 'hetzner', status: 'valid', name: 'Payments API Hetzner token' },
    ]);
  }
  if (path === '/api/agents') return respond(200, { agents: [] });
  if (path === '/api/nodes') return respond(200, []);
  if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
  if (path === '/api/chats' || path === '/api/chats/recent')
    return respond(200, { sessions: [], total: 0, totalActive: 0, groups: [] });
  if (path === '/api/account-map')
    return respond(200, { projects: [], nodes: [], workspaces: [], sessions: [], tasks: [], relationships: [] });
  if (path === '/api/trial-status' || path === '/api/trial/status') return respond(200, { available: false });
  if (path === '/api/providers/catalog') return respond(200, { catalogs: [] });
  if (path === '/api/report-issue/config') return respond(200, { enabled: false });
  if (path.startsWith(`${BASE}/agent-profiles`)) return respond(200, { items: [] });
  if (path === `${BASE}/sessions`) return respond(200, { sessions: [], total: 0 });
  if (path === `${BASE}/tasks`) return respond(200, { tasks: [], nextCursor: null });
  return undefined;
}

async function setupMocks(
  page: Page,
  handler: (path: string, respond: AuditResponder, route: Route) => Promise<void> | undefined
) {
  await dismissOnboarding(page);
  await setupAuditRoutes(page, (path, respond, route) => handler(path, respond, route) ?? commonHandler(path, respond));
}

function logPageErrors(page: Page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[console.error] ${msg.text()}`);
  });
  page.on('requestfailed', (request) => {
    console.log(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`);
  });
}

async function assertNoCrash(page: Page) {
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// A. Dashboard overview — active tasks across two projects + projects grid
// ---------------------------------------------------------------------------

const SECOND_PROJECT_ID = 'proj-merchant-portal';
const SECOND_PROJECT_NAME = 'Merchant Portal';

const PROJECT_SUMMARIES = [
  {
    id: PROJECT_ID,
    name: NORTHWIND.projectName,
    repository: NORTHWIND.repository,
    githubRepoId: 501,
    defaultBranch: NORTHWIND.defaultBranch,
    repoProvider: 'github',
    status: 'active',
    activeWorkspaceCount: 2,
    activeSessionCount: 3,
    lastActivityAt: iso(-2 * 60_000),
    createdAt: '2026-01-05T00:00:00Z',
    taskCountsByStatus: { in_progress: 2, queued: 1, completed: 41 },
    linkedWorkspaces: 2,
  },
  {
    id: SECOND_PROJECT_ID,
    name: SECOND_PROJECT_NAME,
    repository: 'northwind-labs/merchant-portal',
    githubRepoId: 502,
    defaultBranch: 'main',
    repoProvider: 'github',
    status: 'active',
    activeWorkspaceCount: 1,
    activeSessionCount: 2,
    lastActivityAt: iso(-60_000),
    createdAt: '2026-02-11T00:00:00Z',
    taskCountsByStatus: { in_progress: 1, queued: 1, completed: 17 },
    linkedWorkspaces: 1,
  },
  {
    id: 'proj-ledger-service',
    name: 'Ledger Service',
    repository: 'northwind-labs/ledger-service',
    githubRepoId: 503,
    defaultBranch: 'main',
    repoProvider: 'github',
    status: 'active',
    activeWorkspaceCount: 1,
    activeSessionCount: 1,
    lastActivityAt: iso(-5 * 3_600_000),
    createdAt: '2026-03-02T00:00:00Z',
    taskCountsByStatus: { completed: 9 },
    linkedWorkspaces: 1,
  },
  {
    id: 'proj-notification-gateway',
    name: 'Notification Gateway',
    repository: 'northwind-labs/notification-gateway',
    githubRepoId: 504,
    defaultBranch: 'main',
    repoProvider: 'github',
    status: 'active',
    activeWorkspaceCount: 0,
    activeSessionCount: 0,
    lastActivityAt: iso(-2 * 86_400_000),
    createdAt: '2026-04-18T00:00:00Z',
    taskCountsByStatus: { completed: 4 },
    linkedWorkspaces: 0,
  },
];

const DASHBOARD_TASKS = [
  {
    id: 'task-idempotency-keys',
    title: 'Add idempotency keys to refund webhook',
    status: 'in_progress',
    executionStep: 'running',
    projectId: PROJECT_ID,
    projectName: NORTHWIND.projectName,
    sessionId: 'session-idempotency',
    createdAt: iso(-40 * 60_000),
    startedAt: iso(-38 * 60_000),
    lastMessageAt: NOW - 2 * 60_000,
    messageCount: 34,
    isActive: true,
    agentActivityState: 'working',
  },
  {
    id: 'task-provision-staging-node',
    title: 'Provision staging node for payouts load test',
    status: 'in_progress',
    executionStep: 'node_provisioning',
    projectId: PROJECT_ID,
    projectName: NORTHWIND.projectName,
    sessionId: 'session-provision',
    createdAt: iso(-5 * 60_000),
    startedAt: iso(-4 * 60_000),
    lastMessageAt: null,
    messageCount: 2,
    isActive: true,
    agentActivityState: 'working',
  },
  {
    id: 'task-reconcile-stripe',
    title: 'Reconcile Stripe payout mismatches',
    status: 'queued',
    executionStep: null,
    projectId: PROJECT_ID,
    projectName: NORTHWIND.projectName,
    sessionId: null,
    createdAt: iso(-60 * 60_000),
    startedAt: null,
    lastMessageAt: null,
    messageCount: 0,
    isActive: false,
    agentActivityState: 'awake-idle',
  },
  {
    id: 'task-kyc-onboarding',
    title: 'Migrate merchant onboarding to new KYC flow',
    status: 'in_progress',
    executionStep: null,
    projectId: SECOND_PROJECT_ID,
    projectName: SECOND_PROJECT_NAME,
    sessionId: 'session-kyc',
    createdAt: iso(-15 * 60_000),
    startedAt: iso(-14 * 60_000),
    lastMessageAt: NOW - 60_000,
    messageCount: 21,
    isActive: true,
    agentActivityState: 'working',
  },
  {
    id: 'task-dark-mode-contrast',
    title: 'Fix dark mode contrast on merchant dashboard',
    status: 'completed',
    executionStep: null,
    projectId: SECOND_PROJECT_ID,
    projectName: SECOND_PROJECT_NAME,
    sessionId: 'session-dark-mode',
    createdAt: iso(-3 * 3_600_000),
    startedAt: iso(-3 * 3_600_000 + 60_000),
    lastMessageAt: NOW - 2 * 3_600_000,
    messageCount: 12,
    isActive: false,
    agentActivityState: 'sleeping',
  },
  {
    id: 'task-csv-export',
    title: 'Add CSV export for settlement report',
    status: 'queued',
    executionStep: null,
    projectId: SECOND_PROJECT_ID,
    projectName: SECOND_PROJECT_NAME,
    sessionId: null,
    createdAt: iso(-20 * 60_000),
    startedAt: null,
    lastMessageAt: null,
    messageCount: 0,
    isActive: false,
    agentActivityState: 'awake-idle',
  },
];

function dashboardHandler(path: string, respond: AuditResponder): Promise<void> | undefined {
  if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: DASHBOARD_TASKS });
  if (path === '/api/projects') return respond(200, { projects: PROJECT_SUMMARIES, nextCursor: null });
  return undefined;
}

test('sam-dashboard-overview', async ({ page }) => {
  logPageErrors(page);
  await setupMocks(page, dashboardHandler);

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Active Tasks' })).toBeVisible();
  await expect(page.getByText('Add idempotency keys to refund webhook')).toBeVisible();
  await expect(page.getByText('Migrate merchant onboarding to new KYC flow')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
  await expect(page.getByText(SECOND_PROJECT_NAME).first()).toBeVisible();
  await expect(page.getByText('Ledger Service').first()).toBeVisible();
  await assertNoCrash(page);
  await assertNoOverflow(page);

  await marketingShot(page, 'sam-dashboard-overview');
});

// ---------------------------------------------------------------------------
// B. Notifications feed — mixed types, filter tabs, some unread
// ---------------------------------------------------------------------------

function notification(overrides: {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  unread?: boolean;
  offsetMs: number;
}) {
  return {
    id: overrides.id,
    projectId: PROJECT_ID,
    taskId: null,
    sessionId: null,
    type: overrides.type,
    urgency: 'medium',
    title: overrides.title,
    body: overrides.body ?? null,
    actionUrl: null,
    metadata: null,
    readAt: overrides.unread ? null : iso(overrides.offsetMs + 5 * 60_000),
    dismissedAt: null,
    createdAt: iso(overrides.offsetMs),
  };
}

const NOTIFICATIONS = [
  notification({
    id: 'notif-1',
    type: 'task_complete',
    title: 'Task completed: Add idempotency keys to refund webhook',
    body: 'Opened PR #482 with the idempotency-key middleware. All CI checks passed — ready for review.',
    unread: true,
    offsetMs: -6 * 60_000,
  }),
  notification({
    id: 'notif-2',
    type: 'needs_input',
    title: 'Agent needs input: confirm dropping legacy ledger_id column',
    body: 'The double-entry migration wants to drop `ledger_id` from `payments.transactions`. Confirm no downstream consumers still read it before I proceed.',
    unread: true,
    offsetMs: -22 * 60_000,
  }),
  notification({
    id: 'notif-3',
    type: 'error',
    title: 'Task failed: staging deploy blocked by missing secret',
    body: 'Deploy Staging workflow failed — CF_API_TOKEN is not configured for this environment.',
    unread: true,
    offsetMs: -48 * 60_000,
  }),
  notification({
    id: 'notif-4',
    type: 'progress',
    title: 'Migrating merchant onboarding to new KYC flow',
    body: 'Completed 4 of 7 checklist items. Currently updating the identity-verification webhook handler.',
    offsetMs: -70 * 60_000,
  }),
  notification({
    id: 'notif-5',
    type: 'session_ended',
    title: 'Session ended: Stripe webhook signature rotation',
    offsetMs: -100 * 60_000,
  }),
  notification({
    id: 'notif-6',
    type: 'pr_created',
    title: 'PR #482 opened: idempotency keys for refund webhook',
    body: 'https://github.com/northwind-labs/payments-api/pull/482',
    unread: true,
    offsetMs: -6 * 60_000 - 30_000,
  }),
  notification({
    id: 'notif-7',
    type: 'task_complete',
    title: 'Task completed: Nightly dependency audit',
    body: 'No new CVEs found across 118 consecutive nightly runs.',
    offsetMs: -5 * 3_600_000,
  }),
  notification({
    id: 'notif-8',
    type: 'needs_input',
    title: 'Agent needs input: choose canary rollout percentage',
    body: 'Staging soak passed for v2026.37.0. Promote to canary at 5%, 10%, or 25%?',
    unread: true,
    offsetMs: -3 * 3_600_000,
  }),
  notification({
    id: 'notif-9',
    type: 'error',
    title: 'Task failed: Datadog alert investigation timed out',
    body: 'Investigation session exceeded its execution timeout while triaging a critical payments-api alert.',
    offsetMs: -9 * 3_600_000,
  }),
];

function notificationsHandler(path: string, respond: AuditResponder): Promise<void> | undefined {
  if (path.startsWith('/api/notifications')) {
    return respond(200, { notifications: NOTIFICATIONS, unreadCount: 5, nextCursor: null });
  }
  return undefined;
}

test('sam-notifications-feed', async ({ page }) => {
  logPageErrors(page);
  await setupMocks(page, notificationsHandler);

  await page.goto(`/projects/${PROJECT_ID}/notifications`);
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'All', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Task Complete', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Needs Input', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Error', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Progress', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Session Ended', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'PR Created', exact: true })).toBeVisible();
  await expect(page.getByText('Add idempotency keys to refund webhook')).toBeVisible();
  await expect(page.getByText('confirm dropping legacy ledger_id column')).toBeVisible();
  await assertNoCrash(page);
  await assertNoOverflow(page);

  await marketingShot(page, 'sam-notifications-feed');
});

// ---------------------------------------------------------------------------
// C. Idea detail — problem statement, phased plan, Execute button, sessions
// ---------------------------------------------------------------------------

const IDEA_TASK_ID = 'task-rate-limit-payouts';

const IDEA_DESCRIPTION = [
  '## Problem',
  '',
  "Occasionally a single merchant's retry storm on `/v1/payouts` saturates the",
  'shared payments API pool, degrading latency for every other merchant. There is',
  'currently no per-merchant rate limit — only a global one.',
  '',
  '## Plan',
  '',
  '### Phase 1 — Instrumentation',
  '- Add a per-merchant request counter to the payouts route',
  "- Emit a `payouts.rate.exceeded` metric",
  '- Ship a dashboard panel so we can see the shape of real traffic before enforcing anything',
  '',
  '### Phase 2 — Enforcement',
  '- Add a token-bucket limiter keyed by `merchantId`',
  '- Return `429` with `Retry-After` once a merchant exceeds its budget',
  '- Default budget: 60 requests/minute, configurable per merchant tier',
  '',
  '### Phase 3 — Merchant-facing controls',
  '- Expose the current limit and remaining budget via the merchant dashboard',
  '- Let enterprise merchants request a higher limit',
  '- Document the new headers in the public API reference',
].join('\n');

const IDEA_TASK = {
  id: IDEA_TASK_ID,
  projectId: PROJECT_ID,
  userId: NORTHWIND.owner.id,
  parentTaskId: null,
  workspaceId: null,
  title: 'Rate-limit the payouts endpoint per merchant',
  description: IDEA_DESCRIPTION,
  status: 'ready',
  executionStep: null,
  priority: 1,
  taskMode: 'task',
  dispatchDepth: 0,
  agentProfileHint: null,
  skillId: null,
  skillHint: null,
  blocked: false,
  triggeredBy: 'user',
  triggerId: null,
  triggerExecutionId: null,
  requestedVmSize: null,
  requestedVmSizeSource: null,
  errorMessage: null,
  outputSummary: null,
  outputBranch: null,
  outputPrUrl: null,
  finalizedAt: null,
  createdAt: iso(-2 * 86_400_000),
  updatedAt: iso(-3 * 3_600_000),
  dependencies: [],
};

const IDEA_SESSIONS = [
  {
    sessionId: 'session-payouts-design',
    topic: 'Design the per-merchant token bucket',
    status: 'stopped',
    context: 'Explored token-bucket vs sliding window; picked token-bucket for burst tolerance.',
    linkedAt: NOW - 2 * 86_400_000,
  },
  {
    sessionId: 'session-payouts-enforce',
    topic: 'Implement rate limiter enforcement',
    status: 'active',
    context: 'Wiring the limiter into the payouts route handler.',
    linkedAt: NOW - 3_600_000,
  },
  {
    sessionId: 'session-payouts-dashboard',
    topic: 'Merchant dashboard: expose remaining budget',
    status: 'stopped',
    context: 'Adding a "Rate limit" card to the merchant-facing usage page.',
    linkedAt: NOW - 5 * 86_400_000,
  },
];

function ideaHandler(path: string, respond: AuditResponder): Promise<void> | undefined {
  if (path === `${BASE}/tasks/${IDEA_TASK_ID}`) return respond(200, IDEA_TASK);
  if (path === `${BASE}/tasks/${IDEA_TASK_ID}/sessions`)
    return respond(200, { sessions: IDEA_SESSIONS, count: IDEA_SESSIONS.length });
  return undefined;
}

test('sam-ideas-detail', async ({ page }) => {
  logPageErrors(page);
  await setupMocks(page, ideaHandler);

  await page.goto(`/projects/${PROJECT_ID}/ideas/${IDEA_TASK_ID}`);
  await expect(page.getByRole('heading', { name: 'Rate-limit the payouts endpoint per merchant' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Execute this idea' })).toBeVisible();
  await expect(page.getByText('Phase 1 — Instrumentation')).toBeVisible();
  await expect(page.getByText('Phase 2 — Enforcement')).toBeVisible();
  await expect(page.getByText('Phase 3 — Merchant-facing controls')).toBeVisible();
  await expect(page.getByText('Conversations (3)')).toBeVisible();
  await expect(page.getByText('Design the per-merchant token bucket')).toBeVisible();
  await expect(page.getByText('Implement rate limiter enforcement')).toBeVisible();
  await assertNoCrash(page);
  await assertNoOverflow(page);

  await marketingShot(page, 'sam-ideas-detail');
});

// ---------------------------------------------------------------------------
// D + E. Library browser + document viewer (markdown with a Mermaid diagram)
// ---------------------------------------------------------------------------

const LIBRARY_DIRECTORIES = [
  { name: 'research', path: '/research', fileCount: 6 },
  { name: 'runbooks', path: '/runbooks', fileCount: 4 },
];

function libraryFile(overrides: {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadSource?: string;
  tags: string[];
}) {
  return {
    id: overrides.id,
    projectId: PROJECT_ID,
    filename: overrides.filename,
    mimeType: overrides.mimeType,
    sizeBytes: overrides.sizeBytes,
    directory: '/',
    uploadSource: overrides.uploadSource ?? 'user',
    description: null,
    status: 'active',
    r2Key: `files/${overrides.id}`,
    createdAt: iso(-4 * 86_400_000),
    updatedAt: iso(-2 * 86_400_000),
    tags: overrides.tags.map((tag, i) => ({
      id: `tag-${overrides.id}-${i}`,
      fileId: overrides.id,
      tag,
      createdAt: iso(-4 * 86_400_000),
    })),
  };
}

const FILE_LEDGER_PLAN_ID = 'file-ledger-migration-plan';

const LIBRARY_FILES = [
  libraryFile({
    id: FILE_LEDGER_PLAN_ID,
    filename: 'ledger-migration-plan.md',
    mimeType: 'text/markdown',
    sizeBytes: 8420,
    tags: ['architecture', 'ledger'],
  }),
  libraryFile({
    id: 'file-double-entry-spec',
    filename: 'double-entry-ledger-spec.md',
    mimeType: 'text/markdown',
    sizeBytes: 15200,
    tags: ['architecture', 'ledger'],
  }),
  libraryFile({
    id: 'file-pci-checklist',
    filename: 'pci-compliance-checklist.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 245_000,
    tags: ['compliance'],
  }),
  libraryFile({
    id: 'file-payout-runbook',
    filename: 'merchant-payout-runbook.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 132_000,
    uploadSource: 'agent',
    tags: ['compliance', 'runbooks'],
  }),
  libraryFile({
    id: 'file-refund-webhook-notes',
    filename: 'refund-webhook-idempotency-notes.md',
    mimeType: 'text/markdown',
    sizeBytes: 3100,
    tags: ['architecture'],
  }),
];

const LEDGER_MIGRATION_MARKDOWN = [
  '# Ledger Migration Plan',
  '',
  'Plan for migrating the payments ledger from single-entry bookkeeping to a',
  'double-entry accounting model, without downtime for merchant payouts.',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[Legacy single-entry ledger] --> B[Dual-write shadow ledger]',
  '  B --> C[Backfill historical entries]',
  '  C --> D[Verify balances reconcile]',
  '  D --> E[Cut over reads to double-entry ledger]',
  '  E --> F[Remove legacy ledger_id column]',
  '```',
  '',
  '## Rollback',
  '',
  'Each phase is independently reversible until the cutover step — the shadow',
  'ledger can be dropped with no reads depending on it.',
].join('\n');

function libraryHandler(path: string, respond: AuditResponder, route: Route): Promise<void> | undefined {
  const url = new URL(route.request().url());

  if (path.endsWith(`/library/${FILE_LEDGER_PLAN_ID}/preview`)) {
    return route.fulfill({
      status: 200,
      contentType: 'text/markdown; charset=utf-8',
      body: LEDGER_MIGRATION_MARKDOWN,
    });
  }

  if (path === `${BASE}/library/${FILE_LEDGER_PLAN_ID}`) {
    return respond(200, {
      file: LIBRARY_FILES.find((f) => f.id === FILE_LEDGER_PLAN_ID),
      tags: LIBRARY_FILES.find((f) => f.id === FILE_LEDGER_PLAN_ID)?.tags ?? [],
    });
  }

  if (path === `${BASE}/library/directories`) {
    const parentDirectory = url.searchParams.get('parentDirectory') ?? '/';
    const parentDepth = parentDirectory === '/' ? 0 : parentDirectory.split('/').filter(Boolean).length;
    const scoped = LIBRARY_DIRECTORIES.filter((dir) => {
      const segments = dir.path.split('/').filter(Boolean);
      if (segments.length !== parentDepth + 1) return false;
      return parentDirectory === '/' || dir.path.startsWith(parentDirectory);
    });
    return respond(200, { directories: scoped });
  }

  if (path === `${BASE}/library`) {
    const directory = url.searchParams.get('directory');
    const recursive = url.searchParams.get('recursive') === 'true';
    const scopedFiles = LIBRARY_FILES.filter((file) => {
      if (directory) return recursive ? file.directory.startsWith(directory) : file.directory === directory;
      return true;
    });
    return respond(200, { files: scopedFiles, total: scopedFiles.length, cursor: null });
  }

  return undefined;
}

test('sam-library-browser', async ({ page }) => {
  logPageErrors(page);
  await setupMocks(page, libraryHandler);

  await page.goto(`/projects/${PROJECT_ID}/library`);
  await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible();
  await expect(page.getByLabel(/^Folder: research/)).toBeVisible();
  await expect(page.getByLabel(/^Folder: runbooks/)).toBeVisible();
  await expect(page.getByText('ledger-migration-plan.md')).toBeVisible();
  await expect(page.getByText('pci-compliance-checklist.pdf')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload files' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Sort by' })).toBeVisible();
  await expect(page.getByText('architecture').first()).toBeVisible();
  await expect(page.getByText('compliance').first()).toBeVisible();
  await expect(page.getByText('ledger').first()).toBeVisible();
  await assertNoCrash(page);
  await assertNoOverflow(page);

  await marketingShot(page, 'sam-library-browser');
});

test('sam-document-viewer', async ({ page }) => {
  logPageErrors(page);
  await setupMocks(page, libraryHandler);

  await page.goto(`/projects/${PROJECT_ID}/library?preview=${FILE_LEDGER_PLAN_ID}`);
  const dialog = page.getByRole('dialog', { name: /preview-modal-title/ }).or(page.getByRole('dialog'));
  await expect(dialog.first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ledger-migration-plan.md' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rendered view' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Source view' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Download ledger-migration-plan.md/ })).toBeVisible();

  // FilePreviewModal renders markdown via apps/web's own MarkdownRenderer,
  // which sanitizes the mermaid engine's SVG output directly into the
  // `mermaid-diagram` container (no separate `mermaid-diagram-svg` wrapper —
  // that testid belongs to the packages/acp-client chat-message renderer).
  const diagram = page.getByTestId('mermaid-diagram');
  await expect(diagram).toBeVisible({ timeout: 15_000 });
  const svg = diagram.locator('svg').first();
  await expect(svg).toBeVisible({ timeout: 15_000 });

  await assertNoCrash(page);

  const modal = page.locator('[role="dialog"]').first();
  await page.addStyleTag({
    content: `.glass-backdrop-dim{background:${OPAQUE_BACKDROP_COLOR} !important;opacity:1 !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}`,
  });
  await marketingShot(page, 'sam-document-viewer', modal);
});

// ---------------------------------------------------------------------------
// F. Project settings — Agents tab: default agent type + per-agent overrides
// ---------------------------------------------------------------------------

function agentInfo(overrides: {
  id: string;
  name: string;
  description: string;
  configured: boolean;
  fallbackCredentialSource?: 'platform-sam' | null;
}) {
  return {
    id: overrides.id,
    name: overrides.name,
    description: overrides.description,
    supportsAcp: true,
    configured: overrides.configured,
    credentialHelpUrl: 'https://example.com/docs/credentials',
    fallbackCredentialSource: overrides.fallbackCredentialSource ?? null,
  };
}

const AGENTS = [
  agentInfo({
    id: 'claude-code',
    name: 'Claude Code',
    description: "Anthropic's AI coding agent",
    configured: true,
  }),
  agentInfo({
    id: 'openai-codex',
    name: 'OpenAI Codex',
    description: "OpenAI's AI coding agent",
    configured: true,
  }),
  agentInfo({
    id: 'google-gemini',
    name: 'Gemini CLI',
    description: "Google's AI coding agent",
    configured: false,
  }),
];

const PROJECT_AGENT_CREDENTIALS = [
  {
    agentType: 'claude-code',
    provider: 'anthropic',
    credentialKind: 'api-key',
    isActive: true,
    maskedKey: 'sk-ant-****pymt',
    createdAt: iso(-30 * 86_400_000),
    updatedAt: iso(-2 * 86_400_000),
    scope: 'project',
    projectId: PROJECT_ID,
  },
];

function settingsAgentsHandler(path: string, respond: AuditResponder): Promise<void> | undefined {
  if (path === '/api/agents') return respond(200, { agents: AGENTS });
  if (path === `${BASE}/credentials`) return respond(200, { credentials: PROJECT_AGENT_CREDENTIALS });
  return undefined;
}

test('sam-project-settings', async ({ page }) => {
  logPageErrors(page);
  await setupMocks(page, settingsAgentsHandler);

  await page.goto(`/projects/${PROJECT_ID}/settings/agents`);
  await expect(page.getByRole('heading', { name: 'Project Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Default Agent Type' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Agent Overrides' })).toBeVisible();
  await expect(page.getByText('Claude Code').first()).toBeVisible();
  await expect(page.getByText('Project override').first()).toBeVisible();
  await assertNoCrash(page);
  await assertNoOverflow(page);

  await marketingShot(page, 'sam-project-settings');
});
