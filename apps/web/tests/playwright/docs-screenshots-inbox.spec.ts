/**
 * Documentation screenshots for the Inbox guide (slice C), from the real Inbox page and quick
 * view with mocked API data (`inbox-fixtures.ts`, ordinary items only).
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-inbox --project="Desktop (1280x800)"
 */
import { expect, test } from '@playwright/test';

import { docsShot } from './docs-shot';
import { KIND_ITEMS, setupInboxMocks } from './inbox-fixtures';

/** The fictional, readable items (no stress cases) the docs show. */
const DOCS_ITEMS = KIND_ITEMS.filter((item) => item.ref !== 'ask:long');

test.describe('docs: inbox on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('the inbox: list beside the open item', async ({ page }) => {
    await setupInboxMocks(page, { items: DOCS_ITEMS, answered: [], archived: [] });
    await page.goto('/inbox');
    await expect(page.getByRole('button', { name: 'Allow once' })).toBeVisible();
    await docsShot(page, 'inbox-desktop');
  });

  test('the quick view behind the inbox icon', async ({ page }) => {
    await setupInboxMocks(page, { items: DOCS_ITEMS, answered: [], archived: [] });
    await page.goto('/projects/p-billing/ideas');
    await page.getByRole('button', { name: /^Inbox, \d+ need/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Inbox quick view' });
    await expect(dialog.getByRole('button', { name: 'Allow once' })).toBeVisible();
    await docsShot(page, 'inbox-quick-view', dialog);
  });
});

test.describe('docs: inbox on a phone', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });

  test('a question opened full screen', async ({ page }) => {
    await setupInboxMocks(page, { items: DOCS_ITEMS, answered: [], archived: [] });
    const params = new URLSearchParams({ item: 'ask:q-vat', project: 'p-billing' });
    await page.goto(`/inbox?${params.toString()}`);
    await expect(page.getByRole('button', { name: 'Include VAT' })).toBeVisible();
    await docsShot(page, 'inbox-item-mobile');
  });
});
