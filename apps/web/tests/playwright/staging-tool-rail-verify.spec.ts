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
import { expect, type Page, test } from '@playwright/test';

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

async function login(page: Page) {
  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  const res = await page.request.post(`${STAGING_API}/api/auth/token-login`, {
    data: { token },
    headers: { 'Content-Type': 'application/json' },
  });
  expect(res.status(), `token-login failed: ${await res.text()}`).toBe(200);
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
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await login(page);
    const opened = await openMostRecentSession(page);
    test.skip(!opened, 'No staging chat session with messages available');

    await expect(page.getByTestId('session-tool-details')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('session-tool-rail-cycle').click();
    await page.getByTestId('session-tool-details').click();
    await page.waitForTimeout(1500);

    // Ignore noise the rail does not own (websocket reconnects, analytics beacons).
    const relevant = errors.filter((e) => !/websocket|ws:|analytics|favicon|net::ERR_/i.test(e));
    expect(relevant, `Console errors:\n${relevant.join('\n')}`).toEqual([]);
  });
});

test.describe('Staging — regression pass', () => {
  test('dashboard, projects and settings still load', async ({ page }) => {
    await login(page);

    for (const [path, marker] of [
      ['/dashboard', /dashboard|projects|welcome/i],
      ['/projects', /projects/i],
      ['/settings', /settings/i],
    ] as const) {
      await page.goto(`${STAGING_APP}${path}`);
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
      await expect(page.locator('body')).toContainText(marker, { timeout: 20_000 });
    }
  });
});
