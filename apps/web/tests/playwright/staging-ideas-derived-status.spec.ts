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
 * Run inside `exec_with_secrets` with `secretNames: ["SAM_PLAYWRIGHT_PRIMARY_USER"]`: in an
 * agent workspace that variable holds a placeholder, not the token (program decision 12).
 * Set `T8_PROJECT_ID` to the staging project. Run with `--workers=1` — see `login`.
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

async function openIdeas(page: Page): Promise<void> {
  await page.goto(`${STAGING_APP}/projects/${PROJECT_ID}/ideas`);
  await expect(page.getByRole('heading', { name: 'Ideas', level: 1 })).toBeVisible({
    timeout: 30_000,
  });
  await dismissStagingOnboarding(page);
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
    // The markdown fix ships in this PR too: the plan's list renders with bullets.
    await shot(page, 't8-ideas-not-started');
  });

  test('a real linked chat moves it to In progress', async ({ page }) => {
    // One chat, created through the real route, then linked through the real link route —
    // which writes a `resource_links` row in the ProjectData Durable Object.
    const session = await api(page, 'POST', `/api/projects/${PROJECT_ID}/sessions`, {
      topic: `T8 staging chat ${RUN}`,
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
    const row = ideaRow(page);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText(/In progress|is working|chat/i, { timeout: 20_000 });

    const inProgress = page.getByRole('heading', { name: /In progress/ });
    await expect(inProgress).toBeVisible();
    await shot(page, 't8-ideas-in-progress');

    // And the counts are real, not zeros: the chat the link store just recorded is counted.
    await expect(row).toContainText(/\d+ chat/);
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
    // On a phone the finished ideas are folded, so open the fold the way a person would.
    const fold = page.getByTestId('ideas-done-recently');
    await expect(fold).toBeVisible({ timeout: 20_000 });
    // The summary carries the count, so this also asserts the fold found the idea.
    await fold.getByText(/Done recently · \d+/).click();
    await expect(fold).toContainText(IDEA_TITLE, { timeout: 20_000 });
    await shot(page, 't8-ideas-done-recently');
  });
});

test.describe('Ideas list on staging — laptop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('shows the same idea, and its side column, with the extra width', async ({ page }) => {
    await openIdeas(page);
    await expect(page.getByText('Ideas move on their own')).toBeVisible({ timeout: 20_000 });
    // Done recently is a side-column panel at this width rather than a fold.
    await expect(page.getByRole('heading', { name: /Done recently/ })).toBeVisible();
    await expect(page.getByText(IDEA_TITLE).first()).toBeVisible({ timeout: 20_000 });
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
    await expect(ideaRow(page)).toBeVisible({ timeout: 20_000 });
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
