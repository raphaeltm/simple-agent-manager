/**
 * Visual and layout audit for the Project Overview (Inbox slice F1) at 375×667 and 1280×800.
 *
 * Every read is served the way the API answers it, so the real models decide what shows:
 * the aggregated overview read (Running now, Recently), the account model behind the usage
 * rings (Budgets), and the Automation page's model (Automations). Scenes: a normal project, a
 * busy one under stress (12 running, an account at 6% of its week, two failing automations,
 * very long titles and names), an empty quiet project, a sent task (receipt, new row, no
 * navigation), a failed start, and the phone composer unfolded on focus.
 *
 * Inbox slice F2: the Overview is the landing page and Needs you is its first section, fed by
 * the inbox routes (`/api/projects/:id/inbox`, `/count`, item reads and answers). Scenes add
 * 40 open items with long titles, a stack from one chat, an expiring permission and a failed
 * start; nothing needs you; and a brand-new empty project.
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
import { docsShot } from './docs-shot';
import { KIND_ITEMS, MANY_ITEMS } from './inbox-fixtures';
import { makeFlow } from './insights-fixtures';

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
  email: 'dana@example.com',
  name: 'Dana Reyes',
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
      running: { items: [], total: 0, waitingOnViewerTotal: 0 },
      recent: { ideas: [], mergedPullRequests: [] },
      unavailable: [],
      generatedAt: new Date().toISOString(),
    };
  }
  const busy = scene === 'busy';
  return {
    projectId: PROJECT_ID,
    running: {
      items: busy ? BUSY_RUNNING : NORMAL_RUNNING,
      total: busy ? 12 : 5,
      // Busy: three chats wait on you; one fits in the five rows, two are past the cap.
      waitingOnViewerTotal: busy ? 3 : 1,
    },
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

type InboxFixture = Record<string, unknown> & { ref: string };

/** Inbox items for this project: the fixtures' items, all moved into the audited project. */
function projectItems(items: InboxFixture[]): InboxFixture[] {
  return items.map((item) => ({
    ...item,
    projectId: PROJECT_ID,
    projectName: 'Acme Billing',
    // The three-item stack is the "Ship billing" chat, which Running now lists as paused.
    ...(item.stackKey === 'stack-ship' ? { sessionId: 'sess-0' } : {}),
  }));
}

/** A few items for a normal day: the expiring permission, the approval, a stack of three. */
const NORMAL_INBOX = projectItems(KIND_ITEMS.slice(0, 5) as InboxFixture[]);
/** 40 open items: every kind, a three-item stack, a failed start, long titles, fillers. */
const STRESS_INBOX = projectItems(MANY_ITEMS as InboxFixture[]);
/** Two questions from one chat and a review: answerable without any secondary read. */
const ROUND_TRIP_INBOX = projectItems(
  KIND_ITEMS.filter((item) =>
    ['ask:q-vat', 'ask:q-regions', 'ask:review-1'].includes(item.ref)
  ) as InboxFixture[]
);
/** A start that failed (slice E's `error` item with Retry) first, then a normal day. */
const FAILED_START_INBOX = [
  ...projectItems(KIND_ITEMS.filter((item) => item.kind === 'error') as InboxFixture[]),
  ...NORMAL_INBOX,
];

interface SceneOptions {
  scene: 'normal' | 'busy' | 'quiet';
  /** This project's open inbox items for the viewer (Needs you). Default: none. */
  inbox?: InboxFixture[];
  /** A brand-new project: no profiles, accounts, automations or items. */
  brandNew?: boolean;
  budget: Budget;
  /** Which automations exist: the normal set, two failing ones, or none. */
  automations: 'normal' | 'failing' | 'none';
  submit?: 'ok' | 'fail' | 'reauth';
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
  const answered = new Set<string>();
  const openItems = () => (options.inbox ?? []).filter((item) => !answered.has(item.ref));

  await page.route(/^https?:\/\/[^/]+\/api\//, async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/cc/credentials')
      return respond(200, { credentials: options.brandNew ? [] : ROWS.credentials });
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
    const inbox = path.match(/^\/api(?:\/projects\/[^/]+)?\/inbox(\/count)?$/);
    if (inbox && method === 'GET') {
      const items = openItems();
      if (inbox[1])
        return respond(200, {
          needsYou: items.length,
          blocking: items.filter((item) => item.blocking).length,
        });
      return respond(200, { items, nextCursor: null, skipped: 0 });
    }
    const inboxItem = path.match(/^\/api\/projects\/[^/]+\/inbox\/items\/([^/]+)(\/answer)?$/);
    if (inboxItem) {
      const ref = decodeURIComponent(inboxItem[1] ?? '');
      const item = (options.inbox ?? []).find((candidate) => candidate.ref === ref);
      if (!item) return respond(404, { error: 'NOT_FOUND', message: 'Inbox item not found' });
      if (inboxItem[2]) {
        answered.add(ref);
        return respond(200, { ref, outcome: 'answered', agentNotified: true });
      }
      return respond(200, {
        item: answered.has(ref) ? { ...item, status: 'answered' } : item,
        context: { before: [], since: { messages: [], activityCount: 0, truncated: false } },
      });
    }
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
        if (options.submit === 'reauth')
          return respond(401, {
            error: 'GITHUB_REAUTH_REQUIRED',
            message: 'Your GitHub authorization has expired — please sign out and back in',
          });
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
      if (sub === '/insights/flow')
        return respond(
          200,
          makeFlow(
            PROJECT_ID,
            '7d',
            options.scene === 'quiet' ? 'empty' : options.scene === 'busy' ? 'stress' : 'realistic'
          )
        );
      if (sub === '/agent-profiles')
        return respond(200, { items: options.brandNew ? [] : PROFILES });
      if (sub === '/agent-profiles/picker')
        return respond(200, { usageWindowDays: 30, usage: [], hiddenProfileIds: [] });
      if (sub === '/skills') return respond(200, { items: [] });
      if (sub === '/cached-commands') return respond(200, { commands: [] });
      if (sub === '/members')
        return respond(200, {
          members: [
            {
              userId: USER_ID,
              name: 'Dana Reyes',
              email: 'dana@example.com',
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
  test('normal project', async ({ page }, testInfo) => {
    await setupScene(page, {
      scene: 'normal',
      budget: 'normal',
      automations: 'normal',
      inbox: NORMAL_INBOX,
    });
    await page.goto(BASE);
    const running = page.getByRole('region', { name: 'Running now' });
    await expect(running.getByRole('link', { name: /Ship billing/ })).toBeVisible();
    // The inbox's own phrase: its item is in Needs you.
    await expect(running.getByText('Paused on this')).toBeVisible();
    await expect(page.getByTestId('overview-budgets')).toBeVisible();
    await expect(page.getByTestId('overview-budget-exceptions')).toContainText('5-hour window');
    await expect(page.getByTestId('overview-automation-failing')).toBeVisible();
    await expect(page.getByTestId('overview-recent-ideas')).toBeVisible();
    const week = page.getByRole('region', { name: 'This week' });
    await expect(week).toContainText('Merged');
    await expect(week).toContainText('28');
    await expect(week).toContainText('1.6d');
    await expect(week).toContainText('64%');
    await expect(page.getByTestId('overview-this-week-blocker')).toContainText(
      'Flaky check: apps/api › snapshot-retry.test.ts'
    );
    await expect(week.getByRole('link', { name: /Insights/ })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/insights/flow?range=7d`
    );
    await expectTaskBoxPinned(page);
    // Docs image (project-overview.md): the first screen, before capture() grows the scrollers.
    await docsShot(page, isPhone(testInfo) ? 'project-overview-mobile' : 'project-overview');
    await capture(page, 'overview-normal');
  });

  test('busy project under stress', async ({ page }) => {
    await setupScene(page, {
      scene: 'busy',
      budget: 'stressed',
      automations: 'failing',
      inbox: STRESS_INBOX,
    });
    await page.goto(BASE);
    const running = page.getByRole('region', { name: 'Running now' });
    await expect(running.getByTestId('overview-running-row')).toHaveCount(5);
    await expect(
      running.getByRole('link', { name: /7 more running\s?· 2 waiting on you/ })
    ).toBeVisible();
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
    await expect(page.getByTestId('overview-this-week-blocker')).toContainText(
      'Nothing stopped runs this week.'
    );
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
      inbox: NORMAL_INBOX,
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
    if (isPhone(testInfo)) {
      // A completed send folds the phone box back to one row.
      await expect(page.getByRole('button', { name: /^To / })).toHaveCount(0);
      const height = await box.evaluate((el) => el.getBoundingClientRect().height);
      expect(height).toBeLessThanOrEqual(50);
    }
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

  test('a GitHub sign-in prompt is opaque over the task box', async ({ page }) => {
    await setupScene(page, {
      scene: 'normal',
      budget: 'normal',
      automations: 'normal',
      submit: 'reauth',
    });
    await page.goto(BASE);
    const box = page.getByPlaceholder('Start a task…');
    await box.click();
    await box.fill('Add a pause subscription option');
    await page.getByRole('button', { name: /send/i }).click();
    await expect(page.getByTestId('overview-start-receipt')).toContainText(
      'Couldn’t start: Your GitHub authorization has expired'
    );
    // The app-wide prompt sits over the bottom of every page, so it must hide what is under
    // it: its own background is painted, not transparent.
    const prompt = page.getByRole('alert').filter({ hasText: 'GitHub sign-in required' });
    await expect(prompt.getByRole('button', { name: 'Sign out and reconnect' })).toBeVisible();
    const background = await prompt.evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.backgroundColor, image: style.backgroundImage };
    });
    expect(
      background.color !== 'rgba(0, 0, 0, 0)' || background.image !== 'none',
      `prompt background ${JSON.stringify(background)}`
    ).toBe(true);
    await capture(page, 'overview-github-reauth');
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

/** The rows of Needs you, once the list (not the quiet "checking" line) has rendered. */
async function needsYouRows(page: Page) {
  await expect(page.getByTestId('overview-needs-you-list')).toBeVisible();
  return page.getByTestId('overview-needs-you-list').getByTestId('inbox-row');
}

test.describe('Project Overview as the landing page, with Needs you (slice F2)', () => {
  test('opening a project lands on the Overview, Needs you first', async ({ page }, testInfo) => {
    await setupScene(page, {
      scene: 'normal',
      budget: 'normal',
      automations: 'normal',
      inbox: NORMAL_INBOX,
    });
    await page.goto(`/projects/${PROJECT_ID}`);
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/overview$`));
    const rows = await needsYouRows(page);
    // Five items, one a stack of three: three rows on either size.
    await expect(rows).toHaveCount(3);
    await expect(
      page.getByRole('region', { name: 'Needs you' }).getByRole('link', { name: /All 5/ })
    ).toHaveAttribute('href', `/projects/${PROJECT_ID}/inbox`);
    if (isPhone(testInfo)) {
      // Needs you comes before Running now in the phone column.
      const needs = await page.getByRole('region', { name: 'Needs you' }).boundingBox();
      const running = await page.getByRole('region', { name: 'Running now' }).boundingBox();
      expect(needs!.y).toBeLessThan(running!.y);
    } else {
      // Desktop: Needs you in the main column, Running now in the rail to its right.
      const needs = await page.getByRole('region', { name: 'Needs you' }).boundingBox();
      const running = await page.getByRole('region', { name: 'Running now' }).boundingBox();
      expect(needs!.x + needs!.width).toBeLessThanOrEqual(running!.x);
    }
    // Settled, not bounced: still on the Overview after the page has finished loading.
    await page.waitForTimeout(600);
    expect(new URL(page.url()).pathname).toBe(BASE);
    await expect(page.getByRole('region', { name: 'Running now' })).toBeVisible();
    await expect(page.getByPlaceholder('Start a task…')).toBeVisible();
  });

  test('40 open items: the first screen shows Needs you and the start of Running now', async ({
    page,
  }, testInfo) => {
    await setupScene(page, {
      scene: 'busy',
      budget: 'stressed',
      automations: 'failing',
      inbox: STRESS_INBOX,
    });
    await page.goto(BASE);
    const rows = await needsYouRows(page);
    await expect(rows).toHaveCount(isPhone(testInfo) ? 3 : 5);
    await expect(
      page.getByRole('region', { name: 'Needs you' }).getByRole('link', { name: /All 40/ })
    ).toBeVisible();
    // The stack from one chat reads as one row.
    await expect(page.getByText(/3 from Ship billing/)).toBeVisible();
    if (isPhone(testInfo)) {
      // 375x667: three rows and the Running now heading above the pinned task box, and no
      // title-only strip above Needs you.
      const box = await page.locator('[data-testid="project-overview"] > div').last().boundingBox();
      for (let i = 0; i < 3; i += 1) {
        const row = await rows.nth(i).boundingBox();
        expect(row!.y + row!.height).toBeLessThanOrEqual(box!.y);
      }
      const runningHead = await page
        .getByRole('region', { name: 'Running now' })
        .getByRole('heading', { name: /Running now/ })
        .boundingBox();
      expect(runningHead!.y + runningHead!.height).toBeLessThanOrEqual(box!.y);
      const needs = await page.getByRole('region', { name: 'Needs you' }).boundingBox();
      const appBar = await page.locator('header').first().boundingBox();
      expect(needs!.y - (appBar!.y + appBar!.height)).toBeLessThanOrEqual(16);
    }
    await expectTaskBoxPinned(page);
    await capture(page, 'overview-f2-stress-40-items');
  });

  test('a failed start waits in Needs you with its Retry', async ({ page }) => {
    await setupScene(page, {
      scene: 'normal',
      budget: 'normal',
      automations: 'normal',
      inbox: FAILED_START_INBOX,
    });
    await page.goto(BASE);
    const rows = await needsYouRows(page);
    await expect(rows.first()).toContainText('Couldn’t start');
    await expect(rows.first()).toContainText('never started');
    await capture(page, 'overview-f2-failed-start-item');
    await rows.first().getByRole('button').click();
    await expect(page).toHaveURL(/from=overview/);
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('nothing needs you: one quiet line', async ({ page }) => {
    await setupScene(page, { scene: 'normal', budget: 'normal', automations: 'normal', inbox: [] });
    await page.goto(BASE);
    const quiet = page.getByTestId('overview-needs-you-quiet');
    await expect(quiet).toContainText('Nothing needs you.');
    const height = (await quiet.boundingBox())!.height;
    expect(height).toBeLessThanOrEqual(56);
    // Liveness: the rest of the page is there.
    await expect(page.getByRole('region', { name: 'Running now' })).toBeVisible();
    await capture(page, 'overview-f2-nothing-needs-you');
  });

  test('a brand-new empty project', async ({ page }) => {
    await setupScene(page, {
      scene: 'quiet',
      budget: 'healthy',
      automations: 'none',
      inbox: [],
      brandNew: true,
    });
    await page.goto(`/projects/${PROJECT_ID}`);
    await expect(page).toHaveURL(new RegExp(`/overview$`));
    await expect(page.getByTestId('overview-needs-you-quiet')).toContainText('Nothing needs you.');
    await expect(page.getByText('Nothing is running.')).toBeVisible();
    await expectTaskBoxPinned(page);
    await capture(page, 'overview-f2-brand-new');
  });

  test('answer from Needs you, then back: the count is lower and the page did not reload', async ({
    page,
  }, testInfo) => {
    await setupScene(page, {
      scene: 'normal',
      budget: 'normal',
      automations: 'normal',
      inbox: ROUND_TRIP_INBOX,
    });
    await page.goto(BASE);
    await needsYouRows(page);
    await expect(
      page.getByRole('region', { name: 'Needs you' }).getByRole('link', { name: /All 3/ })
    ).toBeVisible();
    // A marker survives only if the page is not reloaded.
    await page.evaluate(() => {
      (window as unknown as { __noReload: boolean }).__noReload = true;
    });
    await page.getByRole('button', { name: /Should EU prices include VAT/ }).click();
    await expect(page).toHaveURL(/\/inbox\?/);
    await expect(page).toHaveURL(/from=overview/);
    const pane = page.getByRole('region', { name: 'Inbox item' });
    await expect(
      pane.getByRole('heading', { name: 'Should EU prices include VAT?' })
    ).toBeVisible();
    await screenshot(page, 'overview-f2-item-from-overview');
    await pane.getByRole('button', { name: 'Include VAT' }).click();
    await expect(page.getByTestId('inbox-receipt')).toContainText('Include VAT');
    // Straight to the next item in the stack.
    await expect(
      pane.getByRole('heading', { name: 'Which region should new staging nodes default to?' })
    ).toBeVisible();
    await screenshot(page, 'overview-f2-after-answer-receipt');
    const back = isPhone(testInfo)
      ? pane.getByRole('button', { name: 'Back to Overview' })
      : page.getByRole('button', { name: 'Back to Overview' }).first();
    await back.click();
    await expect(page).toHaveURL(new RegExp(`${BASE}$`));
    // Back popped the Overview's own entry rather than pushing a second one.
    expect(await page.evaluate(() => (history.state as { idx?: number } | null)?.idx)).toBe(0);
    await expect(
      page.getByRole('region', { name: 'Needs you' }).getByRole('link', { name: /All 2/ })
    ).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)
    ).toBe(true);
    await capture(page, 'overview-f2-back-count-reduced');
  });

  test('chat is one tap away', async ({ page }, testInfo) => {
    await setupScene(page, { scene: 'normal', budget: 'normal', automations: 'normal', inbox: [] });
    await page.goto(BASE);
    await expect(page.getByTestId('overview-needs-you-quiet')).toBeVisible();
    if (isPhone(testInfo)) {
      await page
        .locator('header')
        .first()
        .getByRole('button', { name: 'Chat', exact: true })
        .click();
    } else {
      await page.getByRole('link', { name: 'Chat', exact: true }).first().click();
    }
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/chat`));
  });

  test('desktop: after opening a second row, Back still goes to the Overview', async ({
    page,
  }, testInfo) => {
    test.skip(isPhone(testInfo), 'the list sits beside the item on desktop only');
    await setupScene(page, {
      scene: 'normal',
      budget: 'normal',
      automations: 'normal',
      inbox: ROUND_TRIP_INBOX,
    });
    await page.goto(BASE);
    await needsYouRows(page);
    await page.getByRole('button', { name: /Should EU prices include VAT/ }).click();
    const pane = page.getByRole('region', { name: 'Inbox item' });
    await expect(
      pane.getByRole('heading', { name: 'Should EU prices include VAT?' })
    ).toBeVisible();
    await page
      .getByRole('region', { name: 'Inbox list' })
      .getByRole('button', { name: /Please check the new pricing page/ })
      .click();
    await expect(
      pane.getByRole('heading', { name: 'Please check the new pricing page before I open the PR' })
    ).toBeVisible();
    await page.getByRole('button', { name: 'Back to Overview' }).first().click();
    await expect(page).toHaveURL(new RegExp(`${BASE}$`));
    await expect(page.getByTestId('overview-needs-you-list')).toBeVisible();
  });
});

/**
 * Every clipping box between a pane and the void: the pane must sit inside it with room for its
 * shadow on both sides and below. Measured in page coordinates (rule 17), at the top of every
 * scroller and again scrolled to the end, where the last pane's bottom shadow matters.
 */
async function expectPaneShadowsUnclipped(page: Page, room: number) {
  const cuts = await page.evaluate((min) => {
    const root = document.querySelector('[data-testid="project-overview"]');
    const found: string[] = [];
    for (const pane of root?.querySelectorAll<HTMLElement>('section.sam-glass') ?? []) {
      const box = pane.getBoundingClientRect();
      for (
        let node = pane.parentElement;
        node && node !== document.body;
        node = node.parentElement
      ) {
        const style = getComputedStyle(node);
        if (style.display === 'contents') continue;
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const clip = node.getBoundingClientRect();
        // Edges a pane is scrolled past are not checked: only a pane in full view must clear them.
        const inView = box.top >= clip.top && box.bottom <= clip.bottom;
        const label = `${pane.getAttribute('aria-label')} in ${node.dataset.testid ?? node.tagName}`;
        // The screen edge is the last clip: a pane may meet it like any other page edge.
        if (node === document.documentElement) continue;
        if (box.left - clip.left < min) found.push(`${label}: left ${box.left - clip.left}`);
        if (clip.right - box.right < min) found.push(`${label}: right ${clip.right - box.right}`);
        if (inView && clip.bottom - box.bottom < min)
          found.push(`${label}: bottom ${clip.bottom - box.bottom}`);
      }
    }
    return found;
  }, room);
  expect(cuts, 'a scroller cuts a pane shadow off at its edge').toEqual([]);
}

async function scrollOverviewToEnd(page: Page) {
  for (const id of ['overview-scroll', 'overview-main', 'overview-rail']) {
    await page.getByTestId(id).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
  }
  await page.waitForTimeout(200);
}

test.describe('Project Overview layering and spacing', () => {
  test('pane shadows are never cut off by a scroller', async ({ page }, testInfo) => {
    await setupScene(page, {
      scene: 'busy',
      budget: 'stressed',
      automations: 'failing',
      inbox: STRESS_INBOX,
    });
    await page.goto(BASE);
    await expect(page.getByRole('region', { name: 'Recently' })).toBeAttached();
    await expect(page.getByRole('region', { name: 'Needs you' })).toBeVisible();
    // Room for the shadow: the phone frame is 10px, the desktop gutter 14px.
    const room = isPhone(testInfo) ? 10 : 14;
    await expectPaneShadowsUnclipped(page, room);
    await scrollOverviewToEnd(page);
    await expectPaneShadowsUnclipped(page, room);
    // The bleed pads back what it takes: the first pane still starts a gap under the app bar
    // (phone) or at the frame (desktop), and the task box stays pinned.
    const first = await page.getByRole('region', { name: 'Needs you' }).boundingBox();
    if (isPhone(testInfo)) {
      const appBar = await page.locator('header').first().boundingBox();
      await page.getByTestId('overview-scroll').evaluate((el) => {
        el.scrollTop = 0;
      });
      const top = await page.getByRole('region', { name: 'Needs you' }).boundingBox();
      expect(top!.y - (appBar!.y + appBar!.height)).toBeGreaterThanOrEqual(8);
      expect(top!.x).toBeGreaterThanOrEqual(8);
      // Panes leave at real edges: the scroller meets the app bar and the task box.
      const scroller = await page.getByTestId('overview-scroll').boundingBox();
      const taskBox = await page
        .locator('[data-testid="project-overview"] > div')
        .last()
        .boundingBox();
      expect(Math.abs(scroller!.y - (appBar!.y + appBar!.height))).toBeLessThanOrEqual(1);
      expect(Math.abs(scroller!.y + scroller!.height - taskBox!.y)).toBeLessThanOrEqual(1);
    } else {
      expect(first!.y).toBeGreaterThanOrEqual(14);
      // The two columns' boxes overlap in the gutter; the main column's scrollbar lives there,
      // so the main column, not the rail, must own that strip.
      const owner = await page.getByTestId('overview-main').evaluate((el) => {
        const box = el.getBoundingClientRect();
        const hit = document.elementFromPoint(box.right - 3, box.top + box.height / 2);
        return hit?.closest('[data-testid^="overview-"]')?.getAttribute('data-testid');
      });
      expect(owner).toBe('overview-main');
    }
    await expectTaskBoxPinned(page);
    await assertNoOverflow(page);
    await page.screenshot({
      path: `../../.codex/tmp/playwright-screenshots/overview-layering-end-${page.viewportSize()?.width}.png`,
    });
  });

  for (const mode of ['focus', 'zen'] as const) {
    test(`desktop ${mode} mode: pane shadows are not cut off either`, async ({
      page,
    }, testInfo) => {
      test.skip(isPhone(testInfo), 'focus modes are desktop-only');
      await page.addInitScript((value) => {
        localStorage.setItem('sam:focus-mode', value);
      }, mode);
      await setupScene(page, {
        scene: 'busy',
        budget: 'stressed',
        automations: 'failing',
        inbox: STRESS_INBOX,
      });
      await page.goto(BASE);
      await expect(page.getByRole('region', { name: 'Needs you' })).toBeVisible();
      // Liveness: the mode really applied (Zen hides the nav; Focus narrows it).
      const needs = await page.getByRole('region', { name: 'Needs you' }).boundingBox();
      expect(needs!.x).toBeLessThan(mode === 'zen' ? 40 : 120);
      await expectPaneShadowsUnclipped(page, 14);
      await scrollOverviewToEnd(page);
      await expectPaneShadowsUnclipped(page, 14);
    });
  }

  test('light theme: pane shadows are not cut off either', async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('sam-theme', 'light');
    });
    await setupScene(page, {
      scene: 'busy',
      budget: 'stressed',
      automations: 'failing',
      inbox: STRESS_INBOX,
    });
    await page.goto(BASE);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute('data-ui-theme')))
      .toBe('sam-light');
    await expect(page.getByRole('region', { name: 'Needs you' })).toBeVisible();
    await expectPaneShadowsUnclipped(page, 10);
    await page.waitForTimeout(400);
    await page.screenshot({
      path: `../../.codex/tmp/playwright-screenshots/overview-layering-light-top-${page.viewportSize()?.width}.png`,
    });
    await scrollOverviewToEnd(page);
    await expectPaneShadowsUnclipped(page, 10);
    await page.screenshot({
      path: `../../.codex/tmp/playwright-screenshots/overview-layering-light-end-${page.viewportSize()?.width}.png`,
    });
  });

  test('a stacked Needs you row shows its back cards only below the front card', async ({
    page,
  }) => {
    await setupScene(page, {
      scene: 'busy',
      budget: 'stressed',
      automations: 'failing',
      inbox: STRESS_INBOX,
    });
    await page.goto(BASE);
    const stack = page.getByTestId('inbox-row').filter({ hasText: /3 from Ship billing/ });
    await expect(stack).toBeVisible();
    // Hit-testing honours clip-path: inside the front card, no back card may be under the point
    // (it would show through the translucent card); below it, each back card is still there.
    const result = await stack.evaluate((li) => {
      const front = li.querySelector<HTMLElement>(':scope > div')!.getBoundingClientRect();
      const backs = [...li.querySelectorAll<HTMLElement>(':scope > span[aria-hidden="true"]')];
      const inside = backs.flatMap((back) => {
        const box = back.getBoundingClientRect();
        const x = box.left + box.width / 2;
        return [front.bottom - 2, front.bottom - 6].map((y) =>
          document.elementsFromPoint(x, y).includes(back)
        );
      });
      const below = backs.map((back) => {
        const box = back.getBoundingClientRect();
        return document.elementsFromPoint(box.left + box.width / 2, box.bottom - 1).includes(back);
      });
      return { count: backs.length, inside, below };
    });
    expect(result.count).toBe(2);
    expect(result.inside.every((hit) => !hit)).toBe(true);
    expect(result.below).toEqual([true, true]);
  });

  test('Recently lines its ideas up with its pull requests', async ({ page }) => {
    await setupScene(page, { scene: 'normal', budget: 'normal', automations: 'normal' });
    await page.goto(BASE);
    const idea = page.getByTestId('overview-recent-idea').first();
    const pr = page.getByTestId('overview-merged-pr').first();
    await expect(idea).toContainText('Pause subscriptions');
    await expect(pr).toContainText('Round tax totals per line');
    const measure = (row: typeof idea) =>
      row.evaluate((el) => {
        const icon = el.querySelector('svg')!.getBoundingClientRect();
        const title = el.querySelector(':scope > span:nth-of-type(2)')!.getBoundingClientRect();
        return { icon: icon.left, title: title.left, row: el.getBoundingClientRect().left };
      });
    const ideaBox = await measure(idea);
    const prBox = await measure(pr);
    expect(Math.abs(ideaBox.row - prBox.row)).toBeLessThanOrEqual(1);
    expect(Math.abs(ideaBox.icon - prBox.icon)).toBeLessThanOrEqual(1);
    expect(Math.abs(ideaBox.title - prBox.title)).toBeLessThanOrEqual(1);
  });
});
