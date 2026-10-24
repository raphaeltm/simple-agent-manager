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
}

const created: Created = { ideaId: '', sessionId: '', sessionTaskId: '' };

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

  test('cleans up everything it created, and proves it', async ({ page }) => {
    if (created.sessionId) {
      await api(
        page,
        'DELETE',
        `/api/projects/${PROJECT_ID}/sessions/${created.sessionId}/ideas/${created.ideaId}`
      );
    }
    if (created.sessionTaskId) {
      // There is no `DELETE /sessions/:id`; the chat's own conversation task is what owns it,
      // and deleting that is what removes the chat from the project.
      const deletedChat = await api(
        page,
        'DELETE',
        `/api/projects/${PROJECT_ID}/tasks/${created.sessionTaskId}`
      );
      expect([200, 204]).toContain(deletedChat.status());
    }
    if (created.ideaId) {
      const deleted = await api(
        page,
        'DELETE',
        `/api/projects/${PROJECT_ID}/tasks/${created.ideaId}`
      );
      expect([200, 204]).toContain(deleted.status());
      // Re-read rather than trust the delete's own answer.
      const gone = await api(page, 'GET', `/api/projects/${PROJECT_ID}/ideas/${created.ideaId}`);
      expect(gone.status()).toBe(404);
    }
  });
});
