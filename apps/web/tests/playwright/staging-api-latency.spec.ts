/**
 * STAGING verification for request-scoped D1 sessions + one-auth-pass-per-request — not part
 * of the CI suite.
 *
 * Run explicitly against the deployed staging app:
 *   PLAYWRIGHT_BASE_URL=https://app.sammy.party npx playwright test staging-api-latency \
 *     --project="iPhone SE (375x667)" --project="Desktop (1280x800)"
 *
 * What this proves, and what it does NOT:
 *
 * The change is invisible in the UI by design — it must not alter a single rendered byte. So
 * the interesting assertions are (a) the routes that got slower-to-load still load, with real
 * data, through a real browser, and (b) the request-scoped session did not break authentication
 * or read-after-write on the deployed Worker. Latency numbers come from the warm keep-alive
 * measurement recorded in the PR; a browser navigation is the wrong instrument for that (it
 * bundles TLS, a lazy route chunk, and render time), which is why this file asserts on
 * FRESHNESS and CORRECTNESS and leaves timing to the measurement script.
 *
 * `.claude/rules/13` — token-login against the staging API, then drive the real app.
 */
import { expect, type Page, test } from '@playwright/test';

import {
  dismissStagingOnboarding,
  STAGING_API,
  STAGING_APP,
  stagingLogin,
  stagingShot,
} from './staging-helpers';

/*
 * This file talks to real staging, so it must never run in the normal CI sweep — CI has no
 * smoke token and would either fail or mutate the shared environment. The token's absence is
 * the gate.
 */
test.skip(
  !process.env.SAM_PLAYWRIGHT_PRIMARY_USER,
  'Staging-only: requires SAM_PLAYWRIGHT_PRIMARY_USER'
);

/* See staging-tool-rail-verify.spec.ts: the 30s project default is smaller than login +
 * cross-Atlantic navigation + a lazy route chunk, so a test would exhaust its budget waiting
 * for the page and report the FEATURE as missing. */
test.describe.configure({ timeout: 180_000 });

/**
 * Navigate, dismiss the first-run modal, and wait for the route to actually RENDER.
 *
 * The wait is the point. `App.tsx` wraps every code-split route in a Suspense boundary whose
 * fallback is `RouteFallback` (`data-testid="route-fallback"`), so the AppShell chrome paints
 * long before the route's own content does. `expect(body).toBeVisible()` is satisfied by that
 * spinner — the first cut of this spec asserted exactly that, passed at both viewports, and
 * its screenshots were a spinner on an otherwise empty page. That is `.claude/rules/62` twice
 * over: an absence assertion with no liveness assertion beside it, and screenshot evidence
 * produced but never opened.
 */
async function renderState(page: Page): Promise<string> {
  /*
   * The first-run wizard is part of the render gate, not a separate step. It renders LATER
   * than `dismissStagingOnboarding`'s 2s probe on some routes (measured: it appeared ~6s into
   * `/settings/cloud-provider`), and its own copy — "Do you have a cloud hosting account?" —
   * is long enough to satisfy a naive text-length check. So a gate that ignores it happily
   * reports "rendered" for a modal covering an empty page, which is the same class of mistake
   * as accepting the Suspense spinner.
   */
  if ((await page.getByRole('dialog', { name: 'Account setup' }).count()) > 0) {
    return 'onboarding-wizard-visible';
  }
  const fallbacks = await page.getByTestId('route-fallback').count();
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
  if (fallbacks === 0 && text.length > MIN_RENDERED_TEXT_LENGTH) return 'rendered';
  return `fallbacks=${fallbacks} textLength=${text.length} text=${text.slice(0, 80)}`;
}

async function openApp(page: Page, path: string): Promise<void> {
  /*
   * Each attempt is a cold SPA boot, and a boot can wedge on AuthProvider's "Verifying your
   * session" gate — a documented staging flake, not a server fault (measured alongside this
   * run: 30/30 `GET /api/auth/me` returned 200, slowest 623 ms, zero `platform_errors` rows in
   * the preceding 30 minutes). One reload clears it. Bounded at two attempts so a genuine
   * failure still fails: a route that never renders twice in a row is a real problem.
   */
  for (let attempt = 1; attempt <= NAVIGATION_ATTEMPTS; attempt += 1) {
    await page.goto(`${STAGING_APP}${path}`, { waitUntil: 'domcontentloaded' });
    await dismissStagingOnboarding(page);

    /*
     * Poll for "no fallback AND substantive content", never a single sample of either.
     *
     * Several routes redirect on entry (`/settings` -> `/settings/cloud-provider`,
     * `/projects/:id` -> `chat`), which unmounts one Suspense boundary and mounts another. A
     * one-shot `toHaveCount(0)` can land in the gap between the two and report "rendered" for
     * a page whose body is just the skip-link and the notification badge — which is exactly
     * how this spec first passed against an empty screen.
     */
    const deadline = Date.now() + RENDER_TIMEOUT_MS;
    let state = await renderState(page);
    while (state !== 'rendered' && Date.now() < deadline) {
      // The wizard can mount after the initial dismiss probe, so dismiss it whenever it shows.
      if (state === 'onboarding-wizard-visible') await dismissStagingOnboarding(page);
      await page.waitForTimeout(500);
      state = await renderState(page);
    }
    if (state === 'rendered') return;

    if (attempt === NAVIGATION_ATTEMPTS) {
      throw new Error(`${path} never rendered after ${NAVIGATION_ATTEMPTS} attempts: ${state}`);
    }
  }
}

/**
 * Longer than the AppShell chrome alone. An unrendered route's body is just the skip link and
 * the notification badge ("Skip to content24"), ~20 characters.
 */
const MIN_RENDERED_TEXT_LENGTH = 80;

/** Per-attempt render budget, and how many cold boots a route gets before it is a failure. */
const RENDER_TIMEOUT_MS = 45_000;
const NAVIGATION_ATTEMPTS = 2;

/** Assert the route rendered real content, not chrome wrapped around an empty slot. */
async function expectRendered(page: Page, expected: RegExp): Promise<void> {
  await expect(page.locator('body')).toContainText(expected, { timeout: 30_000 });
}

/** First project the smoke user can see, via the API the UI itself uses. */
async function firstProject(page: Page): Promise<{ id: string; name: string }> {
  const res = await page.request.get(`${STAGING_API}/api/projects`);
  expect(res.status(), `GET /api/projects failed: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { projects?: { id: string; name: string }[] };
  const projects = body.projects ?? [];
  expect(projects.length, 'smoke user has no projects to verify against').toBeGreaterThan(0);
  return { id: projects[0]!.id, name: projects[0]!.name };
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe('staging: request-scoped D1 sessions do not change what the API returns', () => {
  test('authenticated reads still work across the project routes', async ({ page }) => {
    await stagingLogin(page);

    // Every route below now runs against ONE D1 session anchored `first-primary`. If the
    // session facade had broken the binding, these would 500 rather than 200.
    const me = await page.request.get(`${STAGING_API}/api/auth/me`);
    expect(me.status(), await me.text()).toBe(200);
    const user = (await me.json()) as { id: string; email: string };
    expect(user.id).toBeTruthy();

    const { id: projectId } = await firstProject(page);

    const tasks = await page.request.get(`${STAGING_API}/api/projects/${projectId}/tasks`);
    expect(tasks.status(), await tasks.text()).toBe(200);
    expect((await tasks.json()) as { tasks: unknown[] }).toHaveProperty('tasks');

    const sessions = await page.request.get(`${STAGING_API}/api/projects/${projectId}/sessions`);
    expect(sessions.status(), await sessions.text()).toBe(200);
    const sessionList = (await sessions.json()) as { sessions?: { id: string }[] };
    expect(Array.isArray(sessionList.sessions)).toBe(true);

    if (sessionList.sessions?.length) {
      const detail = await page.request.get(
        `${STAGING_API}/api/projects/${projectId}/sessions/${sessionList.sessions[0]!.id}`
      );
      expect(detail.status(), await detail.text()).toBe(200);
    }
  });

  test('a write is visible to the very next read (read-after-write through the replica path)', async ({
    page,
  }) => {
    await stagingLogin(page);
    const { id: projectId } = await firstProject(page);

    // The one assertion that actually exercises the risk this change carries: create a row on
    // the primary, then read the list back in a SEPARATE request whose session may be served by
    // a replica. `first-primary` makes that request's snapshot at least as fresh as its own
    // start, so the row must be there. A bookmark-anchored read is exactly what could fail here.
    const title = `staging-d1-session-verify ${new Date().toISOString()}`;
    const created = await page.request.post(`${STAGING_API}/api/projects/${projectId}/tasks`, {
      data: { title },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const task = (await created.json()) as { id: string; title: string };
    expect(task.title).toBe(title);

    try {
      const listed = await page.request.get(
        `${STAGING_API}/api/projects/${projectId}/tasks?limit=100`
      );
      expect(listed.status(), await listed.text()).toBe(200);
      const body = (await listed.json()) as { tasks: { id: string }[] };
      expect(
        body.tasks.map((row) => row.id),
        'a task created a moment ago was missing from the next list read'
      ).toContain(task.id);

      const detail = await page.request.get(
        `${STAGING_API}/api/projects/${projectId}/tasks/${task.id}`
      );
      expect(detail.status(), await detail.text()).toBe(200);
    } finally {
      // Clean up the resource this verification created (`.claude/rules/13`).
      const deleted = await page.request.delete(
        `${STAGING_API}/api/projects/${projectId}/tasks/${task.id}`
      );
      expect([200, 204]).toContain(deleted.status());
    }
  });

  test('the app still renders the routes this change touched', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await stagingLogin(page);
    const { id: projectId, name: projectName } = await firstProject(page);

    /*
     * Real routes, read off App.tsx. `/projects/:id` redirects to `chat` and
     * `/projects/:id/tasks` redirects to `../ideas`; the first cut of this spec navigated to
     * paths that only ever resolved through a redirect, which is why its screenshot showed
     * the sidebar highlighting "Ideas" under a `/tasks` URL.
     */
    await openApp(page, '/projects');
    await expectRendered(page, new RegExp(escapeForRegExp(projectName), 'i'));
    await stagingShot(page, 'api-latency-projects');

    /*
     * Assert on each route's OWN content, never on shared chrome, and never on one matcher
     * reused across routes. Two ways that went wrong here, both of which reported a failure
     * for a page that had rendered perfectly at 375px:
     *
     *  - "Back to Projects" lives in the AppShell sidebar, which sits behind a hamburger at
     *    375px, so asserting it made the test desktop-only.
     *  - The project name is rendered in the chat header but NOT on the ideas route, whose
     *    mobile body is exactly "Ideas / 0 ideas being refined / Ideas emerge from your
     *    conversations." A project-name matcher there fails on a correct page.
     *
     * A per-route matcher is also what makes the gate route-aware: `renderState` only knows
     * "substantive text is on screen", so the previous route's content could otherwise
     * satisfy it during a navigation.
     */
    await openApp(page, `/projects/${projectId}/chat`);
    await expectRendered(page, new RegExp(escapeForRegExp(projectName), 'i'));
    await stagingShot(page, 'api-latency-project-chat');

    await openApp(page, `/projects/${projectId}/ideas`);
    await expectRendered(page, /Ideas/i);
    await stagingShot(page, 'api-latency-project-ideas');

    // `/settings` redirects to `/settings/cloud-provider`; navigate to the resolved route.
    await openApp(page, '/settings/cloud-provider');
    await expectRendered(page, /Cloud Provider|Settings/i);
    await stagingShot(page, 'api-latency-settings');

    // No horizontal overflow. This PR changes no UI, so an overflow here would be
    // pre-existing — asserting it keeps the regression check honest.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(overflow).toBe(false);

    // A 401/500 storm caused by a broken session facade would surface here.
    const relevant = consoleErrors.filter(
      (text) => !/favicon|ResizeObserver|Download the React DevTools/i.test(text)
    );
    expect(relevant, `console errors on staging: ${relevant.join(' | ')}`).toEqual([]);
  });
});
