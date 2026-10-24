/**
 * Visual audit of the idea page, on a phone and on a laptop, in every state it can be in.
 *
 * The states are the point: the old page said "Exploring" with an "Execute" button for the
 * life of the idea, so each case here checks that the page says where the idea actually
 * stands and offers the one action that matches. Stress data pushes the plan, a verbose
 * failure, long chat topics and a long note through the same layout.
 */
import { expect, type Locator, type Page, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  makeMockProject,
  makeMockUser,
  screenshot as capture,
  setupProjectAuditRoutes,
} from './audit-helpers';
import { expandScrollContainers } from './automation-audit-helpers';

const PROJECT_ID = 'proj-test-1';
const IDEA_ID = 'idea-webhooks';
const IDEA_URL = `/projects/${PROJECT_ID}/ideas/${IDEA_ID}`;

const MOCK_USER = makeMockUser({
  userId: 'user-test-1',
  sessionId: 'session-test-1',
  email: 'test@example.com',
  name: 'Priya Natarajan',
  role: 'superadmin',
});

const PLAN = `When a merchant's endpoint is down we drop the webhook after one failed attempt, so merchants miss \`charge.succeeded\` and ship orders late.

**What we want**

- Retry failed deliveries with exponential backoff for up to 3 days, the same window Stripe uses.
- Show every attempt in the dashboard's delivery log.
- After the last attempt, park the event so the merchant can replay it.

**Out of scope:** the refunds webhook path, which is a separate service.`;

/*
 * `linkedAt` is when the chat was first linked to the idea — the clock the Updates timeline
 * dates "Work started in <chat>" from. Deliberately earlier than `lastActivityAt`, because the
 * two are different clocks and using the latter would redate the entry to the chat's most
 * recent message.
 */
const SESSIONS = [
  {
    sessionId: 'sess-build',
    topic: 'Wiring the retry schedule',
    strong: true,
    sessionStatus: 'active',
    taskId: 'task-build',
    taskStatus: 'in_progress',
    taskErrorMessage: null,
    agentLabel: 'Opus 5.5',
    lastActivityAt: Date.parse('2026-10-23T11:50:00Z'),
    linkedAt: Date.parse('2026-10-23T11:50:00Z') - 6 * 60 * 60 * 1000,
    needsInput: null,
  },
  {
    sessionId: 'sess-research',
    topic: 'Comparing how Stripe and Adyen retry webhooks, and what a merchant sees in each',
    strong: true,
    sessionStatus: 'stopped',
    taskId: 'task-research',
    taskStatus: 'completed',
    taskErrorMessage: null,
    agentLabel: 'Brainstormer',
    lastActivityAt: Date.parse('2026-10-18T09:00:00Z'),
    linkedAt: Date.parse('2026-10-18T09:00:00Z') - 6 * 60 * 60 * 1000,
    needsInput: null,
  },
  {
    sessionId: 'sess-failed',
    topic: 'First attempt at the backfill',
    strong: true,
    sessionStatus: 'stopped',
    taskId: 'task-failed',
    taskStatus: 'failed',
    taskErrorMessage:
      'pnpm test failed. The suite went red in packages/api/tests/unit/delivery/retry-schedule.test.ts because the fixture still assumes a five-attempt cap, and this message is long on purpose so the row has to clamp it rather than push the page sideways.',
    agentLabel: 'Codex',
    lastActivityAt: Date.parse('2026-10-20T14:00:00Z'),
    linkedAt: Date.parse('2026-10-20T14:00:00Z') - 6 * 60 * 60 * 1000,
    needsInput: null,
  },
];

const OPEN_PR = {
  url: 'https://github.com/northwind/payments/pull/482',
  number: 482,
  state: 'open' as const,
  isDraft: false,
  title: 'Retry failed webhook deliveries with exponential backoff over a three-day window',
  checksState: 'success' as const,
  mergedAt: null,
  updatedAt: '2026-10-23T11:58:00Z',
  stale: false,
};
const MERGED_PR = { ...OPEN_PR, state: 'merged' as const, mergedAt: '2026-10-23T08:00:00Z' };

type DerivedState =
  'not-started' | 'working' | 'review' | 'merged' | 'stuck' | 'question' | 'done' | 'parked';

function makeIdea(state: DerivedState, overrides: Record<string, unknown> = {}) {
  // A pull request comes from a chat, so `review` has one too — a fixture without it would
  // quietly exercise the no-chat fallback instead of the state a reader actually sees.
  const session =
    state === 'working' || state === 'question' || state === 'review'
      ? SESSIONS[0]
      : state === 'stuck'
        ? SESSIONS[2]
        : null;
  const pullRequest =
    state === 'review' ? OPEN_PR : state === 'merged' || state === 'done' ? MERGED_PR : null;
  return {
    ideaId: IDEA_ID,
    title: 'Retry failed webhook deliveries',
    content: PLAN,
    summary: 'Retry failed deliveries with exponential backoff for up to 3 days.',
    status: state === 'done' ? 'completed' : state === 'parked' ? 'cancelled' : 'draft',
    /*
     * Set only for `done`, and deliberately EARLIER than `updatedAt`: the "Marked done" entry
     * is dated from this, so a fixture where the two agree would hide the distinction. Also
     * AFTER the pull request merged (08:00 the same day): a done idea that finished before its
     * own work did is an incoherent story to put in front of a screenshot reviewer.
     */
    completedAt: state === 'done' ? '2026-10-23T09:30:00Z' : null,
    createdAt: '2026-10-14T00:00:00Z',
    updatedAt: '2026-10-22T00:00:00Z',
    derived: {
      state,
      needsYou: ['question', 'stuck', 'merged'].includes(state) ? state : null,
      source: {
        origin: pullRequest ? 'github' : session ? 'chat' : 'none',
        observedAt: pullRequest || session ? '2026-10-23T11:58:00Z' : null,
        stale: false,
      },
      session: session
        ? {
            sessionId: session.sessionId,
            topic: session.topic,
            sessionStatus: session.sessionStatus,
            taskId: session.taskId,
            taskStatus: session.taskStatus,
            agentLabel: session.agentLabel,
            lastActivityAt: new Date(session.lastActivityAt).toISOString(),
          }
        : null,
      pullRequest,
      note:
        state === 'question'
          ? 'Stripe gives up after 3 days rather than after 5 attempts. Should we match that, or keep the attempt cap?'
          : state === 'stuck'
            ? SESSIONS[2]!.taskErrorMessage
            : null,
    },
    counts: { updates: 4, chats: 3, files: 1, pullRequests: pullRequest ? 1 : 0 },
    // The detail response carries the newest Updates slice, so the page makes one request per
    // poll rather than two. The page reads `idea.updates`, so a fixture without it crashes.
    updates: { items: UPDATES, total: UPDATES.length, nextCursor: null },
    filedByAgent: false,
    filedBy: null,
    sessions: SESSIONS,
    pullRequests: pullRequest ? [pullRequest] : [],
    ...overrides,
  };
}

const UPDATES = [
  {
    id: 'u-marcus',
    ideaId: IDEA_ID,
    authorKind: 'user',
    authorUserId: 'user-2',
    authorName: 'Marcus Chen',
    sessionId: null,
    sessionTopic: null,
    body: 'Stripe gives up after 3 days, not after 5 attempts. Match that, so merchants see the same behaviour from both.',
    quote: 'cap retries at 5 attempts',
    createdAt: '2026-10-21T10:00:00Z',
    editedAt: null,
  },
  {
    id: 'u-research',
    ideaId: IDEA_ID,
    authorKind: 'agent',
    authorUserId: null,
    authorName: 'Brainstormer',
    sessionId: 'sess-research',
    sessionTopic: 'Comparing how Stripe and Adyen retry webhooks, and what a merchant sees in each',
    body: 'Compared how Stripe and Adyen retry webhooks. Recommendation: exponential backoff over 3 days, then park the event for a manual replay. The full comparison is in retry-schedules.md, including the table of attempt intervals and what each provider shows the merchant while a delivery is still being retried.',
    quote: null,
    createdAt: '2026-10-18T09:00:00Z',
    editedAt: null,
  },
  {
    id: 'u-long',
    ideaId: IDEA_ID,
    authorKind: 'agent',
    authorUserId: null,
    authorName: 'Codex',
    sessionId: 'sess-failed',
    sessionTopic: 'First attempt at the backfill',
    body: 'https://northwind.example.com/dashboard/settings/webhooks/deliveries/01KHRJGANBBWGDY1NZ0KVF0D4J/attempts/0000000000000000 — the delivery this failed on. 🚀 Unicode and <script>alert("xss")</script> go through the same renderer.',
    quote: null,
    createdAt: '2026-10-20T14:00:00Z',
    editedAt: null,
  },
];

const LINKS = {
  sessions: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
  files: {
    items: [
      {
        fileId: 'file-1',
        filename: 'retry-schedules.md',
        directory: '/engineering/research/webhooks/',
        relations: ['uploaded'],
        bySessionId: 'sess-research',
      },
    ],
    total: 1,
    truncated: false,
    totalIsLowerBound: false,
  },
  pullRequests: { items: [], total: 0, truncated: false, totalIsLowerBound: false },
  relatedIdeas: {
    items: [
      {
        ideaId: 'idea-ratelimit',
        title: 'Rate-limit the delivery log so one noisy merchant cannot drown the rest',
        status: 'draft',
        relations: ['related'],
      },
    ],
    total: 1,
    truncated: false,
  },
};

/**
 * Profiles for the Start work sheet. The second name is far longer than the sheet's
 * `NAME_IN_COPY_MAX_CHARS`, so the audit exercises its ellipsis rather than only the happy
 * path, and the picker row has to survive that name at 375px.
 */
const START_WORK_PROFILES = [
  {
    id: 'profile-builder',
    projectId: 'proj-audit',
    userId: 'user-audit',
    name: 'Opus 5.5',
    description: 'Plans and builds carefully, opens a pull request',
    agentType: 'claude-code',
    model: 'claude-opus-5-5',
    workspaceProfile: 'full',
    runtime: 'vm',
    taskMode: 'task',
    isBuiltin: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  },
  {
    id: 'profile-long',
    projectId: 'proj-audit',
    userId: 'user-audit',
    name: 'Careful reviewer that reads the whole repository before touching anything',
    description:
      'Reads every rule file, traces the data path end to end and writes the regression test first',
    agentType: 'claude-code',
    model: 'claude-opus-5-5',
    workspaceProfile: 'full',
    runtime: 'vm',
    taskMode: 'task',
    isBuiltin: false,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
  },
];

/**
 * Opens Start work the way a person does, and waits for the sheet itself.
 *
 * The sheet is the reason this page's primary action is a button rather than a link: the
 * action it replaced navigated to `/chat?executeIdea=<id>`, a parameter nothing read any
 * more, so the person arrived at an empty chat with the idea dropped. A screenshot of the
 * page alone cannot see that, which is why the audit presses the button.
 */
/**
 * What the sheet must say, at either viewport: the idea it is about to start, who works on it
 * and a note. Shared so the two viewport tests differ only in the screenshot they take.
 */
async function expectSheetAsksTheTwoQuestions(sheet: Locator) {
  await expect(sheet.getByText('Retry failed webhook deliveries')).toBeVisible();
  await expect(sheet.getByRole('button', { name: /Who works on it/i })).toBeVisible();
  await expect(sheet.getByLabel('Note for the agent')).toBeVisible();
}

/** The volume case's setup, shared by its phone and laptop tests. */
async function setupVolumeIdea(page: Page) {
  await setupIdeaMocks(page, {
    idea: makeIdea('review', {
      title:
        'Retry failed webhook deliveries with exponential backoff over a three-day window, matching Stripe',
      sessions: MANY_SESSIONS,
      counts: { updates: 4, chats: 9, files: 9, pullRequests: 1 },
    }),
    links: MANY_LINKS,
  });
  await openIdea(page);
}

/**
 * The capped Related total.
 *
 * 9 files + 7 ideas, both reporting `totalIsLowerBound`, against the 10 rows on screen — so
 * the pill must read "16+" rather than asserting a total the server declined to claim.
 */
async function expectCappedRelatedTotal(page: Page) {
  await expect(page.getByText('16+', { exact: true })).toBeVisible();
}

/**
 * Open Start work and capture it. Both viewports want exactly this; only the file name differs,
 * and that difference is the whole point of running it twice.
 */
async function captureStartWorkSheet(page: Page, name: string) {
  await setupIdeaMocks(page);
  await openIdea(page);

  const sheet = await openStartWork(page);
  await expectSheetAsksTheTwoQuestions(sheet);

  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
  await screenshot(page, name);
}

/** One row per derived state: the word the status card says, and the actions that follow from
 * it in the order a reader meets them. `alsoShows` carries whatever else that state is the
 * only one to prove.
 */
const IDEA_STATE_CASES: Array<{
  state: DerivedState;
  name: string;
  status: string | null;
  actions: Array<{ role: 'button' | 'link'; name: string }>;
  alsoShows?: Array<string | RegExp>;
}> = [
  {
    state: 'not-started',
    name: 'an idea nobody has started: the plan, and one Start work',
    status: 'Not started',
    actions: [{ role: 'button', name: 'Start work' }],
    alsoShows: ['Marcus Chen'],
  },
  {
    state: 'working',
    name: 'while work is running, the main button opens the chat',
    status: 'In progress',
    actions: [{ role: 'link', name: 'Open the chat' }],
    alsoShows: [/From the linked chat/],
  },
  {
    state: 'question',
    name: 'a question clamps a long note and offers Answer',
    status: 'Waiting for you',
    actions: [{ role: 'link', name: 'Answer' }],
  },
  {
    state: 'stuck',
    name: 'stopped work shows what broke without pushing the page sideways',
    status: 'Stopped',
    // Reading the failure leads; retrying is the quieter half.
    actions: [
      { role: 'link', name: 'See what happened' },
      { role: 'button', name: 'Try again…' },
    ],
  },
  {
    state: 'review',
    name: 'in review, the main button is Review PR #482',
    status: 'In review',
    // The chat that produced the pull request is the next thing you reach for.
    actions: [
      { role: 'link', name: 'Review PR #482' },
      { role: 'link', name: 'Open the chat' },
    ],
    alsoShows: [/From GitHub/],
  },
  {
    state: 'merged',
    name: 'a merged pull request asks the question, with both answers',
    status: null,
    actions: [
      { role: 'button', name: 'Mark done' },
      { role: 'button', name: 'Keep open' },
    ],
  },
  {
    state: 'done',
    name: 'a done idea says where it shipped and offers follow-up work',
    status: 'Done',
    actions: [{ role: 'button', name: 'Start follow-up work' }],
  },
];

async function openStartWork(page: Page) {
  await page.getByRole('button', { name: 'Start work' }).click();
  const sheet = page.getByRole('dialog', { name: /Start work|Talk it through/i });
  await expect(sheet).toBeVisible();
  return sheet;
}

async function setupIdeaMocks(
  page: Page,
  options: {
    idea?: unknown;
    updates?: unknown[];
    links?: unknown;
    updatesFail?: boolean;
    ideaFails?: boolean;
  } = {}
) {
  await setupProjectAuditRoutes(page, {
    user: MOCK_USER,
    project: makeMockProject(),
    onProjectSubPath: (sub, respond) => {
      if (sub === '/members') return respond(200, { members: [], accessRequests: [] });
      // The picker state must be matched before the list: both start with `/agent-profiles`.
      if (sub.startsWith('/agent-profiles/picker'))
        return respond(200, { hiddenProfileIds: [], usage: [], windowDays: 30 });
      if (sub.startsWith('/agent-profiles')) return respond(200, { items: START_WORK_PROFILES });
      if (sub.startsWith('/skills')) return respond(200, { items: [] });
      if (sub.startsWith('/sessions')) return respond(200, { sessions: [], total: 0 });
      if (sub.startsWith('/triggers')) return respond(200, { triggers: [] });
      if (sub === `/ideas/${IDEA_ID}/updates`) {
        if (options.updatesFail) return respond(500, { error: 'INTERNAL_ERROR', message: 'nope' });
        return respond(200, { updates: options.updates ?? UPDATES, nextCursor: null });
      }
      if (sub === `/ideas/${IDEA_ID}/links`) return respond(200, options.links ?? LINKS);
      if (sub === `/ideas/${IDEA_ID}`) {
        if (options.ideaFails) {
          return respond(500, { error: 'INTERNAL_ERROR', message: 'nope' });
        }
        return respond(200, options.idea ?? makeIdea('not-started'));
      }
      return undefined;
    },
  });
}

/**
 * An idea that has accumulated real volume, with a title longer than the header's one line.
 *
 * Three things only this case reaches. The page's own `<h1>` never met a long title — the
 * long one existed in the fixtures but only the LIST used it. The Work and Related rows are
 * new to this page since they moved onto the shared `LinkedWorkRow`, and every other case
 * shows three of them. And `SectionTitle.count` gained string support so a bounded read can
 * say "N+", which nothing on this page exercised: the counts here are capped, so Related must
 * read "16+" (9 files + 7 ideas, both lower bounds) and not "10", the number of rows on screen.
 * (Raised by the ui-ux-specialist review, 2026-10-24.)
 *
 * Each `total` is deliberately >= its `items.length`. A total BELOW the rows sent is incoherent
 * and `cappedList` in `lib/api/links.ts` discards it in favour of the row count, which is the
 * one number that is certainly true — so a fixture claiming "3 total, here are 4" silently
 * becomes 4 and the assertion measures the normaliser instead of the page. The first draft of
 * this fixture did exactly that.
 */
const MANY_LINKS = {
  ...LINKS,
  files: {
    items: Array.from({ length: 6 }, (_, index) => ({
      fileId: `file-many-${index}`,
      filename: `retry-schedules-${index}-with-a-deliberately-long-research-filename.md`,
      directory: '/engineering/research/webhooks/delivery-retries/',
      relations: index % 2 === 0 ? ['uploaded'] : ['read'],
      bySessionId: 'sess-research',
    })),
    total: 9,
    truncated: true,
    totalIsLowerBound: true,
  },
  relatedIdeas: {
    items: Array.from({ length: 4 }, (_, index) => ({
      ideaId: `idea-many-${index}`,
      title: `Rate-limit the delivery log so one noisy merchant cannot drown the rest (${index})`,
      status: 'draft',
      relations: ['related'],
    })),
    total: 7,
    truncated: true,
    totalIsLowerBound: true,
  },
};

const MANY_SESSIONS = Array.from({ length: 9 }, (_, index) => ({
  ...SESSIONS[index % SESSIONS.length]!,
  sessionId: `sess-many-${index}`,
  topic: `${SESSIONS[index % SESSIONS.length]!.topic} — attempt ${index + 1}`,
}));

async function screenshot(page: Page, name: string) {
  await expandScrollContainers(page);
  await capture(page, name);
}

async function openIdea(page: Page) {
  await page.goto(IDEA_URL);
  await expect(page.getByRole('heading', { name: 'The idea' })).toBeVisible();
}

/**
 * The status card's actions, in the order a reader meets them.
 *
 * Label-only assertions let a "Park" button ship wired to "mark done" and let the stuck
 * card's two buttons ship reversed, so the audit pins the sequence.
 */
async function expectActionOrder(page: Page, labels: string[]) {
  const card = page.getByRole('region', { name: 'Status' });
  const actions = card.getByRole('link').or(card.getByRole('button'));
  await expect(actions).toHaveCount(labels.length);
  expect((await actions.allInnerTexts()).map((text) => text.trim())).toEqual(labels);
}

async function assertLayoutIsSound(page: Page) {
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
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

test.describe('Idea page — phone', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });

  /*
   * The states, as the matrix the page's design actually is: one status word and the actions
   * that follow from it, in order.
   *
   * These were seven tests with identical bodies and different strings, which read as seven
   * decisions when it is really one table — and which SonarCloud measured as 119 duplicated
   * lines in this file alone. A table also makes a missing state obvious, which seven separate
   * tests never did.
   */
  for (const idea of IDEA_STATE_CASES) {
    test(idea.name, async ({ page }) => {
      await setupIdeaMocks(page, { idea: makeIdea(idea.state) });
      await openIdea(page);

      /*
       * `exact`, because the status card's word is now a substring of a timeline entry: a done
       * idea shows "Done" in the card and "Marked done" in Updates, and a loose match resolves
       * to both. Asserting the card's own word keeps this about the status card.
       */
      if (idea.status) {
        await expect(page.getByText(idea.status, { exact: true }).first()).toBeVisible();
      }
      for (const action of idea.actions) {
        await expect(page.getByRole(action.role, { name: action.name })).toBeVisible();
      }
      /*
       * Order, not just presence. "Both buttons are visible" passed happily while the stuck
       * card's two were the wrong way round, so a case with more than one action pins the
       * sequence a reader meets them in.
       */
      if (idea.actions.length > 1) {
        await expectActionOrder(
          page,
          idea.actions.map((action) => action.name)
        );
      }
      for (const text of idea.alsoShows ?? []) {
        await expect(page.getByText(text)).toBeVisible();
      }

      await assertLayoutIsSound(page);
      await screenshot(page, `idea-page-${idea.state}-phone`);
    });
  }

  test('holds up with a long title, many chats and capped Related counts', async ({ page }) => {
    await setupVolumeIdea(page);

    // The header's own long title, which only the list used to exercise.
    await expect(page.getByRole('heading', { name: /matching Stripe/ }).first()).toBeVisible();
    await expect(page.getByRole('region', { name: 'Related' })).toBeVisible();
    await expectCappedRelatedTotal(page);

    await assertLayoutIsSound(page);
    await screenshot(page, 'idea-page-many-phone');
  });

  test('an idea with no plan and nothing linked still reads as a page', async ({ page }) => {
    await setupIdeaMocks(page, {
      idea: {
        ...makeIdea('not-started'),
        content: null,
        summary: null,
        counts: { updates: 0, chats: 0, files: 0, pullRequests: 0 },
        sessions: [],
        pullRequests: [],
        updates: { items: [], total: 0, nextCursor: null },
      },
      updates: [],
      links: {
        sessions: { items: [], total: 0, truncated: false },
        files: { items: [], total: 0, truncated: false },
        pullRequests: { items: [], total: 0, truncated: false },
        relatedIdeas: { items: [], total: 0, truncated: false },
      },
    });
    await openIdea(page);

    await expect(page.getByText(/No plan written yet/)).toBeVisible();
    await expect(page.getByText(/Nothing has worked on this yet/)).toBeVisible();
    await expect(page.getByText(/Nothing yet/)).toBeVisible();

    await assertLayoutIsSound(page);
    await screenshot(page, 'idea-page-empty-phone');
  });

  /*
   * Updates has no failure of its own any more.
   *
   * The notes arrive with the idea, so there is no longer a half-loaded page where the plan
   * renders beside a broken timeline — which is a better outcome than the one this test used
   * to capture. What a person gets when the read fails is the page's own load error, so that
   * is what is captured.
   */
  test('a failed read offers a retry rather than a half-rendered page', async ({ page }) => {
    await setupIdeaMocks(page, { ideaFails: true });
    await page.goto(IDEA_URL);

    await expect(page.getByRole('button', { name: /Try again/i })).toBeVisible();
    // Not a blank screen, and not a page with some sections and not others.
    await expect(page.getByRole('heading', { name: 'The idea' })).toHaveCount(0);

    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'idea-page-load-error-phone');
  });

  test('Start work opens the sheet, which fits a phone and names the idea', async ({ page }) => {
    await captureStartWorkSheet(page, 'idea-page-start-work-sheet-phone');
  });

  test('a profile name far longer than the sheet still fits', async ({ page }) => {
    await setupIdeaMocks(page);
    await openIdea(page);

    const sheet = await openStartWork(page);
    await sheet.getByRole('button', { name: /Who works on it/i }).click();
    const picker = page.getByRole('dialog', { name: /Choose a profile/i });
    await expect(picker).toBeVisible();
    await picker
      .getByRole('button', { name: /Careful reviewer that reads the whole repository/i })
      .click();

    // Back in the sheet, with the long name in copy. The ellipsis is the sheet's job; not
    // widening the phone is the layout's.
    await expect(page.getByRole('dialog', { name: /Start work|Talk it through/i })).toBeVisible();
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'idea-page-start-work-long-profile-phone');
  });

  test('the edit dialog fits a phone screen', async ({ page }) => {
    await setupIdeaMocks(page);
    await openIdea(page);

    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Edit the idea' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save the plan' })).toBeEnabled();

    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'idea-page-edit-dialog-phone');
  });
});

test.describe('Idea page — laptop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('the plan and its updates on the left, status and work on the right', async ({ page }) => {
    await setupIdeaMocks(page, { idea: makeIdea('review') });
    await openIdea(page);

    const plan = await page.getByRole('region', { name: 'The idea' }).boundingBox();
    const status = await page.getByRole('region', { name: 'Status' }).boundingBox();
    expect(plan).not.toBeNull();
    expect(status).not.toBeNull();
    // Same order as the phone, in two columns: the status column starts after the plan ends.
    expect(status!.x).toBeGreaterThan(plan!.x + plan!.width - 1);

    await assertLayoutIsSound(page);
    await screenshot(page, 'idea-page-review-desktop');
  });

  test('holds up with stopped work and a long note', async ({ page }) => {
    await setupIdeaMocks(page, { idea: makeIdea('stuck') });
    await openIdea(page);

    await assertLayoutIsSound(page);
    await screenshot(page, 'idea-page-stuck-desktop');
  });

  test('Start work opens the sheet on a laptop too', async ({ page }) => {
    await captureStartWorkSheet(page, 'idea-page-start-work-sheet-desktop');
  });

  test('an idea nobody has started, in two columns', async ({ page }) => {
    await setupIdeaMocks(page);
    await openIdea(page);

    // The most common state, and the one Start work is reached from, at the wider viewport.
    await expect(page.getByText('Not started')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start work' })).toBeVisible();

    await assertLayoutIsSound(page);
    await screenshot(page, 'idea-page-not-started-desktop');
  });

  test('a long title, many chats and capped counts in two columns', async ({ page }) => {
    await setupVolumeIdea(page);

    await expectCappedRelatedTotal(page);
    await assertLayoutIsSound(page);
    await screenshot(page, 'idea-page-many-desktop');
  });

  test('the edit dialog stays inside the viewport', async ({ page }) => {
    await setupIdeaMocks(page);
    await openIdea(page);

    await page.getByRole('button', { name: 'Edit' }).click();
    await expect(page.getByRole('heading', { name: 'Edit the idea' })).toBeVisible();
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'idea-page-edit-dialog-desktop');
  });
});
