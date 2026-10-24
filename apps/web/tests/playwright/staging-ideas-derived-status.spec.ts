/**
 * Staging verification for T8 PR1 — the Ideas list with state derived from linked work.
 *
 * The thing this run exists to prove is the one boundary no local test crosses. The route is
 * covered against a real SQL engine with the Durable Object stubbed
 * (`apps/api/tests/unit/routes/ideas-routes.test.ts`), and the Durable Object is covered in
 * workerd with no route in front of it (`apps/api/tests/workers/project-data-idea-work.test.ts`).
 * Neither runs the real `env.PROJECT_DATA.get(id).getIdeaWorkSnapshots(...)` call between them,
 * so a mismatch at that RPC — a structured-clone boundary this codebase has been bitten by
 * before — would reach production green. Here the link is written through the real link store,
 * read back through the real binding, and the answer is read off the page a person sees
 * (coordinator condition, `feature.linked-work` seq 210).
 *
 * Everything is driven as a user or through the real REST API; nothing sets UI state directly
 * (`.claude/rules/62`). Every row it creates is deleted at the end and re-read to prove it.
 *
 * `T8_PROJECT_ID` must name a project that already holds real ideas, so the run is also the
 * rule-17 stress pass with data nobody wrote for it: the chosen staging project has 80
 * pre-existing `status='draft'` rows, which the `0207` backfill turns into ideas. That is the
 * coordinator's accepted note observed rather than asserted, and 80 rows at 375px is a harder
 * layout than any fixture. The first test fails if the list is small, because a verification
 * run against an empty page would prove nothing about either.
 *
 * Run inside `exec_with_secrets` with `secretNames: ["SAM_PLAYWRIGHT_PRIMARY_USER"]`: in an
 * agent workspace that variable holds a placeholder, not the token (program decision 12).
 * Run with `--workers=1` — the token-login is rate-limited per IP and `stagingLogin` caches
 * one login for the whole file.
 */
import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow } from './audit-helpers';
import {
  dismissStagingOnboarding,
  STAGING_API,
  STAGING_APP,
  stagingLogin,
  stagingShot,
} from './staging-helpers';

const PROJECT_ID = process.env.T8_PROJECT_ID ?? '';
/**
 * A `cf-container` profile on the target project, so Start work can reach a 2xx.
 *
 * Overridable because the default is only correct for the staging project this spec is
 * normally pointed at; the assertion below still holds on a project without one.
 */
const CONTAINER_PROFILE_ID =
  process.env.T8_CONTAINER_PROFILE_ID ?? '01KYQ60N603GE9G3Y767K9NSW4';

/**
 * A COMPLETED ordinary task (`is_idea = 0`) on the target project.
 *
 * The row shape PR2's gate exists for: it shares its status with a done idea, so before the
 * fix it answered `409 "That idea is done. Reopen it..."` — telling a caller both that the row
 * exists and what state it is in, for an id they only guessed at. Taken from staging D1 rather
 * than created, because `POST /tasks` cannot make a task-mode task terminal and a real row is
 * the honest fixture anyway.
 */
const CLOSED_NON_IDEA_ID =
  process.env.T8_CLOSED_TASK_ID ?? '01M5Q7Z0QQXPC0NH6R8XZHMA84';

/** Unique per run, so a failed run never collides with the next one. */
const RUN = Date.now().toString(36);
const IDEA_TITLE = `T8 staging — derived status ${RUN}`;
/**
 * The chat's topic. The list's row for a working idea reads
 * "<agent> is working in <chat topic>", and that topic can ONLY have come from the Durable
 * Object's `chat_sessions` join inside `getIdeaWorkSnapshots` — the route has no other source
 * for it. When the snapshot comes back empty, `chatName` falls back to the literal "the chat"
 * (`pages/ideas/view-model.ts`), so asserting this exact string is what distinguishes "the hop
 * returned data" from "the page rendered" (coordinator, seq 224).
 */
const CHAT_TOPIC = `T8 staging chat ${RUN}`;

interface Created {
  ideaId: string;
  sessionId: string;
  /** The conversation task `POST /sessions` creates alongside the chat. */
  sessionTaskId: string;
  /** An ordinary `POST /tasks` draft: is_idea = 0, the discriminator's negative case. */
  ordinaryTaskId: string;
  /** A second idea, used to prove Start work still accepts a real one. */
  startWorkIdeaId: string;
  startWorkSessionId: string;
  startWorkTaskId: string;
}

const created: Created = {
  ideaId: '',
  sessionId: '',
  sessionTaskId: '',
  ordinaryTaskId: '',
  startWorkIdeaId: '',
  startWorkSessionId: '',
  startWorkTaskId: '',
};

async function api(page: Page, method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) {
  const res = await page.request.fetch(`${STAGING_API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { data: body }),
    timeout: 30_000,
  });
  return res;
}

/**
 * Captures a state and checks it for overflow in the same step, so a real-data layout problem
 * cannot be screenshotted without being asserted on (rules 17 and 56). The capture itself is
 * the shared `stagingShot`; only the assertion is added here, deliberately rather than inside
 * the shared helper, because three other items in this program are mid-flight against it and a
 * new blocking assertion in a shared helper would land in their specs too.
 */
async function shot(page: Page, name: string): Promise<void> {
  await assertNoOverflow(page);
  await stagingShot(page, name);
}

/** The least number of ideas that makes this a stress pass rather than an empty page. */
const MIN_REAL_IDEAS = 10;

async function openIdeas(page: Page): Promise<void> {
  await page.goto(`${STAGING_APP}/projects/${PROJECT_ID}/ideas`);
  await expect(page.getByRole('heading', { name: 'Ideas', level: 1 })).toBeVisible({
    timeout: 30_000,
  });
  await dismissStagingOnboarding(page);
}

/**
 * Narrows the list to this run's idea the way a person would, by typing in the search box.
 * With 80 real ideas in the project the row is in the DOM either way, but it is far down the
 * page — so without this the screenshots would show somebody else's ideas and prove nothing.
 */
async function searchForThisRun(page: Page): Promise<void> {
  const search = page.getByPlaceholder('Search ideas');
  await expect(search).toBeVisible();
  await search.fill(RUN);
  await expect(ideaRow(page)).toBeVisible({ timeout: 20_000 });
  await ideaRow(page).scrollIntoViewIfNeeded();
}

/** The row for this run's idea, found by its title rather than by position. */
function ideaRow(page: Page) {
  return page.getByTestId('idea-row').filter({ hasText: IDEA_TITLE });
}

test.beforeEach(async ({ page }) => {
  expect(PROJECT_ID, 'T8_PROJECT_ID must be set').not.toBe('');
  await stagingLogin(page);
});

test.describe.configure({ mode: 'serial' });

test.describe('Ideas list on staging — phone', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });

  test('files a real idea and shows it as Not started', async ({ page }) => {
    // Through the route this PR adds, not a seeded row: `POST /tasks` would create an
    // ORDINARY task, which is the whole point of the `is_idea` change.
    const res = await api(page, 'POST', `/api/projects/${PROJECT_ID}/ideas`, {
      title: IDEA_TITLE,
      content: '# Staging check\n\n- derived status\n- linked work\n\nCreated by the T8 PR1 spec.',
    });
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()) as { ideaId: string; derived: { state: string } };
    created.ideaId = body.ideaId;
    expect(body.derived.state).toBe('not-started');

    await openIdeas(page);
    await expect(ideaRow(page)).toBeVisible({ timeout: 20_000 });

    // The stress pass, on data nobody wrote for this test: every one of these rows is a
    // pre-existing draft the backfill turned into an idea, with whatever titles and summaries
    // their authors happened to give them.
    const rows = await page.getByTestId('idea-row').count();
    expect(
      rows,
      `T8_PROJECT_ID must name a project with real ideas; saw ${rows}`
    ).toBeGreaterThanOrEqual(MIN_REAL_IDEAS);
    await shot(page, 't8-ideas-real-list');

    // Then this run's own row, which is what the rest of the file follows.
    await searchForThisRun(page);
    // The markdown fix ships in this PR too: the plan's list renders as a sentence, not `- `.
    await expect(ideaRow(page)).not.toContainText('- derived status');
    await shot(page, 't8-ideas-not-started');
  });

  test('a real linked chat moves it to In progress', async ({ page }) => {
    // One chat, created through the real route, then linked through the real link route —
    // which writes a `resource_links` row in the ProjectData Durable Object.
    const session = await api(page, 'POST', `/api/projects/${PROJECT_ID}/sessions`, {
      topic: CHAT_TOPIC,
    });
    expect(session.status(), await session.text()).toBe(201);
    const sessionBody = (await session.json()) as { sessionId: string; taskId: string };
    created.sessionId = sessionBody.sessionId;
    created.sessionTaskId = sessionBody.taskId;

    const linked = await api(
      page,
      'POST',
      `/api/projects/${PROJECT_ID}/sessions/${created.sessionId}/ideas`,
      { taskId: created.ideaId, context: 'T8 staging verification' }
    );
    expect(linked.status(), await linked.text()).toBe(201);

    // THE HOP. The list reads that link back through the real PROJECT_DATA binding, joins the
    // chat's task from D1, and derives the state. Read off the page, not out of the API.
    await openIdeas(page);
    await searchForThisRun(page);
    const row = ideaRow(page);

    // The idea is now under "In progress" rather than "Not started", and the search has
    // narrowed the page to it — so this heading is about this idea and nothing else.
    await expect(page.getByRole('heading', { name: /In progress/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Not started/ })).toBeHidden();
    // Per-row, not just per-section: the row's own state label.
    await expect(row).toContainText('In progress');

    // THE PROOF THE HOP RETURNED DATA. This string is the chat's topic, which the route can
    // only have from the Durable Object's `chat_sessions` join. An empty snapshot renders the
    // literal "the chat" instead, so this assertion fails on exactly the failure it exists to
    // catch — and the second line forbids that fallback explicitly.
    await expect(row).toContainText(`is working in ${CHAT_TOPIC}`);
    await expect(row).not.toContainText('is working in the chat');

    // And the count is non-zero. `\\d+ chat` would have passed on "0 chats", which is what an
    // empty snapshot produces — the bug this regex had until seq 224 asked for the stronger
    // assertion.
    await expect(row).toContainText(/[1-9]\d* chat/);
    await shot(page, 't8-ideas-in-progress');
  });

  test('Mark done moves it to Done recently, which only the flag makes possible', async ({
    page,
  }) => {
    // Driven through the real route the UI calls. A done idea is `completed`, which is
    // otherwise an ordinary finished task — without `is_idea` it would vanish from Ideas here.
    const done = await api(
      page,
      'POST',
      `/api/projects/${PROJECT_ID}/ideas/${created.ideaId}/status`,
      { status: 'completed' }
    );
    expect(done.status(), await done.text()).toBe(200);
    expect(((await done.json()) as { derived: { state: string } }).derived.state).toBe('done');

    /*
     * The coordinator's combined check (seq 262), in the form that is reachable over HTTP.
     *
     * A COMPLETED idea must still be readable through a predicate-gated read and still carry
     * its content — that is what `is_idea = 1` buys, and before this PR a completed row left
     * the idea surfaces entirely. `GET /ideas/:id` reaches it through `readIdeaRow`, which
     * applies `ideaTaskPredicateSql()` exactly as T6's `get_idea` does through `getIdea`.
     * They are sibling functions over one predicate, so this exercises the predicate on a done
     * idea live; it does NOT exercise T6's MCP tool itself, which needs a workspace-minted MCP
     * token. That gap is stated in the PR rather than papered over.
     */
    const doneRead = await api(page, 'GET', `/api/projects/${PROJECT_ID}/ideas/${created.ideaId}`);
    expect(doneRead.status(), await doneRead.text()).toBe(200);
    const doneBody = (await doneRead.json()) as {
      derived: { state: string };
      idea?: { content?: string | null };
      content?: string | null;
    };
    expect(doneBody.derived.state).toBe('done');
    // Content survives completion — the read is not a stub for a finished idea.
    const content = doneBody.idea?.content ?? doneBody.content ?? '';
    expect(content, 'a completed idea still returns its plan').toContain('Staging check');

    await openIdeas(page);
    const search = page.getByPlaceholder('Search ideas');
    await search.fill(RUN);
    // On a phone the finished ideas are folded, so open the fold the way a person would.
    const fold = page.getByTestId('ideas-done-recently');
    await expect(fold).toBeVisible({ timeout: 20_000 });
    // The summary carries the count, so this also asserts the fold found the idea.
    await fold.getByText(/Done recently · \d+/).click();
    await expect(fold).toContainText(IDEA_TITLE, { timeout: 20_000 });
    // Per-row state, so "it is in the fold" cannot pass for a row still showing In progress.
    await expect(ideaRow(page)).toContainText('Done');
    await shot(page, 't8-ideas-done-recently');
  });
});

test.describe('Ideas list on staging — laptop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('shows the same idea, and its side column, with the extra width', async ({ page }) => {
    await openIdeas(page);
    // The side column only exists at this width, and it carries the explanation of the states.
    await expect(page.getByText('Ideas move on their own')).toBeVisible({ timeout: 20_000 });
    await shot(page, 't8-ideas-desktop-real-list');

    await page.getByPlaceholder('Search ideas').fill(RUN);
    // The same Mark done result at the laptop width, where "Done recently" is a side-column
    // panel rather than a fold — so the coordinator's "both viewports" is two different
    // layouts of the same state, not the same layout twice.
    await expect(page.getByRole('heading', { name: /Done recently/ })).toBeVisible();
    await expect(ideaRow(page)).toBeVisible({ timeout: 20_000 });
    await expect(ideaRow(page)).toContainText('Done');
    // The done row keeps the evidence of the work: it is still the idea that chat worked on.
    await expect(page.getByRole('heading', { name: /In progress/ })).toBeHidden();

    /*
     * The main column is empty here — every match is the done idea, which renders in the side
     * column — so it must SAY so rather than render a void. This is the defect the first
     * staging screenshot at this width showed: a third of the page blank while the match sat
     * to the right of it. Asserted on staging as well as locally because the local audit runs
     * against mocks, and this is the one state where a real list and a mocked one differ in
     * how easy it is to reach.
     */
    await expect(page.getByText(/Nothing open matches/)).toBeVisible();
    await expect(page.getByText(/under Done recently/)).toBeVisible();
    await shot(page, 't8-ideas-desktop');
  });

  test('reopens it, and it returns to the open list', async ({ page }) => {
    const reopened = await api(
      page,
      'POST',
      `/api/projects/${PROJECT_ID}/ideas/${created.ideaId}/status`,
      { status: 'draft' }
    );
    expect(reopened.status(), await reopened.text()).toBe(200);

    await openIdeas(page);
    await searchForThisRun(page);

    /*
     * Back into the OPEN list — as "In progress", not "Not started".
     *
     * This assertion said "Not started" on the first attempt and failed, and the product was
     * right: reopening only clears the human decision (`completed` → `draft`). The chat linked
     * in the earlier test is still there and its conversation task is still `queued`, which is
     * a LIVE status, so `deriveIdeaStatus` goes on to rule 4 and returns `working`. Verified in
     * staging D1 rather than inferred — the chat task was still `queued` when the test failed.
     *
     * "Not started" would only be right if the idea had no live linked work, and asserting it
     * here would have demanded that reopening silently unlink the chat.
     */
    await expect(page.getByRole('heading', { name: /In progress/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Done recently/ })).toBeHidden();
    const reopenedRow = ideaRow(page);
    await expect(reopenedRow).toContainText('In progress');
    await expect(reopenedRow).not.toContainText('Done');
    // And it still carries the work it was linked to, so reopening did not drop the link.
    await expect(reopenedRow).toContainText(`is working in ${CHAT_TOPIC}`);
    await shot(page, 't8-ideas-reopened');
  });

  test('refuses to run the idea in place', async ({ page }) => {
    // Program decision 1, and the security finding behind it: an idea that could reach `ready`
    // could then be delegated, bypassing Start work entirely.
    const res = await api(
      page,
      'POST',
      `/api/projects/${PROJECT_ID}/tasks/${created.ideaId}/status`,
      {
        toStatus: 'ready',
      }
    );
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(await res.text()).toContain('Invalid status transition');
  });

  /*
   * T7's Start work, against the narrowed idea definition this PR ships (coordinator, seq 236).
   *
   * `requireOpenIdeaForWorkStart` selects `ideaTaskPredicateSql('tasks')`, which this PR
   * changed from `status = 'draft'` to `is_idea = 1`. If that narrowing were wrong, Start work
   * would stop working for real ideas — so the acceptance below is the half that matters most,
   * and it is checked on deployed code rather than in a fixture.
   *
   * The gate runs BEFORE any effects (`routes/chat-start.ts`), so both refusals cost nothing:
   * no session, no container, no branch. Only the acceptance provisions, and it provisions an
   * Instant container (the route 409s a VM runtime outright), which this test stops again.
   */
  test('Start work accepts a POST /ideas idea and refuses an ordinary draft', async ({ page }) => {
    // 1. An ordinary task, created through the route that deliberately writes is_idea = 0.
    const ordinary = await api(page, 'POST', `/api/projects/${PROJECT_ID}/tasks`, {
      title: `T8 staging ordinary draft ${RUN}`,
      description: 'Not an idea. Created to prove the discriminator on deployed code.',
    });
    expect(ordinary.status(), await ordinary.text()).toBe(201);
    created.ordinaryTaskId = ((await ordinary.json()) as { id: string }).id;

    // Draft, same project — under the OLD `status = 'draft'` rule this was indistinguishable
    // from an idea and Start work would have accepted it. Now it is a non-disclosing 404.
    const refused = await api(page, 'POST', `/api/projects/${PROJECT_ID}/sessions/start`, {
      message: 'Start work on this.',
      sourceIdeaId: created.ordinaryTaskId,
    });
    expect(refused.status(), await refused.text()).toBe(404);

    // 2. The owner control: a real idea is accepted. Without this, the 404 above would also
    //    pass if Start work were broken for everything.
    const idea = await api(page, 'POST', `/api/projects/${PROJECT_ID}/ideas`, {
      title: `T8 staging start-work ${RUN}`,
      content: 'Exercises Start work against the is_idea definition.',
    });
    expect(idea.status(), await idea.text()).toBe(201);
    created.startWorkIdeaId = ((await idea.json()) as { ideaId: string }).ideaId;

    /*
     * Ask for a container profile by id, so the request can reach a real 2xx.
     *
     * `STAGING_CONTAINER_PROFILE_ID` defaults to a profile verified in D1 on the staging
     * project this spec targets:
     *
     *   SELECT id, name, runtime FROM agent_profiles WHERE project_id = ?
     *   -- 01KYQ5YDHC1VS0BZ9F3NY97FNH  Codex MCP Test    cf-container
     *   -- 01KYQ60N603GE9G3Y767K9NSW4  Claude MCP Test   cf-container
     *   -- (12 more, all runtime NULL)
     *
     * This corrects a claim in the previous version of this comment. It said "every profile on
     * this project has `runtime: null`", which came from reading a `LIMIT 6` page of that same
     * query — the two container profiles sort after the six it returned. Acting on that reading
     * left the test unable to take its own success branch, so the 409 fallback was the only
     * branch that ever ran.
     */
    const started = await api(page, 'POST', `/api/projects/${PROJECT_ID}/sessions/start`, {
      message: 'Say hello and stop. This is a staging verification run.',
      sourceIdeaId: created.startWorkIdeaId,
      agentProfileId: CONTAINER_PROFILE_ID,
    });
    const startedText = await started.text();

    /*
     * The control has to be discriminating in BOTH branches, which the first version of it was
     * not: it tolerated 409 outright, so on a project whose profiles resolve to a VM runtime it
     * passed without ever accepting anything. CodeRabbit caught that.
     *
     * With a container profile requested, 2xx is the expected branch and the one that proves
     * the most: a task id linked to the idea. The 409 branch is kept as a fallback for a run
     * against a project without a container profile, and is still discriminating on WHICH 409:
     * `requireOpenIdeaForWorkStart` runs before any effects, while `resolveWorkspaceRuntime`
     * and its VM refusal run after it (`routes/chat-start.ts`), so a 409 carrying the
     * VM-runtime message is positive evidence that the idea gate ACCEPTED — the request got
     * past it and died further down — whereas a 404 is the gate rejecting.
     */
    expect(started.status(), startedText).not.toBe(404);
    expect(started.status(), startedText).not.toBe(403);
    if (started.status() === 409) {
      // Downstream of the gate: the runtime refusal, not an idea refusal.
      expect(startedText).toMatch(/VM runtime/i);
    } else {
      expect([201, 202], startedText).toContain(started.status());
      const startedBody = JSON.parse(startedText) as { sessionId?: string; taskId?: string };
      created.startWorkSessionId = startedBody.sessionId ?? '';
      created.startWorkTaskId = startedBody.taskId ?? '';
      // A started idea must have produced real work, not just a 2xx.
      expect(created.startWorkTaskId, startedText).not.toBe('');
      expect(created.startWorkSessionId, startedText).not.toBe('');

      /*
       * And that work must be ON THE IDEA. A 2xx with a task id proves something started;
       * only the link proves it started against this idea, which is the whole contract of
       * `recordWorkStartIdeaLink`. Without this the test would pass if `sourceIdeaId` were
       * accepted and then dropped — the same class of defect as the dead Start work link this
       * PR fixes, where the idea was collected and silently discarded.
       */
      const links = await api(
        page,
        'GET',
        `/api/projects/${PROJECT_ID}/ideas/${created.startWorkIdeaId}/links`
      );
      const linksText = await links.text();
      expect(links.status(), linksText).toBe(200);
      const sessions = (JSON.parse(linksText) as { sessions: { items: { sessionId: string }[] } })
        .sessions.items;
      expect(
        sessions.map((session) => session.sessionId),
        linksText
      ).toContain(created.startWorkSessionId);
    }
  });

  /*
   * Cleanup runs in `afterAll`, NOT as the final test.
   *
   * These tests are serial, so a failure in any earlier one skips every test after it —
   * including a cleanup test. That is not hypothetical: two runs earlier today died mid-file
   * and left an idea on staging that I had to find in D1 and delete by hand. `afterAll` runs
   * even when a test fails, so the footprint is cleaned on the failure path, which is exactly
   * the path that creates orphans. (CodeRabbit raised this; it had already cost me twice.)
   *
   * It still PROVES the deletion rather than assuming it: every id is re-read afterwards and
   * must be gone. A cleanup failure is reported through `expect`, which `afterAll` surfaces as
   * a suite failure, so a silent leak cannot pass.
   */
  /*
   * The disclosure gate, on deployed code (PR2).
   *
   * `classifyWorkStartIdea` tested the status BEFORE `isIdea`, so this row — completed,
   * is_idea = 0, in the caller's own project — got the idea-shaped 409 rather than the
   * non-disclosing 404 every other non-idea gets. Authorization is not what refuses it here;
   * only the flag is, which is why the owner control matters.
   */
  test('a completed ordinary task 404s without naming its state, while a done idea 409s', async ({
    page,
  }) => {
    await stagingLogin(page);

    const closed = await api(page, 'POST', `/api/projects/${PROJECT_ID}/sessions/start`, {
      message: 'Start work on this.',
      sourceIdeaId: CLOSED_NON_IDEA_ID,
    });
    const closedText = await closed.text();
    expect(closed.status(), closedText).toBe(404);
    // The 409 wording must be unreachable from a non-idea, not merely accompanied by a 404.
    expect(closedText).not.toMatch(/Reopen it/i);
    expect(closedText).not.toMatch(/is done/i);

    /*
     * The owner control. Mark the run's own idea done through the real route, then ask again:
     * a REAL done idea must still get the actionable 409. Without this the assertion above is
     * also satisfied by the gate being broken for everything.
     */
    const done = await api(
      page,
      'POST',
      `/api/projects/${PROJECT_ID}/ideas/${created.ideaId}/status`,
      { status: 'completed' }
    );
    expect(done.status(), await done.text()).toBe(200);

    const doneIdea = await api(page, 'POST', `/api/projects/${PROJECT_ID}/sessions/start`, {
      message: 'Start work on this.',
      sourceIdeaId: created.ideaId,
    });
    const doneText = await doneIdea.text();
    expect(doneIdea.status(), doneText).toBe(409);
    expect(doneText).toMatch(/Reopen it/i);

    // Put it back, so the cleanup below and the rest of the file see the state they expect.
    const reopened = await api(
      page,
      'POST',
      `/api/projects/${PROJECT_ID}/ideas/${created.ideaId}/status`,
      { status: 'draft' }
    );
    expect(reopened.status(), await reopened.text()).toBe(200);
  });

  /*
   * The idea page itself, which is what PR2 ships, driven as a person drives it.
   *
   * Two pages, because the page's whole design is that the one primary action follows the
   * state. The run's own idea has a linked chat by now, so it is `working` and its action is
   * "Open the chat"; a freshly filed idea is `not-started` and its action is "Start work".
   * Asserting only one of them would leave the other free to show the wrong button.
   *
   * The first draft of this test asserted "Start work" on the run's idea and failed on
   * staging — correctly. The page was right and the assumption was wrong: an idea someone is
   * already working on should not invite you to start work on it again.
   */
  test('the idea page shows the action its state calls for, and Start work opens the sheet', async ({
    page,
  }) => {
    await stagingLogin(page);

    // 1. The idea this run linked a chat to: in progress, so the action is the chat.
    await page.goto(`${STAGING_APP}/projects/${PROJECT_ID}/ideas/${created.ideaId}`);
    await dismissStagingOnboarding(page);
    await expect(page.getByRole('heading', { name: new RegExp(RUN) })).toBeVisible({
      timeout: 30_000,
    });
    const status = page.getByRole('region', { name: 'Status' });
    await expect(status).toBeVisible();
    await expect(status.getByText('In progress')).toBeVisible();
    await expect(status.getByRole('link', { name: 'Open the chat' })).toBeVisible();
    // Start work is NOT offered here, which is the point of a state-dependent action.
    await expect(page.getByRole('button', { name: 'Start work' })).toHaveCount(0);
    /*
     * And the Work section carries the real chat — the route -> Durable Object hop read on the
     * page a person sees, not just through the list.
     */
    const work = page.getByRole('region', { name: 'Work' });
    await expect(work.getByRole('link', { name: new RegExp(RUN) })).toBeVisible();
    await assertNoOverflow(page);
    await stagingShot(page, 't8-pr2-idea-page-in-progress');

    // 2. A fresh idea: nothing has worked on it, so the action is Start work.
    const fresh = await api(page, 'POST', `/api/projects/${PROJECT_ID}/ideas`, {
      title: `T8 staging idea page ${RUN}`,
      content: 'Filed to exercise the idea page in its not-started state.',
    });
    expect(fresh.status(), await fresh.text()).toBe(201);
    const freshId = ((await fresh.json()) as { ideaId: string }).ideaId;

    try {
      await page.goto(`${STAGING_APP}/projects/${PROJECT_ID}/ideas/${freshId}`);
      await dismissStagingOnboarding(page);
      await expect(page.getByRole('heading', { name: /T8 staging idea page/ })).toBeVisible({
        timeout: 30_000,
      });

      const startWork = page.getByRole('button', { name: 'Start work' });
      await expect(startWork).toBeVisible();
      /*
       * The regression this PR exists for: Start work must not be a link. It was one, to
       * `/chat?executeIdea=<id>`, whose reader had already been removed — so pressing it
       * opened an empty chat with the idea dropped. A page-load check cannot see that.
       */
      expect(await startWork.getAttribute('href')).toBeNull();

      await startWork.click();
      const sheet = page.getByRole('dialog', { name: /Start work|Talk it through/i });
      await expect(sheet).toBeVisible({ timeout: 20_000 });
      // It must name the idea it is about to start.
      await expect(sheet.getByText(/T8 staging idea page/)).toBeVisible();

      await assertNoOverflow(page);
      await stagingShot(page, 't8-pr2-idea-page-start-work');

      // Close without starting: this proves the entry point, not a second workspace.
      await sheet.getByRole('button', { name: 'Cancel' }).click();
      await expect(sheet).toBeHidden();
    } finally {
      /*
       * Delete here rather than in afterAll, so a failure above still cleans up. Through
       * `/tasks/:id`, which is the path the cleanup block below already proves works for an
       * idea — an idea IS a task row, and there is no separate idea delete route.
       */
      const deleted = await api(page, 'DELETE', `/api/projects/${PROJECT_ID}/tasks/${freshId}`);
      expect([200, 204, 404], await deleted.text()).toContain(deleted.status());
      // Re-read rather than trust the delete's own answer.
      const gone = await api(page, 'GET', `/api/projects/${PROJECT_ID}/ideas/${freshId}`);
      expect(gone.status(), `re-read ${freshId} after delete`).toBe(404);
    }
  });

  test.afterAll(async ({ browser }) => {
    const page = await browser.newPage();
    try {
      await stagingLogin(page);
      if (created.sessionId && created.ideaId) {
        await api(
          page,
          'DELETE',
          `/api/projects/${PROJECT_ID}/sessions/${created.sessionId}/ideas/${created.ideaId}`
        );
      }
      const ids = [
        created.sessionTaskId,
        created.startWorkTaskId,
        created.startWorkIdeaId,
        created.ordinaryTaskId,
        created.ideaId,
      ].filter((id) => id !== '');
      for (const id of ids) {
        const deleted = await api(page, 'DELETE', `/api/projects/${PROJECT_ID}/tasks/${id}`);
        expect([200, 204, 404], `delete ${id}`).toContain(deleted.status());
      }
      // Re-read rather than trust the deletes' own answers.
      for (const id of ids) {
        const gone = await api(page, 'GET', `/api/projects/${PROJECT_ID}/ideas/${id}`);
        expect(gone.status(), `re-read ${id} after delete`).toBe(404);
      }
    } finally {
      await page.close();
    }
  });
});
