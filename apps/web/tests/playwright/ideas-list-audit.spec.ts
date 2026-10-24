/**
 * Visual audit of the Ideas list, on a phone and on a laptop.
 *
 * The data is chosen to break the layout rather than to look good: a bad day with more
 * attention cards than fit, a failure message longer than the card, a 220-character title, an
 * unbroken URL, HTML-looking text, emoji and a one-letter title. Overflow is asserted with
 * the blocking clipped-overflow walk, because this surface sits inside two
 * `overflow-x-hidden` wrappers where a document-level check cannot see a sheared edge
 * (rule 56).
 */
import { expect, type Page, test } from '@playwright/test';
import type { IdeaCounts, IdeaDerivedState } from '@simple-agent-manager/shared';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockProject,
  makeMockUser,
  screenshot as capture,
  setupAuditRoutes,
} from './audit-helpers';
import { expandScrollContainers } from './automation-audit-helpers';

const PROJECT_ID = 'proj-test-1';
const IDEAS_URL = `/projects/${PROJECT_ID}/ideas`;

const MOCK_USER = makeMockUser({
  userId: 'user-test-1',
  sessionId: 'session-test-1',
  email: 'test@example.com',
  name: 'Priya Natarajan',
  role: 'superadmin',
});

type DerivedState = IdeaDerivedState;

interface IdeaOverrides {
  ideaId: string;
  title: string;
  state?: DerivedState;
  summary?: string | null;
  note?: string | null;
  agentLabel?: string | null;
  sessionTopic?: string | null;
  prNumber?: number;
  counts?: Partial<IdeaCounts>;
  filedByAgent?: boolean;
  filedBy?: string | null;
  viaConnector?: string | null;
  checksState?: 'pending' | 'success' | 'failure' | 'neutral' | null;
}

const NEEDS_YOU: DerivedState[] = ['question', 'stuck', 'merged'];

function makeIdea(overrides: IdeaOverrides) {
  const state = overrides.state ?? 'not-started';
  const hasSession = ['working', 'question', 'stuck'].includes(state);
  const hasPr = ['review', 'merged', 'done'].includes(state);
  return {
    ideaId: overrides.ideaId,
    title: overrides.title,
    summary:
      overrides.summary === undefined
        ? 'What we want and what is out of scope.'
        : overrides.summary,
    createdAt: '2026-10-14T00:00:00Z',
    updatedAt: '2026-10-22T00:00:00Z',
    derived: {
      state,
      needsYou: NEEDS_YOU.includes(state) ? state : null,
      source: {
        origin: hasPr ? 'github' : hasSession ? 'chat' : 'none',
        observedAt: hasPr || hasSession ? '2026-10-23T11:58:00Z' : null,
        stale: false,
      },
      session: hasSession
        ? {
            sessionId: `sess-${overrides.ideaId}`,
            topic: overrides.sessionTopic ?? 'Building it',
            sessionStatus: state === 'working' ? 'active' : 'stopped',
            taskId: `task-${overrides.ideaId}`,
            taskStatus: state === 'stuck' ? 'failed' : 'in_progress',
            agentLabel: overrides.agentLabel ?? 'Opus 5.5',
            lastActivityAt: '2026-10-23T11:58:00Z',
          }
        : null,
      pullRequest: hasPr
        ? {
            url: `https://github.com/northwind/payments/pull/${overrides.prNumber ?? 482}`,
            number: overrides.prNumber ?? 482,
            // `source` comes from T2's PullRequestRef, which IdeaPullRequest extends.
            source: 'task_output',
            state: state === 'review' ? 'open' : 'merged',
            isDraft: false,
            title: 'Retry failed webhook deliveries',
            checksState: overrides.checksState === undefined ? 'success' : overrides.checksState,
            mergedAt: state === 'review' ? null : '2026-10-23T08:00:00Z',
            updatedAt: '2026-10-23T11:58:00Z',
            stale: false,
          }
        : null,
      note: overrides.note ?? null,
    },
    counts: {
      updates: 0,
      chats: 0,
      files: 0,
      pullRequests: 0,
      atLeast: [],
      ...(overrides.counts ?? {}),
    },
    filedByAgent: overrides.filedByAgent ?? false,
    filedBy: overrides.filedBy ?? null,
    viaConnector: overrides.viaConnector ?? null,
  };
}

const NORMAL_IDEAS = [
  makeIdea({
    ideaId: 'idea-webhooks',
    title: 'Retry failed webhook deliveries',
    state: 'question',
    note: 'Stripe gives up after 3 days. Should we match that, or cap at 5 attempts?',
    counts: { updates: 4, chats: 2, files: 1, pullRequests: 0 },
  }),
  makeIdea({
    ideaId: 'idea-backfill',
    title: 'Backfill the delivery index',
    state: 'stuck',
    note: 'pnpm test failed: 3 suites red in packages/api/tests/unit/delivery.',
    counts: { updates: 1, chats: 1, files: 0, pullRequests: 0 },
  }),
  makeIdea({
    ideaId: 'idea-ratelimit',
    title: 'Rate-limit the delivery log',
    state: 'merged',
    prNumber: 482,
    counts: { updates: 6, chats: 3, files: 1, pullRequests: 1 },
  }),
  makeIdea({
    ideaId: 'idea-dashboard',
    title: 'Show every attempt in the dashboard',
    state: 'working',
    sessionTopic: 'Wiring the delivery log',
    counts: { updates: 2, chats: 1, files: 0, pullRequests: 0 },
  }),
  makeIdea({
    ideaId: 'idea-replay',
    title: 'Let merchants replay a parked event',
    state: 'review',
    prNumber: 500,
    counts: { updates: 3, chats: 2, files: 0, pullRequests: 1 },
  }),
  makeIdea({
    ideaId: 'idea-signing',
    title: 'Rotate the webhook signing key without downtime',
    counts: { updates: 1, chats: 0, files: 0, pullRequests: 0 },
  }),
  makeIdea({
    ideaId: 'idea-idempotency',
    title: 'Idempotency keys on the replay endpoint',
    viaConnector: 'Claude',
  }),
  makeIdea({
    ideaId: 'idea-docs',
    title: 'Document the retry window',
    state: 'done',
    prNumber: 476,
    counts: { updates: 8, chats: 4, files: 2, pullRequests: 1 },
  }),
  makeIdea({
    ideaId: 'idea-parked',
    title: 'Move refunds onto the same retry path',
    state: 'parked',
    summary: 'Parked: the refunds service owns its own delivery.',
  }),
  makeIdea({
    ideaId: 'idea-incident',
    title: 'TypeError: cannot read properties of undefined in the delivery worker',
    filedByAgent: true,
    filedBy: 'incident',
  }),
];

/** A bad day: more attention cards than the page shows, each one verbose. */
const STRESS_IDEAS = [
  ...Array.from({ length: 4 }, (_, index) =>
    makeIdea({
      ideaId: `idea-stuck-${index}`,
      title:
        index === 0
          ? 'Backfill the delivery index for every merchant created before the 2024 migration, including the ones whose webhooks were disabled at the time, so the replay endpoint has something to replay'
          : `Stopped work ${index}`,
      state: 'stuck',
      // Each stopped run says something different, because that is the case the headline
      // exists for: three cards all reading "Work stopped" are indistinguishable until you
      // read the small text. The rest of the note stays long, to keep the clamping stressed.
      note:
        `${['pnpm test failed', 'The devcontainer never finished building', 'The agent ran out of time'][index % 3]}. ` +
        'The suite went red in packages/api/tests/unit/delivery/retry-schedule.test.ts because the fixture still assumes a five-attempt cap, and the assertion message is very long indeed so that it has to be clamped rather than allowed to push the page sideways. '.repeat(
          2
        ),
      counts: { updates: 2, chats: 1, files: 0, pullRequests: 0 },
    })
  ),
  makeIdea({
    ideaId: 'idea-long-title',
    title:
      'Retry failed webhook deliveries with exponential backoff over a three-day window, show every attempt in the dashboard delivery log, and park the event afterwards so a merchant can replay it by hand',
    counts: { updates: 12, chats: 7, files: 3, pullRequests: 2 },
  }),
  makeIdea({
    ideaId: 'idea-url',
    title:
      'https://northwind.example.com/dashboard/settings/webhooks/deliveries?merchant=01KHRJGANBBWGDY1NZ0KVF0D4J&status=failed&from=2026-10-01&to=2026-10-23',
    summary:
      'Linked from https://northwind.example.com/dashboard/settings/webhooks/deliveries/01KHRJGANBBWGDY1NZ0KVF0D4J/attempts/0000000000000000',
  }),
  makeIdea({
    ideaId: 'idea-html',
    title: 'Fix: special characters like <script>alert("xss")</script> & "quotes" and 日本語テスト',
    summary: 'Unicode: 🚀🎉💻 and entities: &amp; &lt; &gt;',
  }),
  makeIdea({ ideaId: 'idea-one-letter', title: 'A', summary: null }),
  makeIdea({
    ideaId: 'idea-unbroken',
    title: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(12),
    summary: '0123456789'.repeat(40),
  }),
  makeIdea({
    ideaId: 'idea-connector-long',
    title: 'Filed through a connector with a very long name',
    viaConnector: 'Claude Research 🧪 & planning '.repeat(6),
  }),
  // Counts the server could only establish a minimum for: a busy idea that hit the per-idea
  // link cap reads "50+ files", not "50 files".
  makeIdea({
    ideaId: 'idea-capped-counts',
    title: 'An idea with more linked work than one page can count',
    state: 'working',
    counts: {
      updates: 137,
      chats: 50,
      files: 50,
      pullRequests: 50,
      atLeast: ['chats', 'files', 'pullRequests'],
    },
  }),
  // A pull request whose checks are red, and one with no checks at all: the row says so
  // rather than implying a green build.
  makeIdea({
    ideaId: 'idea-checks-failed',
    title: 'Pull request with failing checks',
    state: 'review',
    prNumber: 601,
    checksState: 'failure',
    counts: { pullRequests: 1 },
  }),
  makeIdea({
    ideaId: 'idea-checks-none',
    title: 'Pull request with no checks reported',
    state: 'review',
    prNumber: 602,
    checksState: null,
    counts: { pullRequests: 1 },
  }),
  ...Array.from({ length: 24 }, (_, index) =>
    makeIdea({
      ideaId: `idea-many-${index}`,
      title: `Idea ${index + 1}: ${['Add a metric', 'Fix a flake', 'Tidy a module', 'Write a test', 'Update the docs'][index % 5]}`,
      state: (['not-started', 'working', 'review', 'done'] as const)[index % 4],
      prNumber: 400 + index,
      counts: { updates: index % 5, chats: index % 3, files: index % 2, pullRequests: index % 2 },
    })
  ),
];

async function setupIdeasMocks(page: Page, options: { items?: unknown[]; error?: boolean } = {}) {
  const items = options.items ?? NORMAL_IDEAS;
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);

  await setupAuditRoutes(page, (path, respond) => {
    if (path.startsWith('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/projects') return respond(200, { projects: [makeMockProject()] });
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path.startsWith('/api/notifications'))
      return respond(200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/github')) return respond(200, []);
    if (path === '/api/credentials') return respond(200, []);
    if (path.startsWith('/api/credentials/'))
      return respond(200, { consumers: [], credentials: [] });
    if (path.startsWith('/api/nodes')) return respond(200, { nodes: [] });

    const match = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (!match) return undefined;
    const sub = match[2] ?? '';
    if (sub === '') return respond(200, makeMockProject());
    if (sub === '/members') return respond(200, { members: [], accessRequests: [] });
    if (sub.startsWith('/agent-profiles')) return respond(200, { items: [] });
    if (sub.startsWith('/skills')) return respond(200, { items: [] });
    if (sub.startsWith('/sessions')) return respond(200, { sessions: [], total: 0 });
    if (sub.startsWith('/triggers')) return respond(200, { triggers: [] });
    if (sub === '/ideas') {
      if (options.error) return respond(500, { error: 'INTERNAL_ERROR', message: 'nope' });
      return respond(200, {
        items,
        truncated: false,
        totals: { open: items.length, done: 1, parked: 1 },
      });
    }
    return undefined;
  });
}

/**
 * The app scrolls inside its own containers rather than at the document, so a full-page
 * capture would only ever show the first screen. Let every scrolling ancestor grow to its
 * content first, so the image shows the whole page (policy 63006482).
 */
async function screenshot(page: Page, name: string) {
  await expandScrollContainers(page);
  await capture(page, name);
}

async function openIdeas(page: Page) {
  await page.goto(IDEAS_URL);
  await expect(page.getByRole('heading', { name: 'Ideas', level: 1 })).toBeVisible();
}

/**
 * Every check the rule set asks for on a surface, in one place: the page root must not be
 * sized by its own content, nothing may be clipped horizontally, and the document must not
 * scroll sideways.
 */
async function assertLayoutIsSound(page: Page) {
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
  const root = await page.getByTestId('automation-root').first().boundingBox();
  const viewportWidth = page.viewportSize()?.width ?? 0;
  expect(root).not.toBeNull();
  expect(
    root!.width,
    `Page root is ${root!.width}px inside a ${viewportWidth}px viewport`
  ).toBeLessThanOrEqual(viewportWidth);
}

test.describe('Ideas list — phone', () => {
  // Pinned so this block measures a phone whichever project runs it; the laptop block below
  // pins 1280x800 the same way.
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });

  test('opens on what needs you, with the fix as a button', async ({ page }) => {
    await setupIdeasMocks(page);
    await openIdeas(page);

    const needsYou = page.getByTestId('ideas-needs-you');
    await expect(needsYou).toBeVisible();
    await expect(needsYou.getByText('Work stopped')).toBeVisible();
    await expect(needsYou.getByRole('link', { name: 'Answer' })).toBeVisible();
    await expect(needsYou.getByRole('button', { name: 'Mark done' })).toBeVisible();

    // Needs you is above In progress, which is above Not started.
    const order = await page
      .getByRole('heading', { level: 2 })
      .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''));
    expect(order[0]).toContain('Needs you');

    await assertLayoutIsSound(page);
    await screenshot(page, 'ideas-list-phone');
  });

  test('a bad day folds the extra cards and clamps a long failure', async ({ page }) => {
    await setupIdeasMocks(page, { items: STRESS_IDEAS });
    await openIdeas(page);

    const needsYou = page.getByTestId('ideas-needs-you');
    await expect(needsYou.getByText('Work stopped')).toHaveCount(3);
    await expect(needsYou.getByRole('button', { name: /1 more need you/ })).toBeVisible();

    await assertLayoutIsSound(page);
    await screenshot(page, 'ideas-list-stress-phone');

    await needsYou.getByRole('button', { name: /1 more need you/ }).click();
    await expect(needsYou.getByText('Work stopped')).toHaveCount(4);
    await assertLayoutIsSound(page);
    await screenshot(page, 'ideas-list-stress-expanded-phone');
  });

  test('done and agent-filed ideas fold away at the bottom', async ({ page }) => {
    await setupIdeasMocks(page);
    await openIdeas(page);

    const filed = page.getByTestId('ideas-filed-by-agents');
    await expect(filed).toBeVisible();
    await expect(filed.getByText(/Filed by agents · 1/)).toBeVisible();
    await expect(page.getByTestId('ideas-done-recently')).toBeVisible();

    await filed.getByText(/Filed by agents · 1/).click();
    await expect(
      page.getByText('TypeError: cannot read properties of undefined in the delivery worker')
    ).toBeVisible();
    await assertLayoutIsSound(page);
    await screenshot(page, 'ideas-list-folded-open-phone');
  });

  test('an empty project invites you to file the first idea', async ({ page }) => {
    await setupIdeasMocks(page, { items: [] });
    await openIdeas(page);

    await expect(page.getByRole('heading', { name: 'No ideas yet' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'File your first idea' })).toBeVisible();
    await assertLayoutIsSound(page);
    await screenshot(page, 'ideas-list-empty-phone');
  });

  test('the New idea dialog fits a phone screen', async ({ page }) => {
    await setupIdeasMocks(page);
    await openIdeas(page);

    await page.getByRole('button', { name: 'New', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'New idea' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'File it' })).toBeDisabled();
    await page
      .getByRole('textbox', { name: /what do you want done/i })
      .fill('Retry failed webhook deliveries with a three-day window');
    await expect(page.getByRole('button', { name: 'File it' })).toBeEnabled();

    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'ideas-new-idea-dialog-phone');
  });

  test('a failed read offers a retry rather than an empty page', async ({ page }) => {
    await setupIdeasMocks(page, { error: true });
    await page.goto(IDEAS_URL);

    await expect(page.getByRole('alert')).toContainText('Could not load your ideas');
    await assertNoOverflow(page);
    await screenshot(page, 'ideas-list-error-phone');
  });

  test('every action in a Needs-you card is reachable with a thumb', async ({ page }) => {
    await setupIdeasMocks(page, { items: STRESS_IDEAS });
    await openIdeas(page);

    const controls = page
      .getByTestId('ideas-needs-you')
      .getByRole('link')
      .or(page.getByTestId('ideas-needs-you').getByRole('button'));
    const count = await controls.count();
    expect(count).toBeGreaterThan(3);
    for (let index = 0; index < count; index += 1) {
      const box = await controls.nth(index).boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height, `Control ${index} is ${box!.height}px tall`).toBeGreaterThanOrEqual(40);
    }
  });
});

test.describe('Ideas list — laptop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('uses the extra width for a side column that explains the states', async ({ page }) => {
    await setupIdeasMocks(page);
    await openIdeas(page);

    await expect(page.getByText('Ideas move on their own')).toBeVisible();
    await expect(page.getByRole('heading', { name: /Done recently/ })).toBeVisible();

    // The side column sits beside the main column, not under it. Addressed by its accessible
    // name, which is the string a screen reader announces — and must therefore be the string
    // on screen, not a second wording nobody can see (WCAG 2.5.3).
    const main = await page.getByTestId('ideas-needs-you').boundingBox();
    const side = await page
      .getByRole('region', { name: 'Ideas move on their own' })
      .first()
      .boundingBox();
    expect(main).not.toBeNull();
    expect(side).not.toBeNull();
    expect(side!.x).toBeGreaterThan(main!.x + main!.width - 1);

    await assertLayoutIsSound(page);
    await screenshot(page, 'ideas-list-desktop');
  });

  test('holds up under stress data', async ({ page }) => {
    await setupIdeasMocks(page, { items: STRESS_IDEAS });
    await openIdeas(page);

    await assertLayoutIsSound(page);
    await screenshot(page, 'ideas-list-stress-desktop');
  });

  test('the New idea dialog stays inside the viewport', async ({ page }) => {
    await setupIdeasMocks(page);
    await openIdeas(page);

    await page.getByRole('button', { name: 'New idea' }).click();
    await expect(page.getByRole('heading', { name: 'New idea' })).toBeVisible();
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'ideas-new-idea-dialog-desktop');
  });

  test('an empty project reads well with the extra width', async ({ page }) => {
    await setupIdeasMocks(page, { items: [] });
    await openIdeas(page);

    await expect(page.getByRole('heading', { name: 'No ideas yet' })).toBeVisible();
    await assertLayoutIsSound(page);
    await screenshot(page, 'ideas-list-empty-desktop');
  });
});
