/**
 * Documentation screenshots for Ideas (the "Ideas" section of the Idea Execution guide): the
 * Ideas list, an idea's page, and the Start work sheet, on a desktop and a phone.
 *
 * Drives the REAL pages with mocked API data and asserts on what rendered before capturing,
 * so a page that stops rendering fails the capture instead of shipping a stale image
 * (`.claude/rules/62-tests-must-observe-the-real-trigger.md`). The stress cases (long titles,
 * markup, many items, failures) live in `ideas-list-audit.spec.ts` and `idea-page-audit.spec.ts`;
 * this fixture uses ordinary, fictional data, because it is what a reader compares their own
 * page against.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-ideas \
 *     --project="Desktop (1280x800)" --project="iPhone SE (375x667)"
 */
import { expect, type Page, test } from '@playwright/test';
import type { IdeaDerivedState } from '@simple-agent-manager/shared';

import { makeMockProject, makeMockUser, seedTheme, setupProjectAuditRoutes } from './audit-helpers';
import { expandScrollContainers } from './automation-audit-helpers';
import { docsShot, opaqueBackdrop } from './docs-shot';
import { ideaUpdate, linkedItems } from './idea-fixtures';

const PROJECT_ID = 'proj-docs-ideas';
const IDEA_ID = 'idea-webhook-retries';

const MOCK_USER = makeMockUser({
  userId: 'user-docs-ideas',
  sessionId: 'session-docs-ideas',
  email: 'dana@example.com',
  name: 'Dana Reyes',
  role: 'user',
});

const MOCK_PROJECT = makeMockProject({
  id: PROJECT_ID,
  name: 'acme/payments-api',
  repository: 'acme/payments-api',
  userId: MOCK_USER.user.id,
});

const NEEDS_YOU: IdeaDerivedState[] = ['question', 'stuck', 'merged'];

interface ListIdea {
  ideaId: string;
  title: string;
  state?: IdeaDerivedState;
  summary?: string;
  note?: string;
  sessionTopic?: string;
  agentLabel?: string;
  prNumber?: number;
  prTitle?: string;
  counts?: { updates?: number; chats?: number; files?: number; pullRequests?: number };
}

/** One row of `GET /api/projects/:id/ideas`, shaped like `ideas-list-audit.spec.ts` builds it. */
function listIdea(idea: ListIdea) {
  const state = idea.state ?? 'not-started';
  const hasSession = ['working', 'question', 'stuck'].includes(state);
  const hasPr = ['review', 'merged', 'done'].includes(state);
  return {
    ideaId: idea.ideaId,
    title: idea.title,
    summary: idea.summary ?? null,
    createdAt: '2026-10-14T09:00:00Z',
    updatedAt: '2026-10-23T11:58:00Z',
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
            sessionId: `sess-${idea.ideaId}`,
            topic: idea.sessionTopic ?? 'Building it',
            sessionStatus: state === 'working' ? 'active' : 'stopped',
            taskId: `task-${idea.ideaId}`,
            taskStatus: state === 'stuck' ? 'failed' : 'in_progress',
            agentLabel: idea.agentLabel ?? 'Careful Builder',
            lastActivityAt: '2026-10-23T11:58:00Z',
          }
        : null,
      pullRequest: hasPr
        ? {
            url: `https://github.com/acme/payments-api/pull/${idea.prNumber ?? 482}`,
            number: idea.prNumber ?? 482,
            source: 'task_output',
            state: state === 'review' ? 'open' : 'merged',
            isDraft: false,
            title: idea.prTitle ?? idea.title,
            checksState: 'success',
            mergedAt: state === 'review' ? null : '2026-10-23T08:00:00Z',
            updatedAt: '2026-10-23T11:58:00Z',
            stale: false,
          }
        : null,
      note: idea.note ?? null,
    },
    counts: {
      updates: 0,
      chats: 0,
      files: 0,
      pullRequests: 0,
      atLeast: [],
      ...(idea.counts ?? {}),
    },
    filedByAgent: false,
    filedBy: null,
    viaConnector: null,
  };
}

const IDEAS = [
  listIdea({
    ideaId: IDEA_ID,
    title: 'Retry failed webhook deliveries',
    state: 'question',
    note: 'Stripe gives up after 3 days. Should we match that, or cap retries at 5 attempts?',
    sessionTopic: 'Wiring the retry schedule',
    counts: { updates: 4, chats: 2, files: 1 },
  }),
  listIdea({
    ideaId: 'idea-backfill',
    title: 'Backfill the delivery index',
    state: 'stuck',
    note: 'pnpm test failed: 3 suites red in tests/unit/delivery.',
    sessionTopic: 'Backfilling the index',
    agentLabel: 'Codex Builder',
    counts: { updates: 1, chats: 1 },
  }),
  listIdea({
    ideaId: 'idea-ratelimit',
    title: 'Rate-limit the delivery log',
    state: 'merged',
    prNumber: 476,
    counts: { updates: 6, chats: 3, files: 1, pullRequests: 1 },
  }),
  listIdea({
    ideaId: 'idea-dashboard',
    title: 'Show every attempt in the dashboard',
    state: 'working',
    sessionTopic: 'Adding the delivery log view',
    counts: { updates: 2, chats: 1 },
  }),
  listIdea({
    ideaId: 'idea-replay',
    title: 'Let merchants replay a parked event',
    state: 'review',
    prNumber: 491,
    counts: { updates: 3, chats: 2, pullRequests: 1 },
  }),
  listIdea({
    ideaId: 'idea-signing',
    title: 'Rotate the webhook signing key without downtime',
    summary: 'Overlap old and new keys for a day so no merchant sees a failed signature.',
    counts: { updates: 1 },
  }),
  listIdea({
    ideaId: 'idea-idempotency',
    title: 'Idempotency keys on the replay endpoint',
    summary: 'Replaying the same event twice should not charge twice.',
  }),
  listIdea({
    ideaId: 'idea-docs',
    title: 'Document the retry window',
    state: 'done',
    prNumber: 470,
    counts: { updates: 5, chats: 2, files: 1, pullRequests: 1 },
  }),
];

const PLAN = `When a merchant's endpoint is down we drop the webhook after one failed attempt, so merchants miss \`charge.succeeded\` and ship orders late.

**What we want**

- Retry failed deliveries with exponential backoff for up to 3 days.
- Show every attempt in the dashboard's delivery log.
- After the last attempt, park the event so the merchant can replay it.

**Out of scope:** the refunds webhook path, which is a separate service.`;

const OPEN_PR = {
  url: 'https://github.com/acme/payments-api/pull/482',
  number: 482,
  state: 'open' as const,
  isDraft: false,
  title: 'Retry failed webhook deliveries with exponential backoff',
  checksState: 'success' as const,
  mergedAt: null,
  updatedAt: '2026-10-23T11:58:00Z',
  stale: false,
};

const IDEA_SESSIONS = [
  // Finished: a chat still working on the idea would outrank its open pull request, and the
  // page would say In progress instead of In review.
  {
    sessionId: 'sess-build',
    topic: 'Wiring the retry schedule',
    strong: true,
    sessionStatus: 'stopped',
    taskId: 'task-build',
    taskStatus: 'completed',
    taskErrorMessage: null,
    agentLabel: 'Careful Builder',
    lastActivityAt: Date.parse('2026-10-23T11:45:00Z'),
    needsInput: null,
  },
  {
    sessionId: 'sess-research',
    topic: 'Comparing how payment providers retry webhooks',
    strong: true,
    sessionStatus: 'stopped',
    taskId: 'task-research',
    taskStatus: 'completed',
    taskErrorMessage: null,
    agentLabel: 'Brainstormer',
    lastActivityAt: Date.parse('2026-10-18T09:00:00Z'),
    needsInput: null,
  },
];

/** `GET /api/projects/:id/ideas/:ideaId` for an idea whose pull request is open. */
const IDEA_IN_REVIEW = {
  ideaId: IDEA_ID,
  title: 'Retry failed webhook deliveries',
  content: PLAN,
  summary: 'Retry failed deliveries with exponential backoff for up to 3 days.',
  status: 'draft',
  createdAt: '2026-10-14T09:00:00Z',
  updatedAt: '2026-10-22T16:00:00Z',
  derived: {
    state: 'review',
    needsYou: null,
    source: { origin: 'github', observedAt: '2026-10-23T11:58:00Z', stale: false },
    // The server attaches no chat to In review (`idea-status.ts`), so there's no Open the chat.
    session: null,
    pullRequest: OPEN_PR,
    note: null,
  },
  counts: { updates: 3, chats: 2, files: 1, pullRequests: 1 },
  filedByAgent: false,
  filedBy: null,
  sessions: IDEA_SESSIONS,
  pullRequests: [OPEN_PR],
};

/** The same idea before anyone started work on it: what Start work opens from. */
const IDEA_NOT_STARTED = {
  ...IDEA_IN_REVIEW,
  derived: {
    state: 'not-started',
    needsYou: null,
    source: { origin: 'none', observedAt: null, stale: false },
    session: null,
    pullRequest: null,
    note: null,
  },
  counts: { updates: 1, chats: 0, files: 1, pullRequests: 0 },
  sessions: [],
  pullRequests: [],
};

const UPDATES = [
  ideaUpdate({
    id: 'u-agent',
    ideaId: IDEA_ID,
    authorKind: 'agent',
    authorName: 'Careful Builder',
    sessionId: 'sess-build',
    sessionTopic: 'Wiring the retry schedule',
    body: 'Opened #482. Retries now back off from 1 minute to 12 hours over 3 days; the delivery log shows each attempt.',
    createdAt: '2026-10-23T11:40:00Z',
  }),
  ideaUpdate({
    id: 'u-marcus',
    ideaId: IDEA_ID,
    authorKind: 'user',
    authorUserId: 'user-marcus',
    authorName: 'Marcus Chen',
    body: 'Match the 3-day window rather than a fixed number of attempts, so merchants see the same behaviour everywhere.',
    quote: 'Retry failed deliveries with exponential backoff for up to 3 days.',
    createdAt: '2026-10-21T10:00:00Z',
  }),
  ideaUpdate({
    id: 'u-research',
    ideaId: IDEA_ID,
    authorKind: 'agent',
    authorName: 'Brainstormer',
    sessionId: 'sess-research',
    sessionTopic: 'Comparing how payment providers retry webhooks',
    body: 'Compared three providers. Recommendation: exponential backoff over 3 days, then park the event for a manual replay. Details in retry-schedules.md.',
    createdAt: '2026-10-18T09:00:00Z',
  }),
];

const LINKS = {
  sessions: linkedItems([]),
  files: linkedItems([
    {
      fileId: 'file-retry-schedules',
      filename: 'retry-schedules.md',
      directory: '/research/webhooks/',
      relations: ['uploaded'],
      bySessionId: 'sess-research',
    },
  ]),
  pullRequests: linkedItems([]),
  relatedIdeas: linkedItems([
    {
      ideaId: 'idea-replay',
      title: 'Let merchants replay a parked event',
      status: 'draft',
      relations: ['related'],
    },
  ]),
};

/** Two profiles for Start work: one that does the work, one that talks it through. */
const PROFILES = [
  {
    id: 'profile-builder',
    projectId: PROJECT_ID,
    userId: MOCK_USER.user.id,
    name: 'Careful Builder',
    description: 'Plans, builds and tests, then opens a pull request',
    agentType: 'claude-code',
    model: null,
    workspaceProfile: 'full',
    runtime: 'vm',
    taskMode: 'task',
    isBuiltin: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  },
  {
    id: 'profile-brainstormer',
    projectId: PROJECT_ID,
    userId: MOCK_USER.user.id,
    name: 'Brainstormer',
    description: 'Talks an idea through before anyone builds it',
    agentType: 'claude-code',
    model: null,
    workspaceProfile: 'lightweight',
    runtime: 'cf-container',
    taskMode: 'conversation',
    isBuiltin: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  },
];

async function setupMocks(page: Page, idea: unknown = IDEA_IN_REVIEW) {
  await setupProjectAuditRoutes(page, {
    user: MOCK_USER,
    project: MOCK_PROJECT,
    onProjectSubPath: (sub, respond) => {
      if (sub === '/members') return respond(200, { members: [], accessRequests: [] });
      // The picker state must be matched before the list: both start with `/agent-profiles`.
      if (sub.startsWith('/agent-profiles/picker'))
        return respond(200, { hiddenProfileIds: [], usage: [], windowDays: 30 });
      if (sub.startsWith('/agent-profiles')) return respond(200, { items: PROFILES });
      if (sub.startsWith('/skills')) return respond(200, { items: [] });
      if (sub.startsWith('/sessions')) return respond(200, { sessions: [], total: 0 });
      if (sub.startsWith('/triggers')) return respond(200, { triggers: [] });
      if (sub === '/ideas')
        return respond(200, {
          items: IDEAS,
          truncated: false,
          totals: { open: IDEAS.length - 1, done: 1, parked: 0 },
        });
      if (sub === `/ideas/${IDEA_ID}/updates`)
        return respond(200, { updates: UPDATES, nextCursor: null });
      if (sub === `/ideas/${IDEA_ID}/links`) return respond(200, LINKS);
      if (sub === `/ideas/${IDEA_ID}`) return respond(200, idea);
      return undefined;
    },
  });
}

function isMobile(page: Page): boolean {
  return (page.viewportSize()?.width ?? 0) < 500;
}

/**
 * On a desktop the app scrolls inside its own containers, so let them grow and capture the
 * whole page. On a phone, capture the first screen only: a whole phone page is too tall to
 * read as a docs image.
 */
async function capturePage(page: Page, name: string) {
  await page.mouse.move(2, 2);
  if (isMobile(page)) {
    await docsShot(page, name);
    return;
  }
  await expandScrollContainers(page);
  await docsShot(page, name, page.getByTestId('automation-root').first());
}

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(Date.parse('2026-10-23T12:00:00Z'));
  await seedTheme(page, 'dark');
  // A modern phone's height, so the first screen shows a whole card or two.
  if (isMobile(page)) await page.setViewportSize({ width: 375, height: 812 });
});

test('docs: the Ideas list', async ({ page }) => {
  await setupMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/ideas`);
  await expect(page.getByRole('heading', { name: /Needs you/ })).toBeVisible({ timeout: 20000 });
  await expect(page.getByRole('heading', { name: /In progress/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Not started/ })).toBeVisible();
  await expect(page.getByText('Retry failed webhook deliveries').first()).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  if (isMobile(page)) {
    // Make the first screen tall enough to end below the third Needs you card's buttons.
    const keepOpen = (await page.getByRole('button', { name: 'Keep open' }).first().boundingBox())!;
    await page.setViewportSize({
      width: 375,
      height: Math.ceil(keepOpen.y + keepOpen.height + 40),
    });
  }
  await capturePage(page, isMobile(page) ? 'ideas-list-mobile' : 'ideas-list');
});

test("docs: an idea's page", async ({ page }) => {
  await setupMocks(page);
  await page.goto(`/projects/${PROJECT_ID}/ideas/${IDEA_ID}`);
  await expect(page.getByRole('heading', { name: 'The idea' })).toBeVisible({ timeout: 20000 });
  const status = page.getByRole('region', { name: 'Status' });
  await expect(status.getByText('In review')).toBeVisible();
  await expect(status.getByRole('link', { name: 'Review PR #482' })).toBeVisible();
  await expect(status.getByText('Open the chat')).toHaveCount(0);
  await expect(page.getByText('Opened #482.', { exact: false })).toBeVisible();
  await expect(page.getByText('retry-schedules.md').first()).toBeVisible();
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await capturePage(page, isMobile(page) ? 'idea-page-mobile' : 'idea-page');
});

test('docs: Start work on an idea', async ({ page }) => {
  await setupMocks(page, IDEA_NOT_STARTED);
  await page.goto(`/projects/${PROJECT_ID}/ideas/${IDEA_ID}`);
  await expect(page.getByRole('heading', { name: 'The idea' })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: 'Start work' }).click();
  const sheet = page.getByRole('dialog', { name: /Start work|Talk it through/i });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: /Who works on it/i })).toBeVisible();
  await expect(sheet.getByLabel('Note for the agent')).toBeVisible();
  await expect(sheet.getByText('Careful Builder').first()).toBeVisible();
  await page.mouse.move(2, 2);
  await opaqueBackdrop(page);
  await docsShot(page, isMobile(page) ? 'idea-start-work-mobile' : 'idea-start-work', sheet);
});
