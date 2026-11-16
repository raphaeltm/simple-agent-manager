/**
 * Inbox visual audit (slice C, spec idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9 section 4.1) at 375px and
 * 1280px with stress data: 40 items across 4 projects, a three-line title, a 12-step task, a
 * 10-option question, an expiring permission, the empty inbox, and every item kind opened.
 */
import { expect, type Page, test } from '@playwright/test';

import { assertNoClippedOverflow, assertNoOverflow, screenshot } from './audit-helpers';
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
      if (kind.name === 'task' || kind.name === 'error') {
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
      if (kind.name === 'task' || kind.name === 'error') {
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
    // A 10-option question is never one tap.
    await expect(dialog.getByRole('button', { name: 'Falkenstein (fsn1)' })).toHaveCount(0);
    const box = await dialog.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(1280);
    expect(box!.y + box!.height).toBeLessThanOrEqual(800);
    await screenshot(page, 'inbox-desktop-quick-view');
  });

  test('nav items show counts', async ({ page }) => {
    await setupInboxMocks(page, state());
    await page.goto('/projects/p-billing/ideas');
    const projectNav = page.getByRole('navigation', { name: 'Project navigation' });
    await expect(projectNav.getByRole('link', { name: /^Inbox, \d+$/ })).toBeVisible();
    await screenshot(page, 'inbox-desktop-nav');
  });
});
