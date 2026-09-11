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
 * or read-after-write on the deployed Worker. The latency numbers themselves come from the
 * warm keep-alive measurement recorded in the PR; a browser navigation is the wrong instrument
 * for that (it bundles TLS, a lazy route chunk, and render time), which is why this file asserts
 * on FRESHNESS and CORRECTNESS and leaves timing to the measurement script.
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
test.describe.configure({ timeout: 120_000 });

async function openApp(page: Page, path: string): Promise<void> {
  await page.goto(`${STAGING_APP}${path}`, { waitUntil: 'domcontentloaded' });
  await dismissStagingOnboarding(page);
}

/** First project the smoke user can see, via the API the UI itself uses. */
async function firstProjectId(page: Page): Promise<string> {
  const res = await page.request.get(`${STAGING_API}/api/projects`);
  expect(res.status(), `GET /api/projects failed: ${await res.text()}`).toBe(200);
  const body = (await res.json()) as { projects?: { id: string; name: string }[] };
  const projects = body.projects ?? [];
  expect(projects.length, 'smoke user has no projects to verify against').toBeGreaterThan(0);
  return projects[0]!.id;
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

    const projectId = await firstProjectId(page);

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
    const projectId = await firstProjectId(page);

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

    await openApp(page, '/');
    await expect(page.locator('body')).toBeVisible();
    await stagingShot(page, 'api-latency-dashboard');

    const projectId = await firstProjectId(page);

    await openApp(page, `/projects/${projectId}`);
    await expect(page.locator('body')).toBeVisible();
    await stagingShot(page, 'api-latency-project');

    await openApp(page, `/projects/${projectId}/tasks`);
    await expect(page.locator('body')).toBeVisible();
    await stagingShot(page, 'api-latency-tasks');

    await openApp(page, '/settings');
    await expect(page.locator('body')).toBeVisible();
    await stagingShot(page, 'api-latency-settings');

    // No horizontal overflow — this PR changes no UI, so any overflow here would be a
    // pre-existing issue, but asserting it keeps the regression check honest.
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
