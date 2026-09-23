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
import { docsShot, opaqueBackdrop } from './docs-shot';

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
// Resource history: a session that peaked hard enough to be OOM-killed.
// ---------------------------------------------------------------------------

const CHUNK_ID = 'wrchunk-docs-2';

/**
 * One chunk at the shipped defaults: 15 minutes of 5-second samples, so 180 points —
 * comfortably under WORKSPACE_RESOURCE_DETAIL_MAX_POINTS (720). Downsampling therefore
 * does not fire, which is what a reader's own panel will show, so the captured header
 * must read a plain point count rather than the `<shown>/<total>` downsampled form.
 */
const CHUNK_SAMPLE_COUNT = 180;

/** Index of the out-of-memory sample, and of the telemetry gap after it. */
const OOM_INDEX = Math.round(CHUNK_SAMPLE_COUNT * 0.55);
const GAP_INDEX = Math.round(CHUNK_SAMPLE_COUNT * 0.7);

const RESOURCE_SUMMARY = {
  id: `workspace:${PROJECT_ID}:${WORKSPACE_ID}:session:${SESSION_ID}`,
  projectId: PROJECT_ID,
  workspaceId: WORKSPACE_ID,
  sessionId: SESSION_ID,
  taskId: 'task-docs-1',
  nodeId: NODE_ID,
  agentProfileId: 'profile-docs-1',
  skillId: null,
  agentType: 'claude-code',
  runtime: 'vm',
  sourceVersion: 1,
  startedAt: NOW - 1_920_000,
  endedAt: NOW - 120_000,
  sampleCount: 360,
  gapCount: 1,
  toolSpanCount: 8,
  cpuMeanMillis: 940,
  cpuPeakMillis: 4_120,
  memoryMeanBytes: 1_181_116_006,
  memoryPeakBytes: 3_650_722_201,
  memoryKernelPeakBytes: 3_758_096_384,
  ioReadBytes: 402_653_184,
  ioWriteBytes: 1_181_116_006,
  oomCount: 1,
  completeness: { status: 'complete' },
  summary: {},
  firstChunkId: 'wrchunk-docs-1',
  latestChunkId: CHUNK_ID,
};

const RESOURCE_CHUNKS = [
  {
    id: CHUNK_ID,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    taskId: 'task-docs-1',
    nodeId: NODE_ID,
    chunkSequence: 2,
    sourceVersion: 1,
    storageFormat: 'resource-history-gzip-json-v1',
    compressedBytes: 7_412,
    uncompressedBytes: 128_904,
    sha256: 'a'.repeat(64),
    startedAt: NOW - 1_020_000,
    endedAt: NOW - 120_000,
    sampleCount: CHUNK_SAMPLE_COUNT,
    gapCount: 1,
    toolSpanCount: 5,
    completeness: { status: 'complete' },
    summary: { cpuPeakMillis: 4_120 },
    expiresAt: NOW + 90 * 86_400_000,
  },
  {
    id: 'wrchunk-docs-1',
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    taskId: 'task-docs-1',
    nodeId: NODE_ID,
    chunkSequence: 1,
    sourceVersion: 1,
    storageFormat: 'resource-history-gzip-json-v1',
    compressedBytes: 6_140,
    uncompressedBytes: 101_220,
    sha256: 'b'.repeat(64),
    startedAt: NOW - 1_920_000,
    endedAt: NOW - 1_020_000,
    sampleCount: CHUNK_SAMPLE_COUNT,
    gapCount: 0,
    toolSpanCount: 3,
    completeness: { status: 'complete' },
    summary: { cpuPeakMillis: 1_980 },
    expiresAt: NOW + 90 * 86_400_000,
  },
];

/**
 * A build ramp, a test spike, the OOM, then a quieter recovery.
 *
 * The wobble is a slow sine rather than `i % n`: at 180 points a modulo jitter
 * draws a sawtooth that fills the chart and hides the shape the docs describe.
 */
function wobble(i: number, amplitude: number): number {
  return Math.round(amplitude * (0.5 + 0.5 * Math.sin(i / 9)));
}

function sampleCpu(i: number): number {
  if (i === OOM_INDEX) return 4_120;
  if (i >= OOM_INDEX - 6 && i <= OOM_INDEX + 3) return 2_300 + wobble(i, 700);
  if (i >= CHUNK_SAMPLE_COUNT * 0.15 && i <= CHUNK_SAMPLE_COUNT * 0.32) {
    return 1_450 + wobble(i, 520);
  }
  return 300 + wobble(i, 240);
}

function sampleMemory(i: number): number {
  if (i === OOM_INDEX) return 3_650_722_201;
  if (i >= CHUNK_SAMPLE_COUNT * 0.4) return 2_100_000_000 + i * 8_000_000;
  return 620_000_000 + i * 13_000_000;
}

const RESOURCE_DETAIL = {
  chunkId: CHUNK_ID,
  originalSampleCount: CHUNK_SAMPLE_COUNT,
  downsampled: false,
  downsampleLimit: 720,
  samples: Array.from({ length: CHUNK_SAMPLE_COUNT }, (_, i) => ({
    t: NOW - 1_020_000 + i * 5_000,
    intervalMillis: 5_000,
    cpuMillis: sampleCpu(i),
    memoryBytes: sampleMemory(i),
    memoryPeakBytes: sampleMemory(i),
    // Scaled so one chunk's I/O stays well inside RESOURCE_SUMMARY's session totals:
    // 30 x 5 MiB + 150 x 64 KiB read, 36 x 12 MiB + 144 x 64 KiB write. The guide
    // teaches the reader to compare the chunk line against the session stat card, so a
    // slice that out-reads the session containing it would read as a contradiction.
    ioReadBytes: i % 6 === 0 ? 5_242_880 : 65_536,
    ioWriteBytes: i % 5 === 0 ? 12_582_912 : 65_536,
    oom: i === OOM_INDEX ? 1 : 0,
    oomKill: i === OOM_INDEX ? 1 : 0,
    gap: i === GAP_INDEX,
  })),
  toolSpans: [
    {
      id: 'span-read',
      kind: 'acp_tool_call',
      startedAt: NOW - 960_000,
      endedAt: NOW - 840_000,
      concurrency: 1,
    },
    {
      id: 'span-build',
      kind: 'acp_tool_call',
      startedAt: NOW - 780_000,
      endedAt: NOW - 540_000,
      concurrency: 2,
    },
    {
      id: 'span-tests',
      kind: 'acp_tool_call',
      startedAt: NOW - 500_000,
      endedAt: NOW - 260_000,
      concurrency: 1,
      approximate: true,
    },
  ],
  gaps: [{ startedAt: NOW - 400_000, endedAt: NOW - 360_000, reason: 'sampler_delay' }],
};

// ---------------------------------------------------------------------------
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
    const { pathname, searchParams } = new URL(url);
    const json = (body: unknown) => route.fulfill({ status: 200, json: body });

    if (pathname.endsWith('/ws') || url.includes('websocket')) return route.abort();
    if (pathname.startsWith('/api/auth')) return json(MOCK_USER);
    if (pathname === '/api/projects') return json({ projects: [MOCK_PROJECT], nextCursor: null });
    if (pathname === `/api/projects/${PROJECT_ID}`) return json(MOCK_PROJECT);
    if (pathname === '/api/report-issue/config') return json({ enabled: true });

    const sessionBase = `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}`;
    if (pathname === `${sessionBase}/resource-history`) {
      // Detail is returned only for the chunk the drawer asks for, exactly as the API
      // behaves — so the auto-load path is what produces the chart in the image.
      const wantsDetail = searchParams.get('chunkId') === CHUNK_ID;
      return json({
        summary: RESOURCE_SUMMARY,
        chunks: RESOURCE_CHUNKS,
        ...(wantsDetail ? { detail: RESOURCE_DETAIL } : {}),
      });
    }
    if (pathname === `${sessionBase}/messages`) return json({ messages, hasMore: false });
    if (pathname === `${sessionBase}/state`) return json(state);
    if (pathname === sessionBase) {
      return json({ session: MOCK_SESSION, messages, hasMore: false, state });
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions`) {
      return json({ sessions: [MOCK_SESSION], total: 1 });
    }

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
  for (const id of ['timeline', 'resources', 'events', 'comments', 'report', 'details']) {
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
  // The stat cards, the OOM banner and the auto-loaded chart are the three things the
  // guide describes, so all three must be on screen before the shutter fires.
  //
  // `exact` matters: the chart legend also contains the words "CPU peak", so a substring
  // match resolves to two nodes once the chart renders and the assertion becomes a race
  // between "one match, passes" and "two matches, strict-mode violation".
  await expect(drawer.getByText('CPU peak', { exact: true })).toBeVisible();
  await expect(drawer.getByText(/OOM event/)).toBeVisible();
  await expect(drawer.getByRole('img', { name: /resource timeline/i })).toBeVisible();
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
// 3. The Events drawer
// ---------------------------------------------------------------------------

test('docs: session events drawer', async ({ page }) => {
  test.skip(isMobile(page), 'desktop capture');
  await openChat(page);
  await page.getByTestId('session-tool-events').click();

  const drawer = page.getByRole('dialog', { name: 'Session events' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole('tab', { name: 'Subscriptions' })).toBeVisible();
  await expect(drawer.getByRole('link', { name: 'View full page' })).toBeVisible();

  await opaqueBackdrop(page);
  await docsShot(page, 'session-events-drawer', drawer);
});

// ---------------------------------------------------------------------------
// 4. The project Events page
// ---------------------------------------------------------------------------

test('docs: project events page', async ({ page }) => {
  test.skip(isMobile(page), 'desktop capture');
  await seedTheme(page, 'dark');
  await setupMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/events`);

  await expect(page.getByRole('heading', { name: 'Events', level: 1 })).toBeVisible({
    timeout: 20000,
  });
  for (const label of ['Subscriptions', 'Schedules', 'Standing watches', 'Channels']) {
    await expect(page.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
  }

  await docsShot(page, 'project-events-page', page.getByRole('main').first());
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
