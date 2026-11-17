/**
 * Visual + behavioural audit for the Run receipt (Insights slice R), against the REAL project
 * chat: the Receipt tool in the session tool rail opens the receipt panel (desktop) or a full
 * sheet (phone). Nothing sets panel state directly (`.claude/rules/62`).
 */
import { expect, type Page, type Route, test } from '@playwright/test';
import type { RunReceipt } from '@simple-agent-manager/shared';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
  seedTheme,
} from './audit-helpers';
import { docsShot } from './docs-shot';

const PROJECT_ID = 'proj-receipt-1';
const SESSION_ID = 'cs-receipt-1';
const WORKSPACE_ID = 'ws-receipt-1';
const TASK_ID = 'task-receipt-1';
const NOW = Date.now();
const MIN = 60_000;
const START = NOW - 45 * MIN;

const MOCK_USER = makeMockUser({
  email: 'receipt@example.com',
  name: 'Receipt Tester',
  role: 'superadmin',
  sessionId: 'session-receipt-1',
  userId: 'user-receipt-1',
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Acme Billing',
  repository: 'acme/billing',
  defaultBranch: 'main',
  userId: MOCK_USER.user.id,
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const LONG_TITLE =
  'Add a retry budget to snapshot uploads so a slow R2 region can never pin a workspace forever, make it configurable per installation, and document the new admin setting with its default and range';
const LONG_QUESTION =
  'Should retries back off exponentially (1s, 2s, 4s… capped at 30s) or keep the fixed 2s delay? https://github.com/acme/billing/blob/main/packages/storage/src/snapshot-upload/retry-budget-configuration-reference.md';

function slow(
  partial: Partial<RunReceipt['slowedDown'][number]> & {
    kind: RunReceipt['slowedDown'][number]['kind'];
  }
) {
  return {
    durationMs: null,
    usualMs: null,
    comparedBy: null,
    sampleSize: null,
    question: null,
    peakMemoryBytes: null,
    requestedMemoryMb: null,
    count: null,
    ...partial,
  };
}

function makeReceipt(overrides: Partial<RunReceipt> = {}): RunReceipt {
  return {
    projectId: PROJECT_ID,
    taskId: TASK_ID,
    sessionId: SESSION_ID,
    title: 'Add retry budget to snapshot uploads',
    status: 'completed',
    live: false,
    createdAt: new Date(START).toISOString(),
    endedAt: new Date(START + 42 * MIN + 40_000).toISOString(),
    totalMs: 42 * MIN + 40_000,
    phases: [
      { key: 'machine', durationMs: 40_000 },
      { key: 'setup', durationMs: 190_000 },
      { key: 'agent', durationMs: 21.5 * MIN },
      { key: 'waiting', durationMs: 500_000 },
      { key: 'ci', durationMs: 9 * MIN },
    ],
    outcome: {
      pullRequest: {
        number: 2771,
        url: 'https://github.com/acme/billing/pull/2771',
        title: 'Add retry budget to snapshot uploads',
        repository: 'acme/billing',
        state: 'merged',
        mergedAt: new Date(START + 42 * MIN).toISOString(),
      },
      checks: 'success',
      // The first push failed and a later one passed: the line says both.
      ciFirstTry: 'failed',
      terminalReason: null,
    },
    account: {
      agentType: 'claude-code',
      credentialSource: 'user',
      credentialScope: 'profile',
      accountName: 'Personal Max',
      isOwnSession: true,
    },
    resources: {
      measured: true,
      peakMemoryBytes: 3.1 * 1024 ** 3,
      requestedMemoryMb: 4096,
      peakCpuMillis: 1900,
      requestedCpuMillis: 2000,
      oomKills: 0,
    },
    toolCalls: {
      total: 186,
      byKind: [
        { kind: 'execute', count: 74 },
        { kind: 'read', count: 61 },
        { kind: 'edit', count: 39 },
        { kind: 'search', count: 12 },
      ],
      scanLimited: false,
    },
    tokens: { state: 'not_reported' },
    slowedDown: [
      slow({ kind: 'waiting', durationMs: 500_000, question: 'Use exponential backoff?' }),
      slow({
        kind: 'setup',
        durationMs: 190_000,
        usualMs: 82_000,
        comparedBy: 'skill',
        sampleSize: 12,
      }),
    ],
    unavailable: [],
    generatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

function modelUsage(model: string | null, input: number, output: number, cacheRead = 0) {
  return {
    model,
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    reasoning: null,
    estimatedSpendUsd: null,
  };
}

/** Measured tokens on an API-key account (slice U): one main model plus a helper. */
const TOKENS_REPORTED: RunReceipt['tokens'] = {
  state: 'reported',
  source: 'harness',
  limited: false,
  total: { input: 312_000, output: 41_500, cacheRead: 2_140_000, cacheWrite: 86_000, reasoning: null },
  spend: { state: 'estimate', usd: 4.12, unpricedModels: [] },
  models: [
    { ...modelUsage('claude-opus-5-5', 300_000, 40_000, 2_100_000), cacheWrite: 86_000, estimatedSpendUsd: 3.98 },
    { ...modelUsage('claude-haiku-5-5', 12_000, 1_500, 40_000), estimatedSpendUsd: 0.14 },
  ],
};

/** Everything long, special characters, a floor count, every slowdown kind. */
const STRESS_RECEIPT = makeReceipt({
  tokens: {
    state: 'reported',
    source: 'ai_proxy',
    limited: true,
    total: { input: 9_876_543_210, output: 123_456_789, cacheRead: 0, cacheWrite: 0, reasoning: 77 },
    spend: { state: 'not_applicable' },
    models: [
      modelUsage(`openrouter/${'very-long-model-identifier-'.repeat(8)}v2`, 9_000_000_000, 100_000_000),
      modelUsage('<script>alert(1)</script> — émoji 🚀 model', 800_000_000, 20_000_000),
      modelUsage(null, 76_543_210, 3_456_789),
      ...Array.from({ length: 12 }, (_, i) => modelUsage(`helper-model-${i}`, 1_000 * i, 100 * i)),
    ],
  },
  title: LONG_TITLE,
  outcome: {
    pullRequest: {
      number: 123456,
      url: 'https://github.com/acme/billing/pull/123456',
      title: `${LONG_TITLE} <script>alert(1)</script> — émoji 🚀`,
      repository: 'acme/billing',
      state: 'open',
      mergedAt: null,
    },
    checks: 'failure',
    ciFirstTry: 'failed',
    terminalReason: null,
  },
  account: {
    agentType: 'openai-codex',
    credentialSource: 'project',
    credentialScope: 'project',
    accountName:
      'A very long shared project account name used by the whole billing team 0123456789',
    isOwnSession: true,
  },
  toolCalls: {
    total: 20_000,
    byKind: [
      { kind: 'execute', count: 9_000 },
      { kind: 'read', count: 7_000 },
      { kind: 'a_very_long_custom_tool_kind_name_that_does_not_wrap_nicely', count: 4_000 },
    ],
    scanLimited: true,
  },
  slowedDown: [
    slow({ kind: 'waiting', durationMs: 3 * 3_600_000, question: LONG_QUESTION }),
    slow({
      kind: 'machine',
      durationMs: 25 * MIN,
      usualMs: 2 * MIN,
      comparedBy: 'profile',
      sampleSize: 50,
    }),
    slow({ kind: 'ci_failing', durationMs: 14 * MIN }),
  ],
});

/** A run still waiting for a machine: nothing after placement is measured yet. */
const EMPTY_RECEIPT = makeReceipt({
  status: 'queued',
  live: true,
  totalMs: 3 * MIN,
  phases: [
    { key: 'machine', durationMs: 3 * MIN },
    { key: 'setup', durationMs: null },
    { key: 'agent', durationMs: null },
    { key: 'waiting', durationMs: null },
    { key: 'ci', durationMs: null },
  ],
  outcome: { pullRequest: null, checks: null, ciFirstTry: 'not_recorded', terminalReason: null },
  account: null,
  resources: {
    measured: false,
    peakMemoryBytes: null,
    requestedMemoryMb: null,
    peakCpuMillis: null,
    requestedCpuMillis: null,
    oomKills: 0,
  },
  toolCalls: null,
  slowedDown: [],
  unavailable: ['toolCalls'],
});

/** Per-minute CPU rollup for the run, with tool-call bursts behind two peaks. */
function rollup() {
  const minutes = 43;
  const start: number[] = [];
  const end: number[] = [];
  const cpuMax: number[] = [];
  const tools: number[] = [];
  for (let m = 0; m < minutes; m += 1) {
    start.push(START + m * MIN);
    end.push(START + (m + 1) * MIN);
    const burst = (m >= 5 && m <= 8) || (m >= 30 && m <= 34);
    cpuMax.push(burst ? 1.4 + (m % 3) * 0.2 : 0.2 + (m % 5) * 0.05);
    tools.push(burst ? 3 + (m % 4) : m % 6 === 0 ? 1 : 0);
  }
  const nulls = start.map(() => null);
  return {
    v: 1,
    bucketMs: MIN,
    start,
    end,
    samples: start.map(() => 12),
    cpuMeanCores: cpuMax.map((c) => c * 0.7),
    cpuMaxCores: cpuMax,
    memoryMeanBytes: nulls,
    memoryMaxBytes: nulls,
    workingSetMeanBytes: nulls,
    workingSetMaxBytes: nulls,
    ioReadBytes: nulls,
    ioWriteBytes: nulls,
    oomKills: start.map(() => 0),
    toolCallStarts: tools,
  };
}

const RESOURCE_TIMELINE = {
  sessionId: SESSION_ID,
  runs: [
    {
      workspaceId: WORKSPACE_ID,
      nodeId: null,
      runtime: 'vm',
      startedAt: START,
      endedAt: START + 43 * MIN,
      reservation: { cpuMillis: 2000, memoryMb: 4096 },
    },
  ],
  chunks: [
    {
      id: 'chunk-1',
      workspaceId: WORKSPACE_ID,
      startedAt: START,
      endedAt: START + 43 * MIN,
      sampleCount: 500,
      gapCount: 0,
      toolSpanCount: 60,
      summary: {},
      completeness: {},
      rollup: rollup(),
    },
  ],
  totalChunkCount: 1,
  omittedChunkCount: 0,
  maxChunks: 1000,
  collection: 'collected',
  runtime: 'vm',
};

interface MockOptions {
  receipt?: RunReceipt;
  receiptStatus?: number;
  /** Omit the resource history, so the CPU section falls back to its text. */
  noResources?: boolean;
  theme?: 'dark' | 'light';
}

function makeChatSession() {
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    status: 'active',
    topic: 'Add retry budget to snapshot uploads',
    workspaceId: WORKSPACE_ID,
    agentSessionId: 'as-receipt-1',
    isIdle: true,
    isMine: true,
    agentCompletedAt: NOW - 3 * MIN,
    messageCount: 2,
    startedAt: START,
    endedAt: null,
    taskId: TASK_ID,
    task: {
      id: TASK_ID,
      status: 'completed',
      title: 'Add retry budget to snapshot uploads',
      outputBranch: 'sam/add-retry-budget',
      outputPrUrl: 'https://github.com/acme/billing/pull/2771',
      errorMessage: null,
      outputSummary: null,
      taskMode: 'task',
    },
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
}

const MESSAGES = {
  messages: [
    {
      id: 'msg-1',
      sessionId: SESSION_ID,
      role: 'user',
      content: 'Snapshot uploads retry forever when R2 is slow. Add a retry budget.',
      toolMetadata: null,
      createdAt: START + MIN,
    },
    {
      id: 'msg-2',
      sessionId: SESSION_ID,
      role: 'assistant',
      content: 'Done. Retries now back off from 1 s to 30 s with a budget of 6 attempts.',
      toolMetadata: null,
      createdAt: START + 40 * MIN,
    },
  ],
  hasMore: false,
};

async function setupMocks(page: Page, options: MockOptions = {}) {
  const session = makeChatSession();
  const state = { activity: 'idle', activityAt: NOW, statusError: null, currentPlan: null };
  const receipt = options.receipt ?? makeReceipt();
  if (options.theme) await seedTheme(page, options.theme);

  await page.addInitScript(
    ({ userId }) => {
      window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
      window.localStorage.setItem('sam-session-tool-strip-mode', 'labels');
    },
    { userId: MOCK_USER.user.id }
  );

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    const { pathname } = new URL(url);

    if (pathname.endsWith('/ws') || url.includes('websocket')) {
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
      await route.fulfill({ json: { enabled: true } });
      return;
    }

    // The endpoints under test.
    if (pathname === `/api/projects/${PROJECT_ID}/tasks/${TASK_ID}/receipt`) {
      if (options.receiptStatus) {
        await route.fulfill({
          status: options.receiptStatus,
          json: { error: 'INTERNAL', message: 'boom' },
        });
        return;
      }
      await route.fulfill({ json: receipt });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/resource-timeline`) {
      await route.fulfill({
        json: options.noResources
          ? {
              ...RESOURCE_TIMELINE,
              runs: [],
              chunks: [],
              totalChunkCount: 0,
              collection: 'unsupported',
            }
          : RESOURCE_TIMELINE,
      });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/links`) {
      await route.fulfill({
        json: {
          ideas: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
          files: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
          pullRequests: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
        },
      });
      return;
    }

    if (pathname === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/messages`) {
      await route.fulfill({ json: MESSAGES });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}/state`) {
      await route.fulfill({ json: state });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/sessions/${SESSION_ID}`) {
      await route.fulfill({
        json: { session, messages: MESSAGES.messages, hasMore: false, state },
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
          nodeId: null,
          projectId: PROJECT_ID,
          name: 'run-receipt',
          repository: 'testuser/test-repo',
          branch: 'sam/add-retry-budget',
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

    // Array-shaped endpoints the chat shell reads. Without these the catch-all `{}` below
    // reaches an `Array.prototype` call and the whole page crashes.
    if (
      pathname === '/api/nodes' ||
      pathname === '/api/credentials' ||
      pathname === '/api/notifications' ||
      pathname === '/api/github/installations'
    ) {
      await route.fulfill({ json: [] });
      return;
    }
    if (pathname === '/api/credentials/agent') {
      await route.fulfill({ json: { credentials: [] } });
      return;
    }
    if (pathname === `/api/projects/${PROJECT_ID}/credential-attribution-health`) {
      await route.fulfill({ json: { healthy: true } });
      return;
    }
    if (pathname === '/api/notifications/preferences') {
      await route.fulfill({ json: { email: false, push: false } });
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
    if (pathname === '/api/chats') {
      await route.fulfill({ json: { sessions: [], total: 0 } });
      return;
    }
    if (pathname === '/api/agents') {
      await route.fulfill({ json: { agents: [] } });
      return;
    }
    await route.fulfill({ json: {} });
  });
}

async function openChat(page: Page, options: MockOptions = {}) {
  await setupMocks(page, options);
  await page.goto(`/projects/${PROJECT_ID}/chat/${SESSION_ID}`);
  // Liveness: a crashed page has no rail and no overflow, so every assertion below would pass
  // vacuously without this.
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByTestId('session-tool-receipt')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(600);
}

async function openReceipt(page: Page, options: MockOptions = {}) {
  await openChat(page, options);
  // Hidden until asked for.
  await expect(page.getByTestId('session-receipt-drawer')).toHaveCount(0);
  await page.getByTestId('session-tool-receipt').click();
  const drawer = page.getByTestId('session-receipt-drawer');
  await expect(drawer).toBeVisible();
  return drawer;
}

async function capture(page: Page, name: string) {
  await screenshot(page, name);
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
  // The panel scrolls inside itself; capture its end too, so every section is seen at 375.
  const scroller = page.getByTestId('session-receipt-drawer').locator('.overflow-y-auto').first();
  if ((await scroller.count()) === 1) {
    await scroller.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await screenshot(page, `${name}-end`);
  }
}

/** The panel must sit inside the viewport, measured, not just be "visible". */
async function assertInViewport(page: Page) {
  const box = await page.getByTestId('session-receipt-drawer').boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
}

test.describe('Run receipt — chat tool rail', () => {
  test('opens from the rail and shows the run’s phases, tiles, CPU line and slowdowns', async ({
    page,
  }) => {
    const drawer = await openReceipt(page);
    const view = drawer.getByTestId('run-receipt');
    await expect(view.getByText('Merged')).toBeVisible();
    await expect(view.getByText('PR #2771 · CI passed · first push failed · 42m')).toBeVisible();
    await expect(view.getByRole('link', { name: /opens in a new tab/ })).toHaveAttribute(
      'href',
      'https://github.com/acme/billing/pull/2771'
    );
    await expect(view.getByTestId('receipt-phase-bar').locator('[data-phase]')).toHaveCount(5);
    await expect(view.getByText('Not reported')).toBeVisible();
    await expect(view.getByText('Personal Max')).toBeVisible();
    await expect(view.getByText('74 shell · 61 read · 39 edit')).toBeVisible();
    await expect(view.getByTestId('receipt-cpu-line')).toBeVisible();
    expect(await view.getByTestId('receipt-cpu-marker').count()).toBeGreaterThan(2);
    await expect(view.getByText('Setup took 3m 10s')).toBeVisible();
    await expect(view.getByText('“Use exponential backoff?”')).toBeVisible();
    await assertInViewport(page);
    await capture(page, 'run-receipt-normal');

    // Closing returns to the chat.
    await drawer.getByRole('button', { name: 'Close receipt' }).click();
    await expect(page.getByTestId('session-receipt-drawer')).toHaveCount(0);
  });

  test('shows measured tokens per model with an API-key spend estimate', async ({ page }) => {
    // An API-key account: only those get a spend estimate (the docs image shows this scene).
    const base = makeReceipt();
    const drawer = await openReceipt(page, {
      receipt: makeReceipt({
        tokens: TOKENS_REPORTED,
        account: base.account ? { ...base.account, accountName: 'Work API key' } : null,
      }),
    });
    await expect(drawer.getByText('2.6M')).toBeVisible();
    await expect(drawer.getByText('Incl. 2.2M cache · Reported by the agent')).toBeVisible();
    const models = drawer.getByTestId('receipt-token-models');
    await expect(models.getByText('claude-opus-5-5')).toBeVisible();
    await expect(models.locator('li').first()).toContainText('~$3.98');
    await expect(drawer.getByTestId('receipt-token-spend')).toHaveText(
      '~$4.12 estimated at SAM’s model prices'
    );
    await expect(drawer.getByText('Not reported')).toHaveCount(0);
    await assertInViewport(page);
    // Docs image (chat-features.md, Run Receipt): the open receipt beside the chat.
    if ((page.viewportSize()?.width ?? 0) >= 1280) await docsShot(page, 'run-receipt');
    await capture(page, 'run-receipt-tokens');
  });

  test('long text, special characters and a floor count wrap inside the panel', async ({
    page,
  }) => {
    const drawer = await openReceipt(page, { receipt: STRESS_RECEIPT });
    await expect(drawer.getByText('PR open')).toBeVisible();
    await expect(drawer.getByText('20000+')).toBeVisible();
    await expect(drawer.getByText(/^PR #123456 · CI failing · first push failed · /)).toBeVisible();
    await expect(drawer.getByText('CI is failing on the latest commit')).toBeVisible();
    await expect(drawer.getByText(/<script>alert\(1\)<\/script>/)).toHaveCount(2);
    await expect(drawer.getByText('10B+')).toBeVisible();
    await expect(drawer.getByTestId('receipt-token-models').locator('li')).toHaveCount(15);
    await expect(drawer.getByText('Model not reported')).toBeVisible();
    // The middle of the long model list is seen too, not only the panel's top and end.
    await drawer.getByText('Model not reported').scrollIntoViewIfNeeded();
    await screenshot(page, 'run-receipt-long-text-models');
    await assertInViewport(page);
    await capture(page, 'run-receipt-long-text');
  });

  test('a run still waiting for a machine says what is not measured yet', async ({ page }) => {
    const drawer = await openReceipt(page, { receipt: EMPTY_RECEIPT, noResources: true });
    await expect(drawer.getByText('Running')).toBeVisible();
    await expect(drawer.getByText('not yet', { exact: true })).toHaveCount(4);
    await expect(drawer.getByText('Not recorded', { exact: true })).toBeVisible();
    await expect(drawer.getByText('Nothing stood out against recent runs.')).toBeVisible();
    await expect(drawer.getByText('No CPU history was recorded for this run.')).toBeVisible();
    await capture(page, 'run-receipt-empty');
  });

  test('reads in the light theme', async ({ page }) => {
    const drawer = await openReceipt(page, { theme: 'light', receipt: STRESS_RECEIPT });
    await expect(drawer.getByTestId('run-receipt')).toBeVisible();
    await capture(page, 'run-receipt-light');
  });

  test('a failed read shows a retry, not a blank panel', async ({ page }) => {
    const drawer = await openReceipt(page, { receiptStatus: 500 });
    await expect(drawer.getByTestId('run-receipt-error')).toBeVisible({ timeout: 15_000 });
    await expect(drawer.getByRole('button', { name: 'Try again' })).toBeVisible();
    await capture(page, 'run-receipt-error');
  });
});
