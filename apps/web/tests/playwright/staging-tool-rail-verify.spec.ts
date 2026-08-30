/**
 * STAGING verification for the session tool rail — not part of the CI suite.
 *
 * Run explicitly against the deployed staging app:
 *   PLAYWRIGHT_BASE_URL=https://app.sammy.party npx playwright test staging-tool-rail-verify \
 *     --project="iPhone SE (375x667)" --project="Desktop (1280x800)"
 *
 * Authenticates the browser context via the staging token-login endpoint per
 * `.claude/rules/13-staging-verification.md`, then drives the real rail against real
 * data — no mocks anywhere in this file.
 */
import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const STAGING_API = 'https://api.sammy.party';
const STAGING_APP = 'https://app.sammy.party';

/**
 * This file talks to real staging, so it must never run in the normal CI sweep — CI has
 * no smoke token and would either fail or, worse, mutate the shared environment. The
 * token's absence is the gate.
 */
test.skip(
  !process.env.SAM_PLAYWRIGHT_PRIMARY_USER,
  'Staging-only: requires SAM_PLAYWRIGHT_PRIMARY_USER'
);

/**
 * Cookies from the one token-login this file performs.
 *
 * `token-login` is rate limited per principal, and every test gets a fresh browser
 * context — logging in per test trips `RATE_LIMIT_EXCEEDED` and fails the run for a
 * reason that has nothing to do with the code under test. Log in once per worker and
 * replay the session cookie into each context instead.
 */
type StoredCookies = Awaited<ReturnType<BrowserContext['storageState']>>['cookies'];
let cachedCookies: StoredCookies | null = null;

async function login(page: Page) {
  if (cachedCookies) {
    await page.context().addCookies(cachedCookies);
    return;
  }

  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  const res = await page.request.post(`${STAGING_API}/api/auth/token-login`, {
    data: { token },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.status(), `token-login failed: ${await res.text()}`).toBe(200);

  cachedCookies = (await page.context().storageState()).cookies;
}

/** Opens the most recent chat session that has messages, or skips if none exist. */
async function openMostRecentSession(page: Page): Promise<boolean> {
  const res = await page.request.get(`${STAGING_API}/api/chats?limit=20`);
  if (res.status() !== 200) return false;
  const body = (await res.json()) as {
    sessions?: Array<{ id: string; projectId?: string; messageCount?: number }>;
  };
  const session = body.sessions?.find((s) => s.projectId && (s.messageCount ?? 0) > 0);
  if (!session?.projectId) return false;

  await page.goto(`${STAGING_APP}/projects/${session.projectId}/chat/${session.id}`);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  return true;
}

async function shot(page: Page, name: string) {
  const w = page.viewportSize()?.width ?? 0;
  await page.waitForTimeout(800);
  await page.screenshot({
    path: `../../.codex/tmp/staging-screenshots/${name}-${w}.png`,
    fullPage: false,
  });
}

test.describe('Staging — session tool rail', () => {
  test('rail renders and every control is reachable on a real session', async ({ page }) => {
    await login(page);
    const opened = await openMostRecentSession(page);
    test.skip(!opened, 'No staging chat session with messages available');

    // The rail must be present on first paint with no disclosure opened.
    const details = page.getByTestId('session-tool-details');
    await expect(details).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('session-tool-rail')).toBeVisible();

    // Pinned controls must be genuinely on screen, not just in the DOM.
    const viewportHeight = page.viewportSize()?.height ?? 0;
    for (const id of ['complete', 'details']) {
      const tool = page.getByTestId(`session-tool-${id}`);
      if ((await tool.count()) === 0) continue; // Complete is absent on terminal tasks.
      await expect(tool).toBeInViewport();
      const box = await tool.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight);
    }

    await shot(page, 'staging-rail-icons');
  });

  test('cycling the strip works against real data', async ({ page }) => {
    await login(page);
    const opened = await openMostRecentSession(page);
    test.skip(!opened, 'No staging chat session with messages available');

    const rail = page.getByTestId('session-tool-rail');
    await expect(rail).toBeVisible({ timeout: 30_000 });
    await expect(rail).toHaveAttribute('data-mode', 'icons');

    await page.getByTestId('session-tool-rail-cycle').click();
    await expect(page.getByTestId('session-tool-rail')).toHaveAttribute('data-mode', 'labels');
    await shot(page, 'staging-rail-labels');

    await page.getByTestId('session-tool-rail-cycle').click();
    await expect(page.getByTestId('session-tool-rail-tab')).toBeVisible();
    await shot(page, 'staging-rail-hidden');

    await page.getByTestId('session-tool-rail-tab').click();
    await expect(page.getByTestId('session-tool-rail')).toHaveAttribute('data-mode', 'icons');
  });

  test('Details opens the real session-details panel', async ({ page }) => {
    await login(page);
    const opened = await openMostRecentSession(page);
    test.skip(!opened, 'No staging chat session with messages available');

    const details = page.getByTestId('session-tool-details');
    await expect(details).toBeVisible({ timeout: 30_000 });
    await details.click();
    await expect(page.getByText('References')).toBeVisible({ timeout: 10_000 });

    // The rail must survive the header growing — the failure mode this layout was
    // restructured to prevent.
    const box = await page.getByTestId('session-tool-rail').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeLessThan((page.viewportSize()?.height ?? 0) * 0.6);
    await shot(page, 'staging-rail-details-open');
  });

  test('Timeline opens the real timeline drawer', async ({ page }) => {
    await login(page);
    const opened = await openMostRecentSession(page);
    test.skip(!opened, 'No staging chat session with messages available');

    const timeline = page.getByTestId('session-tool-timeline');
    await expect(timeline).toBeVisible({ timeout: 30_000 });
    await timeline.click();
    await expect(page.getByRole('dialog', { name: 'Session timeline' })).toBeVisible({
      timeout: 15_000,
    });
    await shot(page, 'staging-rail-timeline');
  });

  test('no console errors while driving the rail', async ({ page }) => {
    const errors: string[] = [];
    // Chromium's console text for a failed request is just "Failed to load resource: the
    // server responded with a status of 404 ()" — useless on its own. Recording the URL
    // alongside it is the difference between an actionable finding and a shrug.
    const failedRequests: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('response', (res) => {
      if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`);
    });

    await login(page);
    const opened = await openMostRecentSession(page);
    test.skip(!opened, 'No staging chat session with messages available');

    await expect(page.getByTestId('session-tool-details')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('session-tool-rail-cycle').click();
    await page.getByTestId('session-tool-details').click();
    await page.waitForTimeout(1500);

    /*
     * A session old enough for its workspace to have been reaped 404s on the workspace
     * fetch at `useSessionLifecycle.ts:407`. That call is byte-identical on `origin/main`
     * (verified by diff), so it is pre-existing and not something the rail introduced.
     *
     * Rather than filter the console text — which is the useless generic "Failed to load
     * resource" and would mask any other 404 — the assertion is made on the REQUEST list,
     * where the path is visible. A 404 on any other endpoint still fails.
     */
    const REAPED_WORKSPACE = /^404 .*\/api\/workspaces\/[^/]+$/;
    const unexpectedRequests = failedRequests.filter((r) => !REAPED_WORKSPACE.test(r));
    expect(unexpectedRequests, 'Unexpected failed requests').toEqual([]);

    // Console errors that are not the generic resource-load message for those requests.
    const unexplained = errors.filter(
      (e) =>
        !/websocket|ws:|analytics|favicon|net::ERR_/i.test(e) && !/Failed to load resource/i.test(e)
    );
    expect(
      unexplained,
      `Console errors:\n${errors.join('\n')}\n\nFailed requests:\n${failedRequests.join('\n')}`
    ).toEqual([]);
  });
});

test.describe('Staging — regression pass', () => {
  test('dashboard, projects and settings still load', async ({ page }) => {
    await login(page);

    for (const [path, marker] of [
      ['/dashboard', /projects/i],
      ['/projects', /projects/i],
      ['/settings', /settings/i],
    ] as const) {
      await page.goto(`${STAGING_APP}${path}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
      // Assert on rendered text, not `textContent`: these pages are lazy-loaded route
      // chunks, and an empty `<body>` while the chunk resolves is indistinguishable from
      // a broken page if you read raw text content.
      await expect
        .poll(() => page.locator('body').innerText(), { timeout: 30_000 })
        .toMatch(marker);
    }
  });
});
