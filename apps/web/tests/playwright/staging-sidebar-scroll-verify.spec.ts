/**
 * Staging verification for the project-sidebar scroll fix (rule 13 / rule 30).
 *
 * Exercises the REAL deployed app at app.sammy.party with a real logged-in user
 * and real project data — the fix must work as an end user experiences it, not
 * merely render. Assertions are measured coordinates (rule 17), and the
 * reachability check ends by CLICKING the previously-unreachable item.
 */
import { expect, type Page, test } from '@playwright/test';

import { assertNoVerticalClipping } from './audit-helpers';
import {
  dismissStagingOnboarding,
  STAGING_API,
  STAGING_APP,
  stagingLogin,
  stagingShot,
} from './staging-helpers';

const PROJECT_NAV = 'nav[aria-label="Project navigation"]';
const GLOBAL_NAV = 'nav[aria-label="Primary navigation"]';
/** Last entry of PROJECT_NAV_ITEMS — the first thing to fall off the bottom. */
const LAST_PROJECT_ITEM = 'Settings';

/**
 * Per-worker cache for the two facts every test here needs.
 *
 * Resolving them per test hammered rate-limited endpoints and was the direct
 * cause of an intermittent failure: roughly one run in three, some test timed out
 * waiting for the sidebar while Playwright's page snapshot showed the app parked
 * on `status "Verifying your session"` — the auth bootstrap, not the sidebar.
 * `stagingLogin` already caches its cookie per worker for exactly this reason
 * ("token-login is rate limited per principal and every test gets a fresh
 * context"); these two lookups need the same treatment. One resolution per worker
 * instead of five.
 */
let cachedUserId: string | null = null;
let cachedProjects: Array<{ id: string; name: string }> | null = null;

async function resolveUserId(page: Page): Promise<string> {
  if (cachedUserId) return cachedUserId;
  const res = await page.request.get(`${STAGING_API}/api/auth/get-session`);
  const userId = (await res.json().catch(() => null))?.user?.id as string | undefined;
  expect(userId, `could not resolve the staging user id (status ${res.status()})`).toBeTruthy();
  cachedUserId = userId as string;
  return cachedUserId;
}

async function resolveProjects(page: Page): Promise<Array<{ id: string; name: string }>> {
  if (cachedProjects) return cachedProjects;
  const res = await page.request.get(`${STAGING_API}/api/projects`);
  expect(res.status(), 'GET /api/projects must succeed').toBe(200);
  const projects = (await res.json())?.projects as Array<{ id: string; name: string }>;
  expect(projects?.length, 'staging user must have at least one project').toBeGreaterThan(0);
  cachedProjects = projects;
  return projects;
}

/**
 * Suppress the first-run cloud wizard before the page paints.
 *
 * The wizard (`ChoosePathWizard`, `role="dialog"` / `aria-label="Account setup"`)
 * is an `inset-0 z-50` overlay that SWALLOWS CLICKS. `dismissStagingOnboarding`
 * probes for it for only 2s by design, and over a real network the dialog
 * reliably mounted AFTER that window — so the probe returned "absent" and the
 * modal then covered the page, failing every test in this file on its first run.
 * Pre-seeding the same flag the "Exit setup" button writes
 * (`OnboardingContext.tsx:41`) is the deterministic equivalent, with no race.
 *
 * Its presence is NOT a product blocker: staging has an enabled platform cloud
 * credential, so a smoke user without their own cloud credential is expected
 * (CLAUDE.md, Architecture Principle 1).
 */
async function suppressOnboarding(page: Page): Promise<void> {
  const userId = await resolveUserId(page);
  await page.addInitScript((id) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${id}`, 'true');
  }, userId);
}

/**
 * Open a real project by id.
 *
 * Deliberately resolves the id from the API and navigates by URL rather than
 * clicking a card on `/projects`: project cards are NOT anchors, so an
 * `a[href^="/projects/"]` locator matches only the sidebar nav and finds no
 * project (the first version of this spec failed all five tests on exactly that).
 * Navigating to the route is also how a user arrives here from a bookmark.
 */
async function openFirstProject(page: Page): Promise<string> {
  const id = (await resolveProjects(page))[0].id;

  await page.goto(`${STAGING_APP}/projects/${id}/chat`);
  await dismissStagingOnboarding(page);
  /*
   * Generous budget because this waits on staging's auth bootstrap, not on the
   * sidebar: the API is measurably slow (Worker in CDG, D1 in DFW, ~100-300ms per
   * round trip), so a cold "Verifying your session" can outlast a tight timeout
   * and read as "the sidebar is broken" when it is nothing of the sort.
   */
  await page.locator(`${PROJECT_NAV} a`).first().waitFor({ state: 'visible', timeout: 60_000 });
  // The wizard must not be covering the surface under test.
  await expect(page.getByTestId('onboarding-wizard')).toHaveCount(0);
  return id;
}

test.describe('STAGING — project sidebar scroll (1280x600, the reported laptop)', () => {
  test.use({ viewport: { width: 1280, height: 600 }, isMobile: false, hasTouch: false });
  test.setTimeout(120_000);

  test('the previously unreachable bottom nav item is reachable and clickable', async ({
    page,
  }) => {
    await stagingLogin(page);
    await suppressOnboarding(page);
    const projectId = await openFirstProject(page);

    const nav = page.locator(PROJECT_NAV);
    const lastItem = nav.getByRole('link', { name: LAST_PROJECT_ITEM, exact: true });

    const before = await nav.evaluate((el: HTMLElement) => ({
      top: el.getBoundingClientRect().top,
      bottom: el.getBoundingClientRect().bottom,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));

    // Precondition: the deployed nav really is taller than its box at this
    // height. Without this the reachability assertion could pass vacuously.
    expect(
      before.scrollHeight,
      'the deployed nav must overflow at 600px, else this proves nothing'
    ).toBeGreaterThan(before.clientHeight + 1);
    // The fix, as deployed: the nav is a scroll container.
    expect(before.overflowY, 'deployed nav must be a scroll container').toMatch(/auto|scroll/);

    // Precondition: the item starts below the fold — the exact state that was
    // unrecoverable before this change.
    const lastBefore = await lastItem.boundingBox();
    expect(lastBefore).not.toBeNull();
    expect(lastBefore!.y + lastBefore!.height).toBeGreaterThan(before.bottom);

    await lastItem.scrollIntoViewIfNeeded();
    await stagingShot(page, 'staging-sidebar-scrolled-to-bottom');

    const after = await nav.evaluate((el: HTMLElement) => ({
      top: el.getBoundingClientRect().top,
      bottom: el.getBoundingClientRect().bottom,
      scrollTop: el.scrollTop,
    }));
    expect(after.scrollTop, 'scrolling must actually move the deployed nav').toBeGreaterThan(0);

    const lastAfter = await lastItem.boundingBox();
    expect(lastAfter!.y).toBeGreaterThanOrEqual(after.top - 1);
    expect(lastAfter!.y + lastAfter!.height).toBeLessThanOrEqual(after.bottom + 1);
    expect(lastAfter!.y + lastAfter!.height).toBeLessThanOrEqual(600);

    // The user outcome, not just the layout: the link works.
    await lastItem.click();
    await page.waitForURL(`**/projects/${projectId}/settings`, { timeout: 30_000 });
    await dismissStagingOnboarding(page);
    await expect(page.getByRole('heading', { name: /Project Settings/i })).toBeVisible({
      timeout: 30_000,
    });
    await stagingShot(page, 'staging-sidebar-settings-reached');
  });

  test('sidebar chrome stays pinned while the nav scrolls', async ({ page }) => {
    await stagingLogin(page);
    await suppressOnboarding(page);
    await openFirstProject(page);

    const signOut = page.getByRole('button', { name: 'Sign out' });
    const signOutBefore = await signOut.boundingBox();
    expect(signOutBefore).not.toBeNull();
    expect(signOutBefore!.y + signOutBefore!.height).toBeLessThanOrEqual(600);

    await page.locator(PROJECT_NAV).evaluate((el: HTMLElement) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(300);

    const signOutAfter = await signOut.boundingBox();
    expect(signOutAfter!.y).toBeCloseTo(signOutBefore!.y, 0);
    await stagingShot(page, 'staging-sidebar-chrome-pinned');
  });

  test('no ancestor clips the deployed nav vertically', async ({ page }) => {
    await stagingLogin(page);
    await suppressOnboarding(page);
    await openFirstProject(page);

    // Positive-render control beside the absence assertion: a crashed page or an
    // unmounted nav would also satisfy "nothing is clipped".
    await expect(
      page.locator(PROJECT_NAV).getByRole('link', { name: 'Chat', exact: true })
    ).toBeVisible();

    await assertNoVerticalClipping(page, PROJECT_NAV);
  });

  test('core flows still work — dashboard, projects, settings', async ({ page }) => {
    await stagingLogin(page);
    await suppressOnboarding(page);

    const projectName = (await resolveProjects(page))[0].name;

    await page.goto(`${STAGING_APP}/dashboard`);
    await dismissStagingOnboarding(page);
    await expect(page.locator(`${GLOBAL_NAV} a`).first()).toBeVisible({ timeout: 30_000 });
    await stagingShot(page, 'staging-dashboard');

    await page.goto(`${STAGING_APP}/projects`);
    await dismissStagingOnboarding(page);
    /*
     * Assert on something a USER can see. The obvious `heading "Projects"` is an
     * `sr-only` h1 with a 1x1 box — it proves the route mounted and nothing else,
     * and it flaked once here for that reason. The New Project control plus a real
     * project card together prove the page actually rendered its data.
     */
    await expect(page.getByRole('button', { name: /New Project/i })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(projectName, { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await stagingShot(page, 'staging-projects');

    await page.goto(`${STAGING_APP}/settings`);
    await dismissStagingOnboarding(page);
    await expect(page.locator(`${GLOBAL_NAV} a`).first()).toBeVisible({ timeout: 30_000 });
    await stagingShot(page, 'staging-settings');

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth
    );
    expect(overflow).toBe(false);
  });
});

test.describe('STAGING — mobile drawer unaffected (375x667)', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  test.setTimeout(120_000);

  test('mobile nav still reaches its last item', async ({ page }) => {
    await stagingLogin(page);
    await suppressOnboarding(page);
    const id = (await resolveProjects(page))[0].id;
    await page.goto(`${STAGING_APP}/projects/${id}/chat`);
    await dismissStagingOnboarding(page);

    const burger = page.getByRole('button', { name: 'Open navigation menu' });
    await burger.waitFor({ state: 'visible', timeout: 30_000 });
    // NavSidebar must not render below the mobile breakpoint.
    await expect(page.locator(PROJECT_NAV)).toHaveCount(0);

    await burger.click();
    await page.waitForTimeout(400);
    const panel = page.getByTestId('mobile-nav-panel');
    const lastItem = panel.getByRole('button', { name: LAST_PROJECT_ITEM, exact: true });
    await lastItem.scrollIntoViewIfNeeded();
    const box = await lastItem.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(667);
    await stagingShot(page, 'staging-mobile-drawer');
  });
});
