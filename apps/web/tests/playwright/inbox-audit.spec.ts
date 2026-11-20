/**
 * Inbox visual audit (slice C, spec idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9 section 4.1) at 375px and
 * 1280px with stress data: 40 items across 4 projects, a three-line title, a 12-step task, a
 * 10-option question, an expiring permission, the empty inbox, and every item kind opened.
 */
import { expect, type Page, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  assertNoScrollingGlassPanes,
  expectThemePoll,
  screenshot,
  seedTheme,
} from './audit-helpers';
import { type InboxMockState, KIND_ITEMS, MANY_ITEMS, setupInboxMocks } from './inbox-fixtures';

function state(items = MANY_ITEMS, extra: Partial<InboxMockState> = {}): InboxMockState {
  return { items, answered: [], archived: [], ...extra };
}

async function openInbox(page: Page, mock: InboxMockState, path = '/inbox') {
  await setupInboxMocks(page, mock);
  await page.goto(path);
  await expect(page.getByTestId('inbox-page')).toBeVisible();
}

/** The pinned answer area's bottom edge meets its pane: nothing dragged it up or off-screen. */
async function expectControlsPinned(page: Page) {
  const controls = page.getByTestId('inbox-pinned-controls');
  await expect(controls).toBeVisible();
  const box = await controls.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
  const mainOverflow = await page.evaluate(() => {
    const main = document.querySelector('#main-content');
    return main ? main.scrollHeight - main.clientHeight : 0;
  });
  expect(mainOverflow).toBeLessThanOrEqual(1);
}

/**
 * Scrolls the inbox list with the wheel, as a user does, and asserts the content moved while
 * the pane itself did not. The pane's rim and frost are pinned to the pane's own scroll origin,
 * so a pane that scrolls carries them away with the list (the rim's bottom edge then crosses
 * the middle of the list).
 */
async function expectListScrollsInsideFixedPane(page: Page, name: string) {
  const pane = page.getByRole('region', { name: 'Inbox list' });
  await expect(pane).toBeVisible();
  const box = (await pane.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 900);
  const scrollOf = () =>
    pane.evaluate((el) => ({
      pane: el.scrollTop,
      // Whatever scrolled: the pane itself or a scroller inside it.
      any: Math.max(
        el.scrollTop,
        ...Array.from(el.querySelectorAll<HTMLElement>('*')).map((child) => child.scrollTop)
      ),
    }));
  // Liveness: the list did scroll, so the pane staying at 0 is not a list that never moved.
  await expect.poll(async () => (await scrollOf()).any).toBeGreaterThan(100);
  expect((await scrollOf()).pane, 'the pane scrolled, carrying its rim and frost away').toBe(0);
  await assertNoScrollingGlassPanes(page);
  await screenshot(page, name);
}

const KIND_REFS: { name: string; ref: string; project: string }[] = KIND_ITEMS.map((item) => ({
  name:
    String(item.kind) +
    (item.ref === 'ask:q-regions' ? '-ten-options' : item.ref === 'ask:long' ? '-long' : ''),
  ref: item.ref,
  project: item.projectId,
}));

test.describe('Inbox — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });

  test('list with 40 items across 4 projects', async ({ page }) => {
    await openInbox(page, state());
    await expect(
      page.getByRole('button', { name: /Allow running the invoices migration/ })
    ).toBeVisible();
    await expect(page.getByText('3 from')).toBeVisible();
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'inbox-list-many');
  });

  test('list scrolls inside its pane; the rim stays on the pane', async ({ page }) => {
    await openInbox(page, state());
    await expectListScrollsInsideFixedPane(page, 'inbox-list-scrolled');
  });

  test('active chip scrolls into view', async ({ page }) => {
    await openInbox(page, state(), '/inbox?filter=updates');
    const chip = page.getByRole('button', { name: /^Updates/ });
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    const box = await chip.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    await expect(page.getByText('PR #93 opened: tax totals')).toBeVisible();
    await expect(page.getByText('Input needed (an inbox item, not an update)')).toHaveCount(0);
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'inbox-updates');
  });

  test('empty inbox', async ({ page }) => {
    await openInbox(page, state([]));
    await expect(page.getByText('Nothing needs you')).toBeVisible();
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'inbox-empty');
  });

  test('list error state', async ({ page }) => {
    await openInbox(page, state(MANY_ITEMS, { listStatus: 500 }));
    await expect(page.getByText(/Could not load the inbox/)).toBeVisible();
    await screenshot(page, 'inbox-error');
  });

  for (const kind of KIND_REFS) {
    test(`item opened: ${kind.name}`, async ({ page }) => {
      const params = new URLSearchParams({ item: kind.ref, project: kind.project });
      await openInbox(page, state(), `/inbox?${params.toString()}`);
      await expect(page.getByTestId('inbox-item-body')).toBeVisible();
      if (kind.name === 'task') {
        // Nothing to answer yet: no empty control strip (Open chat is in the top bar).
        await expect(page.getByTestId('inbox-pinned-controls')).toHaveCount(0);
      } else {
        await expectControlsPinned(page);
      }
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      await screenshot(page, `inbox-item-${kind.name}`);
    });
  }

  test('answering moves straight to the next item with a receipt', async ({ page }) => {
    const mock = state();
    const params = new URLSearchParams({ item: 'ask:q-vat', project: 'p-billing' });
    await openInbox(page, mock, `/inbox?${params.toString()}`);
    await expect(page.getByTestId('inbox-stack-counter')).toHaveText(/1 of 3 from/);
    await page.getByRole('button', { name: 'Include VAT' }).click();
    await expect(page.getByTestId('inbox-receipt')).toContainText('Sent “Include VAT”');
    await expect(page.getByTestId('inbox-stack-counter')).toHaveText(/1 of 2 from/);
    await expect(
      page.getByRole('heading', { name: 'Add the Stripe live webhook secret' })
    ).toBeVisible();
    expect(mock.answered).toEqual(['ask:q-vat']);
    await screenshot(page, 'inbox-after-answer');
  });

  test('archive shows Undo', async ({ page }) => {
    const params = new URLSearchParams({ item: 'ask:review-1', project: 'p-billing' });
    await openInbox(page, state(), `/inbox?${params.toString()}`);
    await page.getByRole('button', { name: /Archive/ }).click();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'inbox-archive-undo');
  });

  test('project inbox', async ({ page }) => {
    await openInbox(page, state(), '/projects/p-billing/inbox');
    await expect(
      page.getByRole('button', { name: /Allow running the invoices migration/ })
    ).toBeVisible();
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'inbox-project');
  });
});

test.describe('Inbox — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('list beside the first item', async ({ page }) => {
    await openInbox(page, state());
    await expect(
      page.getByRole('heading', { name: 'Allow running the invoices migration on staging' })
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible();
    const list = await page.getByRole('region', { name: 'Inbox list' }).boundingBox();
    const item = await page.getByRole('region', { name: 'Inbox item' }).boundingBox();
    expect(list!.x + list!.width).toBeLessThanOrEqual(item!.x);
    await expectControlsPinned(page);
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'inbox-desktop-list');
  });

  for (const kind of KIND_REFS) {
    test(`item opened: ${kind.name}`, async ({ page }) => {
      const params = new URLSearchParams({ item: kind.ref, project: kind.project });
      await openInbox(page, state(), `/inbox?${params.toString()}`);
      await expect(page.getByTestId('inbox-item-body')).toBeVisible();
      if (kind.name === 'task') {
        // Nothing to answer yet: no empty control strip (Open chat is in the top bar).
        await expect(page.getByTestId('inbox-pinned-controls')).toHaveCount(0);
      } else {
        await expectControlsPinned(page);
      }
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      await screenshot(page, `inbox-desktop-item-${kind.name}`);
    });
  }

  test('list scrolls inside its pane; the rim stays on the pane', async ({ page }) => {
    await openInbox(page, state());
    await expectListScrollsInsideFixedPane(page, 'inbox-desktop-list-scrolled');
  });

  test('the ⋯ menu paints over the panes and opens Archived', async ({ page }) => {
    await openInbox(page, state());
    await page.getByRole('button', { name: 'More filters' }).click();
    const archived = page.getByRole('button', { name: 'Archived', exact: true });
    await expect(archived).toBeVisible();
    // A real click: fails if a pane paints over the menu.
    await archived.click({ trial: true });
    await screenshot(page, 'inbox-desktop-more-menu');
    await archived.click();
    await expect(page.getByRole('button', { name: /^Archived/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  test('header is one row; the purpose sits behind ?', async ({ page }) => {
    await openInbox(page, state(), '/projects/p-billing/inbox');
    const header = page
      .locator('header')
      .filter({ has: page.getByRole('group', { name: 'Inbox filters' }) });
    const title = await page.getByRole('heading', { level: 1, name: 'Inbox' }).boundingBox();
    const help = page.getByRole('button', { name: 'About the inbox' });
    const helpBox = await help.boundingBox();
    const chips = await page.getByRole('group', { name: 'Inbox filters' }).boundingBox();
    const more = await page.getByRole('button', { name: 'More filters' }).boundingBox();
    const headerBox = await header.boundingBox();
    const centre = (b: { y: number; height: number }) => b.y + b.height / 2;
    // Title, ?, chips and ⋯ share one row, left to right.
    for (const box of [helpBox!, chips!, more!]) {
      expect(Math.abs(centre(box) - centre(title!))).toBeLessThanOrEqual(4);
    }
    expect(title!.x + title!.width).toBeLessThanOrEqual(helpBox!.x + 1);
    expect(helpBox!.x + helpBox!.width).toBeLessThanOrEqual(chips!.x + 1);
    expect(chips!.x + chips!.width).toBeLessThanOrEqual(more!.x + 1);
    // ⋯ follows the last chip rather than sitting at the far edge of the row.
    expect(more!.x - (chips!.x + chips!.width)).toBeLessThanOrEqual(12);
    expect(headerBox!.height).toBeLessThanOrEqual(72);
    await expect(page.getByText(/What your agents need from you/)).toHaveCount(0);
    await screenshot(page, 'inbox-desktop-header');

    await help.click();
    const note = page.getByRole('note');
    await expect(note).toHaveText(/What your agents need from you in /);
    // Paints over the panes below: a real hit test at the note's centre lands on the note.
    const noteBox = await note.boundingBox();
    const hit = await page.evaluate(
      ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[role="note"]')),
      { x: noteBox!.x + noteBox!.width / 2, y: noteBox!.y + noteBox!.height / 2 }
    );
    expect(hit).toBe(true);
    await assertNoOverflow(page);
    await screenshot(page, 'inbox-desktop-help-open');
    await page.keyboard.press('Escape');
    await expect(note).toHaveCount(0);
    await expect(help).toBeFocused();
  });

  test('narrow desktop: chips scroll inside the one-row header', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await openInbox(page, state(), '/projects/p-billing/inbox');
    const title = await page.getByRole('heading', { level: 1, name: 'Inbox' }).boundingBox();
    const more = await page.getByRole('button', { name: 'More filters' }).boundingBox();
    expect(
      Math.abs(title!.y + title!.height / 2 - (more!.y + more!.height / 2))
    ).toBeLessThanOrEqual(4);
    expect(more!.x + more!.width).toBeLessThanOrEqual(800);
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'inbox-narrow-desktop-header');
  });

  for (const width of [800, 1024]) {
    test(`from Overview at ${width}px: back is icon-only and the row still holds`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 700 });
      await openInbox(page, state(), '/projects/p-billing/inbox?from=overview');
      const back = page.getByRole('button', { name: 'Back to Overview' });
      await expect(back).toBeVisible();
      const backBox = await back.boundingBox();
      const title = await page.getByRole('heading', { level: 1, name: 'Inbox' }).boundingBox();
      const chips = await page.getByRole('group', { name: 'Inbox filters' }).boundingBox();
      const more = await page.getByRole('button', { name: 'More filters' }).boundingBox();
      const centre = (b: { y: number; height: number }) => b.y + b.height / 2;
      for (const box of [backBox!, chips!, more!]) {
        expect(Math.abs(centre(box) - centre(title!))).toBeLessThanOrEqual(4);
      }
      // Icon-only below lg: the label costs no width there.
      expect(backBox!.width).toBeLessThanOrEqual(width < 1024 ? 44 : 200);
      // At least two whole chips stay visible beside the title.
      expect(chips!.width).toBeGreaterThanOrEqual(180);
      expect(more!.x + more!.width).toBeLessThanOrEqual(width);
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      await screenshot(page, `inbox-from-overview-header-${width}`);
    });
  }

  test('light theme: header and the open ? note', async ({ page }) => {
    await seedTheme(page, 'light');
    await openInbox(page, state(), '/projects/p-billing/inbox');
    await expectThemePoll(page, 'light');
    await page.getByRole('button', { name: 'About the inbox' }).click();
    await expect(page.getByRole('note')).toBeVisible();
    await assertNoOverflow(page);
    await screenshot(page, 'inbox-desktop-help-open-light');
  });

  test('context expanded', async ({ page }) => {
    const params = new URLSearchParams({ item: 'ask:q-vat', project: 'p-billing' });
    await openInbox(page, state(), `/inbox?${params.toString()}`);
    await page.getByRole('button', { name: /Context/ }).click();
    await expect(page.getByText(/Ship the Stripe billing flow/)).toBeVisible();
    await screenshot(page, 'inbox-desktop-context');
  });

  test('empty inbox', async ({ page }) => {
    await openInbox(page, state([]));
    await expect(page.getByText('Nothing needs you')).toBeVisible();
    await assertNoOverflow(page);
    await assertNoClippedOverflow(page);
    await screenshot(page, 'inbox-desktop-empty');
  });

  test('quick view with one-tap answers', async ({ page }) => {
    await setupInboxMocks(page, state());
    await page.goto('/projects/p-billing/ideas');
    await page.getByRole('button', { name: /^Inbox, \d+ need/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Inbox quick view' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Allow once' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Looks good' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Got it' })).toBeVisible();
    // A 10-option question is never one tap.
    await expect(dialog.getByRole('button', { name: 'Falkenstein (fsn1)' })).toHaveCount(0);
    const box = await dialog.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
    expect(box!.y + box!.height).toBeLessThanOrEqual(800);
    await screenshot(page, 'inbox-desktop-quick-view');
    await dialog.getByRole('button', { name: 'Got it' }).scrollIntoViewIfNeeded();
    await screenshot(page, 'inbox-desktop-quick-view-result');
  });

  test('nav items show counts', async ({ page }) => {
    await setupInboxMocks(page, state());
    await page.goto('/projects/p-billing/ideas');
    const projectNav = page.getByRole('navigation', { name: 'Project navigation' });
    await expect(projectNav.getByRole('link', { name: /^Inbox, \d+$/ })).toBeVisible();
    await screenshot(page, 'inbox-desktop-nav');
  });
});

/** Point 4px outside the ? button's left edge, vertically centred. */
async function justOutsideHelp(page: Page) {
  const box = await page.getByRole('button', { name: 'About the inbox' }).boundingBox();
  return { x: box!.x - 4, y: box!.y + box!.height / 2 };
}

const hitsHelp = (page: Page, point: { x: number; y: number }) =>
  page.evaluate(
    ({ x, y }) =>
      Boolean(document.elementFromPoint(x, y)?.closest('button[aria-label="About the inbox"]')),
    point
  );

test.describe('Inbox — touch tablet', () => {
  test.use({ viewport: { width: 820, height: 1180 }, isMobile: false, hasTouch: true });

  test('the ? has a 44px touch target around its compact glyph', async ({ page }) => {
    await openInbox(page, state(), '/projects/p-billing/inbox');
    const point = await justOutsideHelp(page);
    expect(await hitsHelp(page, point)).toBe(true);
    await page.touchscreen.tap(point.x, point.y);
    await expect(page.getByRole('note')).toHaveText(/What your agents need from you/);
    await screenshot(page, 'inbox-tablet-help-open');
  });
});

test.describe('Inbox — mouse pointer control', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('with a mouse the ? hit area stays the 32px glyph', async ({ page }) => {
    await openInbox(page, state(), '/projects/p-billing/inbox');
    // Liveness: the button itself is hit at its centre.
    const box = await page.getByRole('button', { name: 'About the inbox' }).boundingBox();
    expect(await hitsHelp(page, { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 })).toBe(
      true
    );
    expect(await hitsHelp(page, await justOutsideHelp(page))).toBe(false);
  });
});
