/**
 * Documentation screenshots for the chat session surfaces — the tool rail and the two
 * drawers it opens (Resources, Events) — plus the project Events page.
 *
 * Every capture drives the REAL production components with mocked API data and clicks
 * the same controls a user clicks, so a component that stopped rendering fails the
 * capture rather than quietly producing a stale-looking image
 * (`.claude/rules/62-tests-must-observe-the-real-trigger.md`).
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-sessions --project="Desktop (1280x800)"
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-sessions --project="iPhone SE (375x667)"
 *
 * Each test self-selects its viewport, so running both projects produces the desktop and
 * mobile images without either overwriting the other.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { makeMockUser, seedTheme } from './audit-helpers';
import { expandScrollContainers } from './automation-audit-helpers';
import { docsShot, opaqueBackdrop } from './docs-shot';
import { buildResourceScenario } from './resource-timeline-scenarios';

const PROJECT_ID = 'proj-docs-1';
const SESSION_ID = '01K9CHATDOCS5EFJ8TW0N6RQZD';
const WORKSPACE_ID = 'ws-docs-1';
const NODE_ID = 'node-docs-1';
const TOOL_STRIP_MODE_KEY = 'sam-session-tool-strip-mode';

/** Fixed clock so captured timestamps are stable between runs. */
const NOW = Date.parse('2026-09-22T14:40:00Z');

const MOCK_USER = makeMockUser({
  email: 'docs@example.com',
  name: 'Docs User',
  role: 'superadmin',
  sessionId: 'session-docs-1',
  userId: 'user-docs-1',
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'acme/checkout-service',
  repository: 'acme/checkout-service',
  defaultBranch: 'main',
  userId: MOCK_USER.user.id,
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};

const MOCK_SESSION = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  status: 'active',
  topic: 'Speed up the nightly reconciliation job',
  workspaceId: WORKSPACE_ID,
  agentSessionId: 'as-docs-1',
  isIdle: false,
  isMine: true,
  agentCompletedAt: null,
  messageCount: 6,
  startedAt: NOW - 3_600_000,
  endedAt: null,
  createdAt: NOW - 3_600_000,
  lastMessageAt: NOW - 120_000,
  taskId: 'task-docs-1',
  agentType: 'claude-code',
  // Session detail always carries the viewer's access (`enrichSessionWithAccess`), which is
  // what puts Share in the rail; nobody else has access yet.
  viewerAccess: 'owner',
  access: {
    sessionId: SESSION_ID,
    viewerAccess: 'owner',
    owner: { id: MOCK_USER.user.id, name: 'Docs User', avatarUrl: null },
    grants: [],
    serverTime: NOW,
  },
  task: {
    id: 'task-docs-1',
    status: 'in_progress',
    executionStep: 'agent_session',
    outputBranch: 'sam/speed-up-reconciliation',
    outputPrUrl: null,
    errorMessage: null,
    outputSummary: null,
    finalizedAt: null,
    taskMode: 'task',
    agentProfileHint: 'default',
  },
};

// ---------------------------------------------------------------------------
// Conversation: a short prose turn, a run of tool calls, then a closing turn.
// This is the shape the activity card exists to compress.
// ---------------------------------------------------------------------------

let clock = NOW - 900_000;
function nextTs(): number {
  clock += 4_000;
  return clock;
}

function textMessage(id: string, role: 'user' | 'assistant', content: string) {
  return { id, sessionId: SESSION_ID, role, content, toolMetadata: null, createdAt: nextTs() };
}

function toolMessage(id: string, title: string, status: 'completed' | 'failed' = 'completed') {
  return {
    id,
    sessionId: SESSION_ID,
    role: 'tool',
    content: '(tool call)',
    toolMetadata: { toolCallId: `tc-${id}`, title, kind: 'execute', status, contentSize: 256 },
    createdAt: nextTs(),
  };
}

const TOOL_TITLES = [
  'Read: apps/api/src/jobs/reconcile.ts',
  'Grep: settleBatch',
  'Read: apps/api/src/jobs/batching.ts',
  'Edit: apps/api/src/jobs/reconcile.ts',
  'Bash: pnpm --filter @simple-agent-manager/api test reconcile',
  'Bash: pnpm typecheck',
  'Edit: apps/api/tests/unit/jobs/reconcile.test.ts',
  'Bash: pnpm --filter @simple-agent-manager/api test reconcile',
];

function conversation() {
  clock = NOW - 900_000;
  return [
    textMessage(
      'm-1',
      'user',
      'The nightly reconciliation takes 40 minutes. Find out where the time goes and fix the worst offender.'
    ),
    textMessage(
      'm-2',
      'assistant',
      'Let me read the job and the batching helper it calls, then measure a single pass.'
    ),
    ...TOOL_TITLES.map((title, i) =>
      toolMessage(`m-tool-${i}`, title, i === 5 ? 'failed' : 'completed')
    ),
    textMessage(
      'm-3',
      'assistant',
      'The job re-fetched the settlement table once per row. Batching it into a single query took the pass from 38 minutes to 90 seconds. Typecheck flagged one unrelated import, which I also fixed.'
    ),
  ];
}

// ---------------------------------------------------------------------------
// Resource history: the shared "overnight" scenario the Resources audit also uses — a long
// session with many wakes on three nodes and one out-of-memory kill.
// ---------------------------------------------------------------------------

const RESOURCES = buildResourceScenario('overnight', SESSION_ID, NOW);

// ---------------------------------------------------------------------------
/** Two recurring and reacting automations for the Automation page capture. */
const AUTOMATION_TRIGGERS = [
  {
    id: 'trg-docs-summary',
    projectId: PROJECT_ID,
    userId: 'user-docs-1',
    name: 'Morning pull request summary',
    description: null,
    status: 'active',
    sourceType: 'cron',
    cronExpression: '0 9 * * 1,2,3,4,5',
    cronHumanReadable: 'Every weekday at 9:00 AM UTC',
    cronTimezone: 'UTC',
    skipIfRunning: true,
    promptTemplate: 'Summarize the open pull requests and what each one needs.',
    agentProfileId: null,
    skillId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    // Consistent with the cron and NOW (Tuesday 14:40 UTC): it ran at 9:00 today, next at 9:00
    // tomorrow, so the capture never shows a "next run" that contradicts its own schedule.
    lastTriggeredAt: '2026-09-22T09:00:00.000Z',
    triggerCount: 18,
    nextFireAt: '2026-09-23T09:00:00.000Z',
    createdAt: new Date(NOW - 30 * 86_400_000).toISOString(),
    updatedAt: new Date(NOW - 86_400_000).toISOString(),
  },
  {
    id: 'trg-docs-sam',
    projectId: PROJECT_ID,
    userId: 'user-docs-1',
    name: 'Answer /sam comments',
    description: null,
    status: 'active',
    sourceType: 'github',
    cronExpression: null,
    cronTimezone: 'UTC',
    skipIfRunning: true,
    promptTemplate: '{{github.actor}} asked: {{github.comment}}',
    agentProfileId: null,
    skillId: null,
    taskMode: 'task',
    vmSizeOverride: null,
    maxConcurrent: 1,
    lastTriggeredAt: new Date(NOW - 50 * 60_000).toISOString(),
    triggerCount: 7,
    nextFireAt: null,
    createdAt: new Date(NOW - 20 * 86_400_000).toISOString(),
    updatedAt: new Date(NOW - 86_400_000).toISOString(),
    githubConfig: {
      eventType: 'issue_comment',
      filters: { actions: ['created'], commandPrefix: '/sam' },
    },
  },
];

/**
 * Two workflow runs for the Automation overview, timed against NOW: one that needs attention
 * after a failed step, and one still running.
 */
const WORKFLOW_RUNS = [
  {
    id: 'run-docs-flaky',
    title: 'Fix the flaky checkout test and ship it',
    status: 'needs_attention',
    startedByUserId: 'user-docs-1',
    createdAt: new Date(NOW - 5 * 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 3 * 3_600_000).toISOString(),
    deadlineAt: new Date(NOW + 67 * 3_600_000).toISOString(),
    steps: [
      {
        key: 'investigate',
        title: 'Find the cause',
        kind: 'agent',
        status: 'completed',
        reason: null,
      },
      {
        key: 'fix',
        title: 'Fix and test it',
        kind: 'agent',
        status: 'failed',
        reason: 'The agent finished without a summary',
      },
      {
        key: 'ship',
        title: 'Open the pull request',
        kind: 'agent',
        status: 'blocked',
        reason: 'Blocked: fix did not succeed',
      },
    ],
  },
  {
    id: 'run-docs-release',
    title: 'Write and review the release notes',
    status: 'active',
    startedByUserId: 'user-docs-1',
    createdAt: new Date(NOW - 2 * 3_600_000).toISOString(),
    updatedAt: new Date(NOW - 20 * 60_000).toISOString(),
    deadlineAt: new Date(NOW + 70 * 3_600_000).toISOString(),
    steps: [
      {
        key: 'draft',
        title: 'Draft the release notes',
        kind: 'agent',
        status: 'completed',
        reason: null,
      },
      {
        key: 'review',
        title: 'Review tone and wording',
        kind: 'agent',
        status: 'running',
        reason: null,
      },
      { key: 'apply', title: 'Apply the review', kind: 'agent', status: 'waiting', reason: null },
    ],
  },
];

// Events: subscriptions, schedules, and a standing watch.
// ---------------------------------------------------------------------------

const HUMAN_OWNER = { type: 'human', id: MOCK_USER.user.id, name: 'Docs User' };

const EVENT_SUBSCRIPTIONS = {
  subscriptions: [
    {
      id: 'sub-docs-1aaaaaaaa',
      projectId: PROJECT_ID,
      contractVersion: 1,
      owner: HUMAN_OWNER,
      idempotencyKey: 'sub-docs-1-key',
      filter: { version: 1, source: 'github', eventType: 'pull_request.review_requested' },
      filterFingerprint: 'f'.repeat(16),
      matchKeyCount: 2,
      deliveryPreference: {
        requested: 'runtime_steer',
        resolved: 'runtime_steer',
        target: { sessionId: SESSION_ID, taskId: 'task-docs-1' },
      },
      state: 'active',
      reason: 'Tell me when someone requests review on this branch',
      createdAt: NOW - 5_400_000,
      updatedAt: NOW - 600_000,
      expiresAt: NOW + 86_400_000,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      lastMatchedAt: NOW - 600_000,
    },
    {
      id: 'sub-docs-2bbbbbbbb',
      projectId: PROJECT_ID,
      contractVersion: 1,
      owner: { type: 'agent', id: 'as-docs-1', name: 'Claude Code' },
      idempotencyKey: 'sub-docs-2-key',
      filter: { version: 1, source: 'sam', eventType: 'task.completed' },
      filterFingerprint: 'e'.repeat(16),
      matchKeyCount: 1,
      deliveryPreference: {
        requested: 'runtime_steer',
        resolved: 'queued_for_prompt_delivery',
        target: { sessionId: SESSION_ID, taskId: 'task-docs-1' },
      },
      state: 'active',
      reason: 'Wake me when the benchmark task finishes',
      createdAt: NOW - 4_200_000,
      updatedAt: NOW - 180_000,
      expiresAt: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      lastMatchedAt: NOW - 180_000,
    },
  ],
  hasMore: false,
};

const EVENT_SCHEDULES = {
  schedules: [
    {
      id: 'sched-docs-1ccccccc',
      projectId: PROJECT_ID,
      creatorUserId: MOCK_USER.user.id,
      creatorChatSessionId: SESSION_ID,
      reason: 'Re-check the benchmark after the batch change lands',
      action: {
        kind: 'message_session',
        sessionId: SESSION_ID,
        prompt: 'Re-run the reconciliation benchmark and post the new timing.',
      },
      state: 'pending',
      dueAt: NOW + 5_400_000,
      displayTimezone: 'UTC',
      expiresAt: NOW + 86_400_000,
      version: 1,
      idempotencyKey: 'sched-docs-1-key',
      createdAt: NOW - 1_800_000,
      updatedAt: NOW - 1_800_000,
      nextAttemptAt: null,
      attemptCount: 0,
      lastError: null,
      eventId: null,
      deliveryId: null,
      resultTaskId: null,
      resultSessionId: null,
      watchId: null,
      sourceEventId: null,
    },
    {
      id: 'sched-docs-2ddddddd',
      projectId: PROJECT_ID,
      creatorUserId: MOCK_USER.user.id,
      creatorChatSessionId: SESSION_ID,
      reason: 'Open the PR once the benchmark is green',
      action: {
        kind: 'start_session',
        prompt: 'Open a PR for the reconciliation batching change.',
        agentProfileId: null,
        skillId: null,
      },
      state: 'admitted',
      dueAt: NOW - 600_000,
      displayTimezone: 'UTC',
      expiresAt: NOW + 43_200_000,
      version: 2,
      idempotencyKey: 'sched-docs-2-key',
      createdAt: NOW - 3_000_000,
      updatedAt: NOW - 600_000,
      nextAttemptAt: null,
      attemptCount: 1,
      lastError: null,
      eventId: null,
      deliveryId: null,
      resultTaskId: 'task-docs-2',
      resultSessionId: null,
      watchId: null,
      sourceEventId: null,
    },
  ],
  nextCursor: null,
};

const EVENT_WATCHES = {
  watches: [
    {
      id: 'watch-docs-1eeeeeee',
      projectId: PROJECT_ID,
      creatorUserId: MOCK_USER.user.id,
      reason: 'Re-run the benchmark whenever main moves',
      filter: { version: 1, source: 'github', eventType: 'push' },
      action: {
        kind: 'start_session',
        prompt: 'Re-run the reconciliation benchmark against the new main.',
        agentProfileId: null,
        skillId: null,
      },
      state: 'active',
      version: 1,
      idempotencyKey: 'watch-docs-1-key',
      cooldownMs: 900_000,
      maxConcurrent: 1,
      maxExecutions: 20,
      executionCount: 3,
      nextEligibleAt: NOW - 3_600_000,
      subscriptionId: 'sub-docs-watch',
      createdAt: NOW - 86_400_000,
      updatedAt: NOW - 7_200_000,
      lastError: null,
    },
  ],
  nextCursor: null,
};

const EVENT_CHANNELS = {
  channels: [
    {
      id: 'chan-docs-1',
      name: 'reconciliation-benchmarks',
      lifetimeCount: 12,
      lastPublishedAt: NOW - 3_600_000,
    },
  ],
  nextCursor: null,
};

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

interface MockOptions {
  /** Seeds the persisted tool-rail mode before the app boots. */
  toolStripMode?: 'icons' | 'labels' | 'hidden';
}

async function setupMocks(page: Page, options: MockOptions = {}) {
  await page.addInitScript(
    ({ userId, storageKey, mode }) => {
      window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
      if (mode) window.localStorage.setItem(storageKey, mode);
    },
    {
      userId: MOCK_USER.user.id,
      storageKey: TOOL_STRIP_MODE_KEY,
      mode: options.toolStripMode ?? '',
    }
  );

  const messages = conversation();
  const state = {
    activity: 'idle',
    activityAt: NOW - 120_000,
    statusError: null,
    currentPlan: [],
    planUpdatedAt: null,
    promptStartedAt: null,
    agentType: 'claude-code',
    lastStopReason: null,
  };

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    const { pathname } = new URL(url);
    const json = (body: unknown) => route.fulfill({ status: 200, json: body });

    if (pathname.endsWith('/ws') || url.includes('websocket')) return route.abort();
    if (pathname.startsWith('/api/auth')) return json(MOCK_USER);
    if (pathname === '/api/projects') return json({ projects: [MOCK_PROJECT], nextCursor: null });
    if (pathname === `/api/projects/${PROJECT_ID}`) return json(MOCK_PROJECT);
    if (pathname === '/api/report-issue/config') return json({ enabled: true });

    const sessionBase = `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}`;
    // The drawer reads the whole-session index, then fetches chunks as the view needs them.
    const timelineBase = `${sessionBase}/resource-timeline`;
    if (pathname === timelineBase) return json(RESOURCES.index);
    if (pathname.startsWith(`${timelineBase}/chunks/`)) {
      const chunk = RESOURCES.chunks.get(
        decodeURIComponent(pathname.slice(`${timelineBase}/chunks/`.length))
      );
      return chunk ? json(chunk) : route.fulfill({ status: 404, json: { error: 'NOT_FOUND' } });
    }
    if (pathname === `${sessionBase}/messages`) return json({ messages, hasMore: false });
    if (pathname === `${sessionBase}/state`) return json(state);
    if (pathname === sessionBase) {
      return json({ session: MOCK_SESSION, messages, hasMore: false, state });
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions`) {
      return json({ sessions: [MOCK_SESSION], total: 1 });
    }

    // The Automation overview lists workflow runs (#2405), and asks separately for the ones
    // that need attention.
    if (pathname === `/api/projects/${PROJECT_ID}/workflows`) {
      const status = new URL(url).searchParams.get('status');
      const runs = status ? WORKFLOW_RUNS.filter((run) => run.status === status) : WORKFLOW_RUNS;
      return json({ runs, nextCursor: null });
    }
    if (pathname === `/api/projects/${PROJECT_ID}/triggers`)
      return json({ triggers: AUTOMATION_TRIGGERS });
    if (/\/triggers\/[^/]+\/executions$/.test(pathname))
      return json({ executions: [], nextCursor: null });
    if (pathname === `/api/projects/${PROJECT_ID}/skills`) return json({ items: [] });
    if (pathname.endsWith('/event-subscriptions')) return json(EVENT_SUBSCRIPTIONS);
    if (pathname.endsWith('/schedules')) return json(EVENT_SCHEDULES);
    if (pathname.endsWith('/standing-watches')) return json(EVENT_WATCHES);
    if (pathname.endsWith('/event-channels')) return json(EVENT_CHANNELS);

    if (pathname === `/api/projects/${PROJECT_ID}/members`) {
      return json({
        members: [
          {
            userId: MOCK_USER.user.id,
            role: 'owner',
            status: 'active',
            user: { id: MOCK_USER.user.id, name: 'Docs User', email: 'docs@example.com' },
          },
        ],
      });
    }
    if (pathname === `/api/projects/${PROJECT_ID}/comment-threads`) {
      return json({ threads: [], total: 0 });
    }
    if (pathname === `/api/workspaces/${WORKSPACE_ID}`) {
      return json({
        id: WORKSPACE_ID,
        nodeId: NODE_ID,
        projectId: PROJECT_ID,
        name: 'checkout-reconcile',
        repository: 'acme/checkout-service',
        branch: 'sam/speed-up-reconciliation',
        status: 'running',
        vmSize: 'medium',
        vmLocation: 'nbg1',
        workspaceProfile: 'full',
        vmIp: '203.0.113.7',
        lastActivityAt: new Date(NOW - 120_000).toISOString(),
        errorMessage: null,
        createdAt: new Date(NOW - 3_600_000).toISOString(),
        updatedAt: new Date(NOW - 120_000).toISOString(),
        chatSessionId: SESSION_ID,
      });
    }
    if (pathname === `/api/nodes/${NODE_ID}`) {
      return json({
        id: NODE_ID,
        name: 'checkout-node-a',
        status: 'running',
        healthStatus: 'healthy',
        cloudProvider: 'hetzner',
      });
    }
    if (pathname === '/api/agents') return json({ agents: [] });
    if (pathname === '/api/credentials/agent') return json({ credentials: [] });
    if (pathname.startsWith('/api/notifications')) return json([]);
    if (pathname.startsWith('/api/credentials')) return json([]);
    if (pathname === '/api/github/installations') return json([]);
    if (pathname === `/api/projects/${PROJECT_ID}/agent-profiles`) return json({ items: [] });
    if (pathname === `/api/projects/${PROJECT_ID}/tasks`) return json({ tasks: [], total: 0 });
    return json({});
  });
}

async function openChat(page: Page, options: MockOptions = {}) {
  await seedTheme(page, 'dark');
  await setupMocks(page, options);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  // Liveness: without this, every capture below would happily screenshot a crash page.
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByTestId('session-tool-rail')).toBeVisible({ timeout: 20000 });
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

// ---------------------------------------------------------------------------
// 1. The session tool rail, labels mode — the discovery surface for everything else
// ---------------------------------------------------------------------------

test('docs: session tool rail with labels', async ({ page }) => {
  test.skip(isMobile(page), 'desktop capture');
  await openChat(page, { toolStripMode: 'labels' });

  const rail = page.getByTestId('session-tool-rail');
  // Assert through the rendered rail, not the fixture: if an action stops being built
  // the capture fails instead of shipping an image that no longer matches the docs table.
  for (const id of [
    'timeline',
    'related',
    'resources',
    'automation',
    'comments',
    'share',
    'retry',
    'fork',
    'report',
    'details',
  ]) {
    await expect(page.getByTestId(`session-tool-${id}`)).toBeVisible();
  }
  await docsShot(page, 'session-tool-rail', rail);
});

// ---------------------------------------------------------------------------
// 2. The Resources drawer, opened the way a user opens it
// ---------------------------------------------------------------------------

async function openResources(page: Page) {
  await openChat(page);
  await page.getByTestId('session-tool-resources').click();
  const drawer = page.getByRole('dialog', { name: 'Session resources' });
  await expect(drawer).toBeVisible();
  // The whole-session card, its out-of-memory warning, the timeline and the Busiest moments
  // list are what the guide describes, so all must be on screen before the shutter fires.
  await expect(drawer.getByText('Whole session', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(drawer.getByText('1 out-of-memory kill')).toBeVisible({ timeout: 10_000 });
  await expect(drawer.getByRole('slider', { name: /Session timeline/ })).toBeVisible();
  await expect(drawer.getByText('Busiest moments', { exact: true })).toBeVisible();
  return drawer;
}

test('docs: session resources drawer', async ({ page }) => {
  test.skip(isMobile(page), 'desktop capture');
  const drawer = await openResources(page);
  await opaqueBackdrop(page);
  await docsShot(page, 'session-resources-drawer', drawer);
});

test('docs: session resources drawer on mobile', async ({ page }) => {
  test.skip(!isMobile(page), 'mobile capture');
  await openResources(page);
  // The drawer is full-screen on mobile, so the page IS the drawer.
  await docsShot(page, 'session-resources-drawer-mobile');
});

// ---------------------------------------------------------------------------
// 3. The chat's Automation panel
// ---------------------------------------------------------------------------

test('docs: session automation panel', async ({ page }) => {
  test.skip(isMobile(page), 'desktop capture');
  // The fixtures are pinned to NOW; pin the page clock too so "since 1 h ago" stays true.
  await page.clock.setFixedTime(NOW);
  // Tall enough that the panel shows "Coming up for this chat" whole instead of under its footer.
  await page.setViewportSize({ width: 1280, height: 1060 });
  await openChat(page);
  await page.getByTestId('session-tool-automation').click();

  const panel = page.getByRole('dialog', { name: 'Automation for this chat' });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('link', { name: /Remind this chat later/ })).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'Waiting for' })).toBeVisible();

  await opaqueBackdrop(page);
  await docsShot(page, 'session-automation-panel', panel);
});

// ---------------------------------------------------------------------------
// 4. The project Automation page
// ---------------------------------------------------------------------------

test('docs: project automation page', async ({ page }) => {
  test.skip(isMobile(page), 'desktop capture');
  await page.clock.setFixedTime(NOW);
  await seedTheme(page, 'dark');
  await setupMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/automation`);

  await expect(page.getByRole('heading', { name: 'Automation', level: 1 })).toBeVisible({
    timeout: 20000,
  });
  await expect(page.getByRole('heading', { name: 'Your automations' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Coming up' })).toBeVisible();
  await expect(page.getByText('Write and review the release notes').first()).toBeVisible();
  await expect(page.getByRole('link', { name: /See what went wrong/ }).first()).toBeVisible();

  // The app scrolls inside its own containers: let them grow so neither column is cut off.
  await expandScrollContainers(page);
  // A margin around the page, so the New automation button at the top isn't cut by the edge. A clip
  // only covers the viewport, so make the viewport as tall as the page first.
  const margin = 16;
  const full = (await page.getByTestId('automation-root').boundingBox())!;
  await page.setViewportSize({ width: 1280, height: Math.ceil(full.y + full.height + margin) });
  const root = (await page.getByTestId('automation-root').boundingBox())!;
  const x = Math.max(0, root.x - margin);
  const y = Math.max(0, root.y - margin);
  await docsShot(page, 'automation-page', {
    clip: {
      x,
      y,
      width: root.x + root.width + margin - x,
      height: root.y + root.height + margin - y,
    },
  });
});

// ---------------------------------------------------------------------------
// 5. A collapsed tool-activity card in the conversation
// ---------------------------------------------------------------------------

test('docs: collapsed tool activity card', async ({ page }) => {
  test.skip(isMobile(page), 'desktop capture');
  await openChat(page);

  // The run above is 8 calls with one failure, so the card must summarise both.
  const card = page.getByRole('button', { name: /8 tool calls/ }).first();
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card).toContainText('1 failed');
  await expect(card).toHaveAttribute('aria-expanded', 'false');

  await docsShot(page, 'chat-tool-activity-card', page.getByRole('log', { name: 'Conversation' }));
});
