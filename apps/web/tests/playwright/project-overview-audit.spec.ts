/**
 * Visual and layout audit for the Project Overview (Inbox slice F1) at 375×667 and 1280×800.
 *
 * Every read is served the way the API answers it, so the real models decide what shows:
 * the aggregated overview read (Running now, Recently), the account model behind the usage
 * rings (Budgets), and the Automation page's model (Automations). Scenes: a normal project, a
 * busy one under stress (12 running, an account at 6% of its week, two failing automations,
 * very long titles and names), an empty quiet project, a sent task (receipt, new row, no
 * navigation), a failed start, and the phone composer unfolded on focus.
 */
import { expect, type Page, type Route, test, type TestInfo } from '@playwright/test';
import type {
  CredentialLimitCredentialSummary,
  CredentialLimitLevel,
  CredentialLimitWindowSummary,
  OverviewRunningChat,
  ProjectOverviewResponse,
} from '@simple-agent-manager/shared';

import { accountRows, mergeRows } from '../unit/components/accounts/fixtures';
import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockUser,
  screenshot,
} from './audit-helpers';
import { RUNS, SCHEDULES, TRIGGERS } from './automation-fixtures';

const PROJECT_ID = 'proj-overview';
const USER_ID = 'user-overview';
const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const BASE = `/projects/${PROJECT_ID}/overview`;

const LONG_TITLE =
  'Migrate the invoicing pipeline from the legacy cron worker to durable queues, backfill three years of historical invoices, and verify every tax total against the accounting export before switching traffic';
const LONG_TOKEN = `refactor-${'unbroken-identifier-'.repeat(8)}end`;

const MOCK_USER = makeMockUser({
  email: 'raph@example.com',
  name: 'Raph',
  sessionId: 'session-overview',
  userId: USER_ID,
});

const MOCK_PROJECT = {
  id: PROJECT_ID,
  name: 'Acme Billing',
  repository: 'acme/billing',
  repoProvider: 'github',
  defaultBranch: 'main',
  userId: USER_ID,
  installationId: 'inst-1',
  defaultWorkspaceProfile: 'full',
  defaultDevcontainerConfigName: '',
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-11-15T00:00:00Z',
  multiplayerActive: false,
  summary: {
    activeWorkspaceCount: 0,
    activeSessionCount: 0,
    lastActivityAt: null,
    taskCountsByStatus: {},
    linkedWorkspaces: 0,
  },
};

function profile(id: string, name: string, agentType: string, model: string | null = null) {
  return {
    id,
    name,
    agentType,
    model,
    projectId: PROJECT_ID,
    userId: USER_ID,
    description: null,
    effort: 'auto',
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    resourceRequirementsJson: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: 'full',
    runtime: null,
    devcontainerConfigName: null,
    taskMode: 'task',
    githubCliPolicy: null,
    isBuiltin: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  };
}

const PROFILES = [
  profile('p-build', 'Opus 5.5 Build', 'claude-code', 'claude-opus-5-5'),
  profile('p-chat', 'Sonnet 5.5 Chat', 'claude-code', 'claude-sonnet-5-5'),
  profile('p-codex', 'Codex Build', 'openai-codex'),
];

const ROWS = mergeRows(
  accountRows({
    id: 'personal',
    name: 'Personal Max',
    kind: 'agent',
    target: 'claude-code',
    credentialKind: 'oauth-token',
    isDefault: true,
  }),
  accountRows({
    id: 'work',
    name: 'Work Pro',
    kind: 'agent',
    target: 'openai-codex',
    credentialKind: 'oauth-token',
    isDefault: true,
  })
);

function limitWindow(
  windowType: string,
  used: number,
  level: CredentialLimitLevel,
  resetsInMs: number,
  now: number
): CredentialLimitWindowSummary {
  return {
    windowType,
    provider: windowType.startsWith('claude') ? 'anthropic' : 'openai',
    source: 'mock',
    status: level === 'rejected' ? 'rejected' : level === 'ok' ? 'allowed' : 'allowed_warning',
    level,
    utilizationPercent: used,
    limitAmount: null,
    remainingAmount: null,
    windowMinutes: windowType.endsWith('five_hour') ? 300 : 10080,
    resetsAt: now + resetsInMs,
    observedAt: now - 2 * MIN,
    updatedAt: now - 2 * MIN,
  };
}

function usage(
  credentialId: string,
  agentType: string,
  windows: CredentialLimitWindowSummary[]
): CredentialLimitCredentialSummary {
  return {
    credentialReference: `cc_credentials:${credentialId}`,
    credentialId,
    credentialName: null,
    credentialSource: 'user',
    provider: windows[0]?.provider ?? 'anthropic',
    providerMode: 'oauth',
    agentType,
    level: 'ok',
    observedAt: NOW - 2 * MIN,
    windows,
  };
}

type Budget = 'healthy' | 'normal' | 'stressed';

function limits(kind: Budget, now: number) {
  const claude =
    kind === 'stressed'
      ? [
          limitWindow('claude.five_hour', 40, 'ok', 2 * HOUR, now),
          limitWindow('claude.seven_day', 94, 'critical', 52 * HOUR, now),
        ]
      : kind === 'normal'
        ? [
            limitWindow('claude.five_hour', 62, 'warning', 80 * MIN + 30_000, now),
            limitWindow('claude.seven_day', 31, 'ok', 96 * HOUR, now),
          ]
        : [
            limitWindow('claude.five_hour', 12, 'ok', 3 * HOUR, now),
            limitWindow('claude.seven_day', 20, 'ok', 96 * HOUR, now),
          ];
  return [
    usage('cred-personal', 'claude-code', claude),
    usage('cred-work', 'openai-codex', [
      limitWindow('codex.primary', 20, 'ok', 3 * HOUR, now),
      limitWindow('codex.secondary', 30, 'ok', 90 * HOUR, now),
    ]),
  ];
}

function chat(index: number, overrides: Partial<OverviewRunningChat> = {}): OverviewRunningChat {
  return {
    sessionId: `sess-${index}`,
    taskId: `task-${index}`,
    topic: `Running task ${index + 1}`,
    state: 'working',
    waitingOnViewer: false,
    startedAt: NOW - (index + 1) * 17 * MIN,
    lastActivityAt: NOW - index * MIN,
    profile: { id: 'p-build', name: 'Opus 5.5 Build' },
    createdByUserId: USER_ID,
    ...overrides,
  };
}

const NORMAL_RUNNING = [
  chat(0, {
    topic: 'Ship billing',
    state: 'waiting',
    waitingOnViewer: true,
    startedAt: NOW - HOUR,
  }),
  chat(1, { topic: 'Invoice PDF export', profile: { id: 'p-chat', name: 'Sonnet 5.5 Chat' } }),
  chat(2, {
    topic: 'Dunning emails for failed renewals',
    profile: { id: 'p-codex', name: 'Codex Build' },
  }),
  chat(3, { topic: 'Fix rounding in tax totals', state: 'starting', startedAt: NOW - MIN }),
  chat(4, { topic: 'Clean up staging', state: 'waiting', waitingOnViewer: false }),
];

const BUSY_RUNNING = Array.from({ length: 5 }, (_, index) =>
  chat(index, {
    topic:
      index === 0 ? LONG_TITLE : index === 1 ? LONG_TOKEN : `Parallel migration shard ${index}`,
    state: index === 2 ? 'waiting' : 'working',
    waitingOnViewer: index === 2,
    profile: {
      id: 'p-long',
      name:
        index === 1
          ? 'Overnight-Migration-Reviewer-With-An-Unbroken-Profile-Name-xxxxxxxxxxxxxxxxxxxxxxxx'
          : 'Opus 5.5 Build',
    },
  })
);

function idea(id: string, title: string, state: string, updatedAt: string, summary: string | null) {
  return {
    ideaId: id,
    title,
    summary,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt,
    derived: {
      state,
      needsYou: null,
      source: { origin: 'none', observedAt: null, stale: false },
      session: null,
      pullRequest: null,
      note: null,
    },
    counts: { updates: 2, chats: 1, files: 0, pullRequests: 0, atLeast: [] },
    filedByAgent: false,
    filedBy: null,
    viaConnector: null,
  };
}

function overviewBody(scene: 'normal' | 'busy' | 'quiet'): ProjectOverviewResponse {
  if (scene === 'quiet') {
    return {
      projectId: PROJECT_ID,
      running: { items: [], total: 0 },
      recent: { ideas: [], mergedPullRequests: [] },
      unavailable: [],
      generatedAt: new Date().toISOString(),
    };
  }
  const busy = scene === 'busy';
  return {
    projectId: PROJECT_ID,
    running: { items: busy ? BUSY_RUNNING : NORMAL_RUNNING, total: busy ? 12 : 5 },
    recent: {
      ideas: [
        idea(
          'idea-1',
          busy ? LONG_TITLE : 'Pause subscriptions',
          'not-started',
          '2026-11-16T00:00:00Z',
          'Let customers pause for up to three months.'
        ),
        idea('idea-2', 'EU VAT on checkout', 'not-started', '2026-11-15T12:00:00Z', null),
        idea(
          'idea-3',
          busy ? LONG_TOKEN : 'Retry failed webhooks',
          'not-started',
          '2026-11-15T00:00:00Z',
          'Backoff with jitter.'
        ),
      ] as never,
      mergedPullRequests: [
        {
          number: 2771,
          url: 'https://github.com/acme/billing/pull/2771',
          title: busy ? LONG_TITLE : 'Round tax totals per line',
          repository: 'acme/billing',
          mergedAt: new Date(NOW - 2 * HOUR).toISOString(),
        },
        {
          number: 2768,
          url: 'https://github.com/acme/billing/pull/2768',
          title: 'Dunning email templates',
          repository: 'acme/billing',
          mergedAt: new Date(NOW - 26 * HOUR).toISOString(),
        },
        {
          number: 2760,
          url: 'https://github.com/acme/billing/pull/2760',
          title: null,
          repository: 'acme/billing',
          mergedAt: null,
        },
      ],
    },
    unavailable: [],
    generatedAt: new Date().toISOString(),
  };
}

interface SceneOptions {
  scene: 'normal' | 'busy' | 'quiet';
  budget: Budget;
  /** Which automations exist: the normal set, two failing ones, or none. */
  automations: 'normal' | 'failing' | 'none';
  submit?: 'ok' | 'fail';
}

async function setupScene(page: Page, options: SceneOptions) {
  await page.addInitScript((id) => {
    localStorage.setItem(`sam-onboarding-wizard-dismissed-${id}`, 'true');
  }, USER_ID);
  const failingTriggers = [
    TRIGGERS.failing,
    { ...TRIGGERS.failing, id: 'trg-deps-2', name: `Weekly ${LONG_TOKEN}` },
  ];
  const triggers =
    options.automations === 'none'
      ? []
      : options.automations === 'failing'
        ? [...Object.values(TRIGGERS).filter((t) => t.id !== 'trg-deps'), ...failingTriggers]
        : Object.values(TRIGGERS);
  const runs: Record<string, unknown[]> = { ...RUNS, 'trg-deps-2': RUNS['trg-deps'] ?? [] };
  let submitted = false;

  await page.route(/^https?:\/\/[^/]+\/api\//, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/cc/credentials') return respond(200, { credentials: ROWS.credentials });
    if (path === '/api/cc/configurations')
      return respond(200, { configurations: ROWS.configurations });
    if (path === '/api/cc/attachments') return respond(200, { attachments: ROWS.attachments });
    if (path === '/api/cc/profile-attachments') return respond(200, { attachments: [] });
    if (path === '/api/credentials/resolution-status') return respond(200, { consumers: [] });
    if (path === '/api/credentials/limits')
      return respond(200, {
        credentials: limits(options.budget, Date.now()),
        generatedAt: Date.now(),
      });
    if (path === '/api/credentials') return respond(200, []);
    if (path === '/api/trial-status')
      return respond(200, { available: false, hasInfraCredential: true });
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/agents')
      return respond(200, {
        agents: [
          { id: 'claude-code', name: 'Claude Code', configured: true, supportsAcp: true },
          { id: 'openai-codex', name: 'Codex', configured: true, supportsAcp: true },
        ],
      });
    if (path === '/api/projects')
      return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    const match = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (match) {
      const sub = match[2] ?? '';
      if (sub === '') return respond(200, MOCK_PROJECT);
      if (sub === '/overview') {
        const body = overviewBody(options.scene);
        if (submitted && options.submit === 'ok') {
          // The chat index has caught up with the new task.
          body.running.items = [
            chat(99, {
              sessionId: 'sess-new',
              topic: 'Add a pause subscription option to the customer portal',
              state: 'starting',
              startedAt: Date.now(),
            }),
            ...body.running.items,
          ].slice(0, 5);
          body.running.total += 1;
        }
        return respond(200, body);
      }
      if (sub === '/tasks/submit' && method === 'POST') {
        if (options.submit === 'fail')
          return respond(503, {
            error: 'PROVISIONING_UNAVAILABLE',
            message: 'The cloud account is at its server limit. Nothing ran.',
          });
        submitted = true;
        return respond(200, {
          taskId: 'task-new',
          sessionId: 'sess-new',
          branchName: 'sam/pause-subscription',
          status: 'queued',
        });
      }
      if (sub === '/agent-profiles') return respond(200, { items: PROFILES });
      if (sub === '/agent-profiles/picker')
        return respond(200, { usageWindowDays: 30, usage: [], hiddenProfileIds: [] });
      if (sub === '/skills') return respond(200, { items: [] });
      if (sub === '/cached-commands') return respond(200, { commands: [] });
      if (sub === '/members')
        return respond(200, {
          members: [
            {
              userId: USER_ID,
              name: 'Raph',
              email: 'raph@example.com',
              avatarUrl: null,
              role: 'owner',
              status: 'active',
              joinedAt: '2026-10-01T00:00:00Z',
            },
          ],
          inviteLinks: [],
          accessRequests: [],
        });
      if (sub === '/triggers') return respond(200, { triggers });
      const triggerRuns = sub.match(/^\/triggers\/([^/]+)\/executions/);
      if (triggerRuns)
        return respond(200, { executions: runs[triggerRuns[1] ?? ''] ?? [], nextCursor: null });
      if (sub === '/schedules')
        return respond(200, {
          schedules: options.automations === 'normal' ? SCHEDULES.slice(0, 1) : [],
          nextCursor: null,
        });
      if (sub === '/standing-watches') return respond(200, { watches: [], nextCursor: null });
      if (sub.startsWith('/sessions'))
        return respond(200, { sessions: [], total: 0, hasMore: false });
      return respond(200, {});
    }
    return respond(200, {});
  });
}

function onlyOn(names: string[]) {
  return ({ page: _page }: { page: Page }, testInfo: TestInfo) => {
    test.skip(!names.includes(testInfo.project.name), 'audited on a phone and desktop');
  };
}
test.beforeEach(onlyOn(['iPhone SE (375x667)', 'Desktop (1280x800)']));

const isPhone = (testInfo: TestInfo) => testInfo.project.name.startsWith('iPhone');

/** What the person sees first, then the whole page with every scroller grown to its content. */
async function capture(page: Page, name: string) {
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
  // The page root fits the viewport (rule 56): it is never sized by its own content.
  const rootWidth = await page
    .getByTestId('project-overview')
    .evaluate((el) => el.getBoundingClientRect().width);
  expect(rootWidth).toBeLessThanOrEqual(page.viewportSize()?.width ?? 0);
  await page.waitForTimeout(400);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}-first-screen-${page.viewportSize()?.width}x${page.viewportSize()?.height}.png`,
  });
  await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-testid="project-overview"]');
    if (!root) return;
    for (const el of [root, ...root.querySelectorAll<HTMLElement>('[data-testid^="overview-"]')]) {
      el.style.overflow = 'visible';
      el.style.maxHeight = 'none';
    }
    let node = root.parentElement;
    while (node) {
      node.style.overflow = 'visible';
      node.style.height = 'auto';
      node.style.maxHeight = 'none';
      node.style.flex = '0 0 auto';
      node = node.parentElement;
    }
    root.style.height = 'auto';
    root.style.flex = '0 0 auto';
  });
  await screenshot(page, name);
}

/** The pinned task box's bottom edge meets the bottom of the page's area (not dragged up). */
async function expectTaskBoxPinned(page: Page) {
  const box = await page.locator('[data-testid="project-overview"] > div').last().boundingBox();
  const root = await page.getByTestId('project-overview').boundingBox();
  expect(box && root).toBeTruthy();
  expect(Math.abs(box!.y + box!.height - (root!.y + root!.height))).toBeLessThanOrEqual(2);
}

test.describe('Project Overview', () => {
  test('normal project', async ({ page }) => {
    await setupScene(page, { scene: 'normal', budget: 'normal', automations: 'normal' });
    await page.goto(BASE);
    const running = page.getByRole('region', { name: 'Running now' });
    await expect(running.getByRole('link', { name: /Ship billing/ })).toBeVisible();
    await expect(running.getByText('Waiting on you')).toBeVisible();
    await expect(page.getByTestId('overview-budgets')).toBeVisible();
    await expect(page.getByTestId('overview-budget-exceptions')).toContainText('5-hour window');
    await expect(page.getByTestId('overview-automation-failing')).toBeVisible();
    await expect(page.getByTestId('overview-recent-ideas')).toBeVisible();
    await expectTaskBoxPinned(page);
    await capture(page, 'overview-normal');
  });

  test('busy project under stress', async ({ page }) => {
    await setupScene(page, { scene: 'busy', budget: 'stressed', automations: 'failing' });
    await page.goto(BASE);
    const running = page.getByRole('region', { name: 'Running now' });
    await expect(running.getByTestId('overview-running-row')).toHaveCount(5);
    await expect(running.getByRole('link', { name: '7 more running' })).toBeVisible();
    await expect(page.getByTestId('overview-budget-exceptions')).toContainText(
      'Weekly window · 6% left'
    );
    await expect(
      page.getByTestId('overview-automation-failing').getByTestId('automation-attention-line')
    ).toHaveCount(2);
    await expectTaskBoxPinned(page);
    await capture(page, 'overview-busy-stress');
  });

  test('quiet project', async ({ page }) => {
    await setupScene(page, { scene: 'quiet', budget: 'healthy', automations: 'none' });
    await page.goto(BASE);
    await expect(page.getByText('Nothing is running.')).toBeVisible();
    await expect(page.getByText('No ideas or merged pull requests yet.')).toBeVisible();
    await expect(page.getByText('No automations yet.')).toBeVisible();
    // Healthy accounts get rings and no words.
    await expect(page.getByTestId('overview-budgets')).toBeVisible();
    await expect(page.getByTestId('overview-budget-exceptions')).toHaveCount(0);
    await capture(page, 'overview-quiet');
  });

  test('sending a task keeps you on the page', async ({ page }, testInfo) => {
    await setupScene(page, {
      scene: 'normal',
      budget: 'normal',
      automations: 'normal',
      submit: 'ok',
    });
    await page.goto(BASE);
    await expect(page.getByRole('link', { name: /Ship billing/ })).toBeVisible();
    const box = page.getByPlaceholder('Start a task…');
    await box.click();
    // The phone composer unfolds the To row on focus.
    await expect(page.getByRole('button', { name: /^To / })).toBeVisible();
    await box.fill('Add a pause subscription option to the customer portal');
    await page.getByRole('button', { name: /send/i }).click();
    const receipt = page.getByTestId('overview-start-receipt');
    await expect(receipt).toContainText('Started: Add a pause subscription option');
    await expect(receipt.getByRole('link', { name: 'Open chat' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/chat/sess-new`
    );
    expect(new URL(page.url()).pathname).toBe(BASE);
    await expect(box).toHaveValue('');
    await expect(
      page.getByRole('region', { name: 'Running now' }).getByRole('link', {
        name: /Add a pause subscription option/,
      })
    ).toBeVisible();
    if (isPhone(testInfo)) await box.blur();
    await expectTaskBoxPinned(page);
    await capture(page, 'overview-after-send');
  });

  test('a failed start shows its error in the receipt line', async ({ page }) => {
    await setupScene(page, {
      scene: 'normal',
      budget: 'normal',
      automations: 'normal',
      submit: 'fail',
    });
    await page.goto(BASE);
    const box = page.getByPlaceholder('Start a task…');
    await box.click();
    await box.fill('Add a pause subscription option');
    await page.getByRole('button', { name: /send/i }).click();
    await expect(page.getByTestId('overview-start-receipt')).toContainText(
      'Couldn’t start: The cloud account is at its server limit'
    );
    await expect(box).toHaveValue('Add a pause subscription option');
    await capture(page, 'overview-start-failed');
  });

  test('phone composer is one row until used', async ({ page }, testInfo) => {
    test.skip(!isPhone(testInfo), 'the fold is phone-only');
    await setupScene(page, { scene: 'normal', budget: 'normal', automations: 'normal' });
    await page.goto(BASE);
    await expect(page.getByRole('link', { name: /Ship billing/ })).toBeVisible();
    // Liveness: the box is there; the To row is folded away.
    await expect(page.getByPlaceholder('Start a task…')).toBeVisible();
    await expect(page.getByRole('button', { name: /^To / })).toHaveCount(0);
    // One row: the idle box is a single text line (48px), not a wrapped placeholder.
    const height = await page
      .getByPlaceholder('Start a task…')
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThanOrEqual(50);
    await page.getByPlaceholder('Start a task…').click();
    await expect(page.getByRole('button', { name: /^To / })).toBeVisible();
    await capture(page, 'overview-composer-focused');
  });
});
