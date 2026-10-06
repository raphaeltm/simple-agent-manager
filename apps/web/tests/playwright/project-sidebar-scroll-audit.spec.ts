/**
 * Regression guard: the desktop project sidebar nav must SCROLL on a short
 * viewport.
 *
 * The bug: `NavSidebar`'s in-project carousel root is `overflow: hidden`, which
 * resolves its automatic minimum size to 0 in the `aside`'s column flex context.
 * It therefore collapsed to the leftover space and clipped the bottom of the
 * 13-item project nav — while the `aside` never overflowed, so its own
 * `overflow-y-auto` never engaged. Nothing scrolled; `Settings` measured at
 * y=695 inside a 340px-tall clipping box on a 600px viewport. Unreachable.
 *
 * Why the existing suite did not catch it: `findClippedOverflow`
 * (audit-helpers.ts) only detects HORIZONTAL clipping. There is no vertical
 * counterpart, so a nav sheared off at the bottom was invisible to every guard.
 * `assertNoVerticalClipping` (audit-helpers.ts) is that counterpart, added by
 * this change so other audits can adopt it.
 *
 * Per rule 17, the spatial claims here are asserted as MEASURED COORDINATES —
 * `toBeVisible()` passes for an element parked 95px below the fold.
 */
import { expect, type Locator, type Page, type Route, test } from '@playwright/test';

import {
  assertNoOverflow,
  assertNoVerticalClipping,
  makeMockUser,
  screenshot,
} from './audit-helpers';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_USER = makeMockUser({
  email: 'shortlaptop@example.com',
  name: 'Ada Lovelace-Montgomery',
  role: 'superadmin',
  sessionId: 'session-sidebar-scroll',
  userId: 'user-sidebar-scroll',
});

const PROJECT = {
  id: 'proj-sidebar-scroll',
  name: 'Payments API',
  repository: 'northwind/payments-api',
  defaultBranch: 'main',
  userId: 'user-sidebar-scroll',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

/** Stress data: long name + 30 projects, so the global panel also overflows. */
const LONG_NAME_PROJECT = {
  ...PROJECT,
  name: 'Northwind Payments API — Ledger, Reconciliation & Settlement Platform',
};

const MANY_PROJECTS = Array.from({ length: 30 }, (_, i) => ({
  ...PROJECT,
  id: `proj-bulk-${i}`,
  name: i % 3 === 0 ? `Project ${i} — an intentionally long name that must truncate` : `Proj ${i}`,
}));

async function setupApiMocks(
  page: Page,
  options: { project?: typeof PROJECT; projects?: (typeof PROJECT)[] } = {}
) {
  const project = options.project ?? PROJECT;
  const projects = options.projects ?? [project];

  await page.addInitScript(() => {
    window.localStorage.setItem('sam-onboarding-wizard-dismissed-user-sidebar-scroll', 'true');
  });

  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.match(/^\/api\/projects\/[^/]+\/sessions/)) {
      return respond(200, { sessions: [], total: 0 });
    }
    if (path.match(/^\/api\/projects\/[^/]+\/tasks/)) {
      return respond(200, { tasks: [], nextCursor: null });
    }
    if (path.match(/^\/api\/projects\/[^/]+\/activity/)) return respond(200, []);
    if (path.match(/^\/api\/projects\/[^/]+\/agent-profiles/)) return respond(200, { items: [] });
    if (path.match(/^\/api\/projects\/[^/]+$/) && route.request().method() === 'GET') {
      return respond(200, project);
    }
    if (path.includes('/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/credentials') return respond(200, []);
    if (path.includes('/credentials/agent')) return respond(200, { credentials: [] });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/github/installations') return respond(200, []);
    if (path === '/api/agents') return respond(200, { agents: [] });
    if (path === '/api/projects') return respond(200, { projects });
    if (path.includes('/runtime-config')) return respond(200, { envVars: [], files: [] });
    return respond(200, {});
  });
}

// ---------------------------------------------------------------------------
// Measurement helpers — coordinates, not `toBeVisible()`
// ---------------------------------------------------------------------------

interface ScrollBox {
  top: number;
  bottom: number;
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  overflowY: string;
}

async function measure(locator: Locator): Promise<ScrollBox> {
  return locator.evaluate((el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      overflowY: getComputedStyle(el).overflowY,
    };
  });
}

/**
 * Deterministic readiness gate. `networkidle` is unreliable here: the sidebar
 * polls the project list on an interval, and CI allows only 15s per test.
 */
async function waitForSidebar(page: Page, selector: string) {
  await page.locator(`${selector} a`).first().waitFor({ state: 'visible' });
  // One frame for the flex layout to settle before coordinates are read.
  await page.waitForTimeout(150);
}

const PROJECT_NAV = 'nav[aria-label="Project navigation"]';
const GLOBAL_NAV = 'nav[aria-label="Primary navigation"]';
/** Last entry of PROJECT_NAV_ITEMS — the first thing to fall off the bottom. */
const LAST_PROJECT_ITEM = 'Settings';

// ---------------------------------------------------------------------------
// Desktop — 1280x600, the "smaller laptop" that reproduced the report
// ---------------------------------------------------------------------------

test.describe('Project sidebar scroll — short laptop (1280x600)', () => {
  test.use({ viewport: { width: 1280, height: 600 }, isMobile: false, hasTouch: false });

  test('every project nav item is reachable and clickable', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto(`/projects/${PROJECT.id}/chat`);
    await waitForSidebar(page, PROJECT_NAV);

    const nav = page.locator(PROJECT_NAV);
    const lastItem = nav.getByRole('link', { name: LAST_PROJECT_ITEM, exact: true });

    // --- Precondition: the fixture really does overflow. Without this the
    // --- assertions below would pass vacuously on a tall viewport.
    const before = await measure(nav);
    expect(
      before.scrollHeight,
      'fixture must overflow the nav container, else this test proves nothing'
    ).toBeGreaterThan(before.clientHeight + 1);

    // --- Precondition: the last item starts out below the visible area. This is
    // --- the exact state the bug left unrecoverable.
    const lastBefore = await lastItem.boundingBox();
    expect(lastBefore).not.toBeNull();
    expect(lastBefore!.y + lastBefore!.height).toBeGreaterThan(before.bottom);

    // --- The fix: the container scrolls, so the item can be brought into view.
    expect(before.overflowY, 'nav must be a scroll container').toMatch(/auto|scroll/);
    await lastItem.scrollIntoViewIfNeeded();

    const after = await measure(nav);
    expect(after.scrollTop, 'scrolling must actually move the nav').toBeGreaterThan(0);

    const lastAfter = await lastItem.boundingBox();
    expect(lastAfter).not.toBeNull();
    // Measured coordinates: the item now sits fully inside its scroll container.
    expect(lastAfter!.y).toBeGreaterThanOrEqual(after.top - 1);
    expect(lastAfter!.y + lastAfter!.height).toBeLessThanOrEqual(after.bottom + 1);
    // ...and inside the viewport, not merely inside a box that is itself offscreen.
    expect(lastAfter!.y + lastAfter!.height).toBeLessThanOrEqual(600);

    // --- The real user outcome: the link actually navigates.
    await lastItem.click();
    await page.waitForURL(`**/projects/${PROJECT.id}/settings`);
    expect(page.url()).toContain(`/projects/${PROJECT.id}/settings`);

    await screenshot(page, 'project-sidebar-scroll-desktop-short-bottom');
  });

  test('no ancestor clips the nav vertically without a scrollbar', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto(`/projects/${PROJECT.id}/chat`);
    await waitForSidebar(page, PROJECT_NAV);

    // Positive-render assertion beside the absence assertion: a crashed page or
    // an unmounted nav would also satisfy "nothing is clipped".
    const nav = page.locator(PROJECT_NAV);
    await expect(nav.getByRole('link', { name: 'Chat', exact: true })).toBeVisible();
    expect(await nav.getByRole('link').count()).toBe(13);

    await assertNoVerticalClipping(page, PROJECT_NAV);
  });

  test('header and user footer stay pinned while the nav scrolls', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto(`/projects/${PROJECT.id}/chat`);
    await waitForSidebar(page, PROJECT_NAV);

    const searchButton = page.getByRole('button', { name: 'Open command palette' });
    const signOutButton = page.getByRole('button', { name: 'Sign out' });

    const searchBefore = await searchButton.boundingBox();
    const signOutBefore = await signOutButton.boundingBox();
    expect(searchBefore).not.toBeNull();
    expect(signOutBefore).not.toBeNull();
    // The footer is inside the viewport to begin with — it is pinned, not
    // scrolled away like it would be if the whole `aside` were the scroller.
    expect(signOutBefore!.y + signOutBefore!.height).toBeLessThanOrEqual(600);

    await page.locator(PROJECT_NAV).evaluate((el: HTMLElement) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(200);

    const searchAfter = await searchButton.boundingBox();
    const signOutAfter = await signOutButton.boundingBox();
    expect(searchAfter!.y).toBeCloseTo(searchBefore!.y, 0);
    expect(signOutAfter!.y).toBeCloseTo(signOutBefore!.y, 0);

    await screenshot(page, 'project-sidebar-scroll-desktop-short-pinned-chrome');
  });

  test('carousel still slides, and the global panel scrolls too', async ({ page }) => {
    await setupApiMocks(page, { project: LONG_NAME_PROJECT, projects: MANY_PROJECTS });
    await page.goto(`/projects/${PROJECT.id}/chat`);
    await waitForSidebar(page, PROJECT_NAV);

    await page.getByRole('button', { name: 'Show global navigation' }).click();
    await page.waitForTimeout(400);

    const globalNav = page.locator(GLOBAL_NAV);
    // The slide happened: the global panel is now over the sidebar column.
    const globalBox = await globalNav.boundingBox();
    expect(globalBox).not.toBeNull();
    expect(globalBox!.x).toBeLessThan(220);

    const settingsLink = globalNav.getByRole('link', { name: 'Settings', exact: true });
    await expect(settingsLink).toBeVisible();

    const before = await measure(globalNav);
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight + 1);
    expect(before.overflowY).toMatch(/auto|scroll/);

    await settingsLink.scrollIntoViewIfNeeded();
    const after = await measure(globalNav);
    const box = await settingsLink.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(after.top - 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(after.bottom + 1);

    await assertNoVerticalClipping(page, GLOBAL_NAV);
    await screenshot(page, 'project-sidebar-scroll-desktop-short-global-panel');

    // Toggling back restores the project panel.
    await page.getByRole('button', { name: /Back to Northwind Payments API/ }).click();
    await page.waitForTimeout(400);
    await expect(
      page.locator(PROJECT_NAV).getByRole('link', { name: 'Chat', exact: true })
    ).toBeVisible();
  });

  test('focus-mode icon rail scrolls to its last item', async ({ page }) => {
    await setupApiMocks(page);
    await page.addInitScript(() => window.localStorage.setItem('sam:focus-mode', 'focus'));
    await page.goto(`/projects/${PROJECT.id}/chat`);
    await waitForSidebar(page, PROJECT_NAV);

    const nav = page.locator(PROJECT_NAV);
    const lastItem = nav.getByRole('link', { name: LAST_PROJECT_ITEM, exact: true });

    const before = await measure(nav);
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight + 1);

    await lastItem.scrollIntoViewIfNeeded();
    const after = await measure(nav);
    const box = await lastItem.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(after.bottom + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(600);

    await assertNoVerticalClipping(page, PROJECT_NAV);
    await screenshot(page, 'project-sidebar-scroll-desktop-short-focus-rail');
  });

  test('global sidebar outside a project scrolls with many projects', async ({ page }) => {
    await setupApiMocks(page, { projects: MANY_PROJECTS });
    await page.goto('/dashboard');
    await waitForSidebar(page, GLOBAL_NAV);

    const nav = page.locator(GLOBAL_NAV);
    await expect(nav.getByRole('link', { name: 'Home', exact: true })).toBeVisible();

    const before = await measure(nav);
    expect(before.scrollHeight).toBeGreaterThan(before.clientHeight + 1);
    expect(before.overflowY).toMatch(/auto|scroll/);

    // The user footer must stay pinned inside the viewport rather than being
    // pushed below the fold by the project list.
    const signOut = page.getByRole('button', { name: 'Sign out' });
    const signOutBox = await signOut.boundingBox();
    expect(signOutBox!.y + signOutBox!.height).toBeLessThanOrEqual(600);

    await assertNoVerticalClipping(page, GLOBAL_NAV);
    await screenshot(page, 'project-sidebar-scroll-desktop-short-global-sidebar');
  });

  test('no horizontal overflow at the short viewport', async ({ page }) => {
    await setupApiMocks(page, { project: LONG_NAME_PROJECT, projects: MANY_PROJECTS });
    await page.goto(`/projects/${PROJECT.id}/chat`);
    await waitForSidebar(page, PROJECT_NAV);

    // Rule 56: goes through the shared helper, which also walks for clipped
    // (horizontally sheared) content that a documentElement check cannot see.
    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Desktop — 1280x800, the standard viewport.
//
// Measured: the 13-item project nav needs 604px, but the sidebar's fixed chrome
// (logo header, command palette, Focus toggle, theme switcher, user footer)
// leaves it only 540px. So the last item was unreachable at the STANDARD desktop
// height too — the report understated the blast radius, it is just far worse on
// a short laptop. This viewport must therefore scroll as well.
// ---------------------------------------------------------------------------

test.describe('Project sidebar scroll — standard desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('last item is reachable by scrolling at the standard height', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto(`/projects/${PROJECT.id}/chat`);
    await waitForSidebar(page, PROJECT_NAV);

    const nav = page.locator(PROJECT_NAV);
    const lastItem = nav.getByRole('link', { name: LAST_PROJECT_ITEM, exact: true });

    const before = await measure(nav);
    expect(
      before.scrollHeight,
      'the 13-item nav still overflows the sidebar at 800px — if this ever stops ' +
        'being true the assertions below go vacuous, so fail loudly instead'
    ).toBeGreaterThan(before.clientHeight + 1);
    expect(before.overflowY).toMatch(/auto|scroll/);

    await lastItem.scrollIntoViewIfNeeded();
    const after = await measure(nav);
    const box = await lastItem.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(after.top - 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(after.bottom + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(800);

    await lastItem.click();
    await page.waitForURL(`**/projects/${PROJECT.id}/settings`);

    await assertNoVerticalClipping(page, PROJECT_NAV);
    await screenshot(page, 'project-sidebar-scroll-desktop-standard');
  });
});

// ---------------------------------------------------------------------------
// Tablet — 768x1024, the narrowest viewport that still renders this sidebar
// (the mobile breakpoint is 767px; below it AppShell swaps in MobileNavDrawer)
// ---------------------------------------------------------------------------

test.describe('Project sidebar scroll — tablet (768x1024)', () => {
  test.use({ viewport: { width: 768, height: 1024 }, isMobile: false, hasTouch: false });

  test('nav renders and nothing is vertically clipped', async ({ page }) => {
    await setupApiMocks(page, { projects: MANY_PROJECTS });
    await page.goto(`/projects/${PROJECT.id}/chat`);
    await waitForSidebar(page, PROJECT_NAV);

    const nav = page.locator(PROJECT_NAV);
    await expect(nav.getByRole('link', { name: 'Chat', exact: true })).toBeVisible();

    const lastItem = nav.getByRole('link', { name: LAST_PROJECT_ITEM, exact: true });
    await lastItem.scrollIntoViewIfNeeded();
    const navBox = await measure(nav);
    const box = await lastItem.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(navBox.bottom + 1);

    await assertNoVerticalClipping(page, PROJECT_NAV);
    await screenshot(page, 'project-sidebar-scroll-tablet');
  });
});

// ---------------------------------------------------------------------------
// Zen peek rail — the SECOND NavSidebar mount (AppShell.tsx:384), inside
// ZenPeekRail's hover panel rather than the `aside`.
//
// Measured: the peek panel is exactly viewport height (`height: 200%` of an
// `h-1/2` wrapper) and is `flex flex-col overflow-hidden`, so it has the same
// collapsing-flex-item problem as the `aside` — the nav's 604px of content
// overflows any viewport shorter than that. 1280x500 is used here rather than
// 600 so the overflow is ~104px and the assertion is solidly discriminating
// instead of hinging on 6px.
// ---------------------------------------------------------------------------

test.describe('Zen peek rail — second NavSidebar mount (1280x500)', () => {
  test.use({ viewport: { width: 1280, height: 500 }, isMobile: false, hasTouch: false });

  test('peek panel nav scrolls to its last item', async ({ page }) => {
    await setupApiMocks(page);
    await page.addInitScript(() => window.localStorage.setItem('sam:focus-mode', 'zen'));
    await page.goto(`/projects/${PROJECT.id}/chat`);

    /*
     * Enter through a real trigger, but the KEYBOARD one rather than hover.
     * `ZenPeekRail` opens on `onFocusCapture` as well as `onMouseEnter`
     * (ZenPeekRail.tsx:44-52), so focusing the seam is a genuine user path, not a
     * test shortcut — and it is the stable one. Hover alone timed out in CI: the
     * panel is held open by `open` state, and a re-render triggered by a late data
     * fetch closes it, after which no `mouseenter` re-fires because the pointer
     * never moved. Focus survives that, because `onMouseLeave` explicitly keeps the
     * panel open while focus lives inside it.
     */
    const seam = page.getByRole('button', { name: /Navigation \(Zen mode\)/ });
    await seam.waitFor({ state: 'visible' });
    await seam.focus();
    await seam.hover();
    await waitForSidebar(page, PROJECT_NAV);

    const nav = page.locator(PROJECT_NAV);
    const lastItem = nav.getByRole('link', { name: LAST_PROJECT_ITEM, exact: true });

    const before = await measure(nav);
    expect(
      before.scrollHeight,
      'the peek panel nav must overflow at 500px, else this proves nothing'
    ).toBeGreaterThan(before.clientHeight + 1);
    expect(before.overflowY).toMatch(/auto|scroll/);

    await lastItem.scrollIntoViewIfNeeded();
    const after = await measure(nav);
    const box = await lastItem.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(after.top - 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(after.bottom + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(500);

    await assertNoVerticalClipping(page, PROJECT_NAV);
    await screenshot(page, 'project-sidebar-scroll-zen-peek');
  });
});

// ---------------------------------------------------------------------------
// Mobile — 375x667. AppShell renders MobileNavDrawer here, not NavSidebar.
// Kept as a no-regression control for the twin carousel in the drawer.
// ---------------------------------------------------------------------------

test.describe('Project nav — mobile drawer (375x667)', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });

  test('drawer nav reaches its last item', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto(`/projects/${PROJECT.id}/chat`);
    const hamburger = page.getByRole('button', { name: 'Open navigation menu' });
    await hamburger.waitFor({ state: 'visible' });

    // The desktop sidebar must NOT be rendered below the mobile breakpoint —
    // paired with the hamburger assertion above so this cannot pass on a blank
    // or crashed page.
    await expect(page.locator(PROJECT_NAV)).toHaveCount(0);

    await hamburger.click();
    await page.waitForTimeout(300);

    const panel = page.getByTestId('mobile-nav-panel');
    const lastItem = panel.getByRole('button', { name: LAST_PROJECT_ITEM, exact: true });
    await lastItem.scrollIntoViewIfNeeded();

    const box = await lastItem.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y + box!.height).toBeLessThanOrEqual(667);

    await screenshot(page, 'project-sidebar-scroll-mobile-drawer');
    await assertNoOverflow(page);
  });
});
