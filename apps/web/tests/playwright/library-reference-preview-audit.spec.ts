/**
 * Library references open in place: an inbox item's file chips open the Library's viewer over
 * the inbox, at 375px (full screen) and 1280px (an overlay over the page). Stress data: a
 * 160-character filename on a large image, a PDF, an unsupported file type (download only) and
 * a markdown file. Closing returns to the inbox item, with focus back on the chip.
 */
import { deflateSync } from 'node:zlib';

import { expect, type Page, test } from '@playwright/test';

import { assertNoClippedOverflow, assertNoOverflow, screenshot } from './audit-helpers';
import { type InboxMockState, KIND_ITEMS, setupInboxMocks } from './inbox-fixtures';

// The app's service worker would answer the file preview requests itself, past these mocks.
test.use({ serviceWorkers: 'block' });

const PROJECT = 'p-billing';
const LONG_IMAGE_NAME = `${'quarterly-revenue-dashboard-screenshot-with-eu-vat-breakdown-'.repeat(2)}final-v3-approved-by-finance-2026-11-20.png`;

interface MockFile {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  label: string;
}

const FILES: MockFile[] = [
  {
    id: 'f-image',
    filename: LONG_IMAGE_NAME,
    mimeType: 'image/png',
    sizeBytes: 8_400_000,
    label: LONG_IMAGE_NAME,
  },
  {
    id: 'f-pdf',
    filename: 'invoice-2026-11.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 182_000,
    label: 'November invoice (PDF)',
  },
  {
    id: 'f-zip',
    filename: 'staging-db-backup.tar.zst',
    mimeType: 'application/zstd',
    sizeBytes: 1_250_000_000,
    label: 'Staging backup',
  },
  {
    id: 'f-md',
    filename: 'rollout-plan.md',
    mimeType: 'text/markdown',
    sizeBytes: 2_100,
    label: 'Rollout plan',
  },
];

/** A large solid-gradient PNG (2400x1600), built here so the fixture needs no binary file. */
function largePng(width = 2400, height = 1600): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = Math.round((x / width) * 60) + 20;
      row[2 + x * 3] = Math.round((y / height) * 120) + 80;
      row[3 + x * 3] = 90;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 72 700 Td (November invoice) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF'
);

const MARKDOWN = `# Rollout plan\n\n1. Ship to EU customers first.\n2. Watch webhook failures for a day.\n3. Flip production.\n\nSee the [November invoice](/projects/${PROJECT}/library?preview=f-pdf) for totals.\n`;

const ITEM = {
  ...KIND_ITEMS.find((item) => item.ref === 'ask:q-vat')!,
  title: 'Do these billing artifacts look right before I flip production?',
  links: FILES.map((file) => ({ kind: 'file', id: file.id, label: file.label })),
};

async function openItem(page: Page, item = ITEM) {
  const state: InboxMockState = { items: [item], answered: [], archived: [] };
  await setupInboxMocks(page, state);
  // Registered after the inbox mocks, so these take precedence for Library URLs.
  const png = largePng();
  await page.route('**/api/projects/*/library/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const match = path.match(/\/library\/([^/]+)(\/preview|\/download|\/links|\/comments)?$/);
    const file = FILES.find((candidate) => candidate.id === match?.[1]);
    if (!file) return route.fulfill({ status: 404, body: '{}' });
    if (match?.[2] === '/preview') {
      if (file.id === 'f-image') return route.fulfill({ body: png, contentType: 'image/png' });
      if (file.id === 'f-pdf') return route.fulfill({ body: PDF, contentType: 'application/pdf' });
      if (file.id === 'f-md')
        return route.fulfill({ body: MARKDOWN, contentType: 'text/markdown' });
      return route.fulfill({ status: 415, body: '{}' });
    }
    if (match?.[2] === '/links' || match?.[2] === '/comments')
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        file: {
          ...file,
          projectId: PROJECT,
          directory: '/billing/',
          description: null,
          uploadedBy: 'user-1',
          uploadSource: 'agent',
          uploadSessionId: null,
          uploadTaskId: null,
          replacedAt: null,
          replacedBy: null,
          status: 'ready',
          extractedTextPreview: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        tags: [],
      }),
    });
  });
  const params = new URLSearchParams({ item: ITEM.ref, project: PROJECT });
  await page.goto(`/inbox?${params.toString()}`);
  await expect(page.getByRole('heading', { name: item.title })).toBeVisible();
}

async function openChip(page: Page, file: MockFile) {
  const chip = page.getByRole('link', { name: file.label.slice(0, 30) });
  await chip.click();
  const dialog = page.getByRole('dialog', { name: file.filename });
  await expect(dialog).toBeVisible();
  // The URL never became the Library.
  expect(new URL(page.url()).pathname).toBe('/inbox');
  return { chip, dialog };
}

async function expectDialogInViewport(page: Page) {
  const box = await page.getByRole('dialog').boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
  // Every header control is a 44px target and on screen.
  for (const name of ['Open in Library', 'Close preview']) {
    const control = await page.getByRole('button', { name }).boundingBox();
    expect(control!.height).toBeGreaterThanOrEqual(44);
    expect(control!.x + control!.width).toBeLessThanOrEqual(viewport.width + 1);
  }
}

for (const viewport of [
  { label: 'Mobile', size: { width: 375, height: 667 }, touch: true },
  { label: 'Desktop', size: { width: 1280, height: 800 }, touch: false },
]) {
  test.describe(`Library reference preview — ${viewport.label}`, () => {
    test.use({ viewport: viewport.size, isMobile: viewport.touch, hasTouch: viewport.touch });

    test('large image with a long filename opens over the inbox and closes back to it', async ({
      page,
    }) => {
      await openItem(page);
      const { chip, dialog } = await openChip(page, FILES[0]!);
      await expect(dialog.locator('img')).toBeVisible();
      await expectDialogInViewport(page);
      // Desktop floats the viewer in a live glass overlay over the page; phones keep a screen.
      const root = page.getByTestId('library-preview-root');
      if (viewport.touch) {
        await expect(root).toHaveAttribute('data-presentation', 'screen');
      } else {
        await expect(root).toHaveAttribute('data-presentation', 'overlay');
        await expect(dialog).toHaveClass(/sam-glass-live/);
      }
      await assertNoOverflow(page);
      await screenshot(page, 'library-ref-preview-image-long-name');

      await page.getByRole('button', { name: 'Close preview' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(chip).toBeFocused();
      await expect(page.getByRole('heading', { name: ITEM.title })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/inbox');
    });

    test('PDF', async ({ page }) => {
      await openItem(page);
      await openChip(page, FILES[1]!);
      await expectDialogInViewport(page);
      await assertNoOverflow(page);
      await screenshot(page, 'library-ref-preview-pdf');
    });

    test('unsupported file type offers a download', async ({ page }) => {
      await openItem(page);
      const { dialog } = await openChip(page, FILES[2]!);
      await expect(dialog.getByRole('button', { name: /Download/ }).first()).toBeVisible();
      await expectDialogInViewport(page);
      await assertNoOverflow(page);
      await screenshot(page, 'library-ref-preview-unsupported');
    });

    test('markdown, and Back closes the preview', async ({ page }) => {
      await openItem(page);
      const { dialog } = await openChip(page, FILES[3]!);
      await expect(dialog.getByRole('heading', { name: 'Rollout plan' })).toBeVisible();
      await expectDialogInViewport(page);
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      await screenshot(page, 'library-ref-preview-markdown');

      await page.goBack();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: ITEM.title })).toBeVisible();
      expect(new URL(page.url()).pathname).toBe('/inbox');
    });

    test('the inbox item with its Library chips', async ({ page }) => {
      await openItem(page);
      await assertNoOverflow(page);
      await assertNoClippedOverflow(page);
      await screenshot(page, 'library-ref-inbox-item');
    });
  });
}

test.describe('Library reference preview — page underneath is untouched', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });

  test('scroll position and a half-typed answer survive opening and closing a preview', async ({
    page,
  }) => {
    // A long reason, so the item pane scrolls before the chips.
    const longBody = Array.from(
      { length: 14 },
      (_, i) => `Paragraph ${i + 1}: the totals moved after the VAT change, see the files below.`
    ).join('\n\n');
    await openItem(page, { ...ITEM, body: longBody });
    await page.getByRole('button', { name: 'Type a different answer' }).click();
    const answer = page.getByRole('textbox').last();
    await answer.fill('Mostly, but the VAT line');
    // Scroll the item pane so the chips are in view, then remember where it was.
    const chip = page.getByRole('link', { name: FILES[3]!.label });
    await chip.scrollIntoViewIfNeeded();
    const scrollBefore = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('*'))
        .filter((el) => el.scrollTop > 0)
        .map((el) => el.scrollTop)
    );
    // Liveness: something really is scrolled, so equal positions below are not two empty lists.
    expect(scrollBefore.length).toBeGreaterThan(0);
    await chip.click();
    await expect(page.getByRole('dialog', { name: FILES[3]!.filename })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(answer).toHaveValue('Mostly, but the VAT line');
    const scrollAfter = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('*'))
        .filter((el) => el.scrollTop > 0)
        .map((el) => el.scrollTop)
    );
    expect(scrollAfter).toEqual(scrollBefore);
  });
});

test.describe('Library reference preview — light theme', () => {
  test.use({ colorScheme: 'light' });

  for (const viewport of [
    { size: { width: 375, height: 667 }, touch: true },
    { size: { width: 1280, height: 800 }, touch: false },
  ]) {
    test(`markdown preview over the inbox at ${viewport.size.width}px`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: viewport.size,
        isMobile: viewport.touch,
        hasTouch: viewport.touch,
        colorScheme: 'light',
        serviceWorkers: 'block',
      });
      const page = await context.newPage();
      await openItem(page);
      await expect(page.locator('html')).toHaveAttribute('data-ui-theme', 'sam-light');
      await openChip(page, FILES[3]!);
      await expectDialogInViewport(page);
      await assertNoOverflow(page);
      await screenshot(page, 'library-ref-preview-markdown-light');
      await context.close();
    });
  }
});
