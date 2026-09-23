/**
 * Shared capture helper for the documentation screenshot specs.
 *
 * Lives outside the spec files because two of them need it and rule 24 bans a second
 * copy: a divergent `DOCS_IMAGE_DIR` would silently write half the docs images to the
 * gitignored tmp dir while the spec still passed.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

/** Where committed docs images live, relative to `apps/web` (Playwright's cwd). */
export const DOCS_IMAGE_DIR = resolve(process.cwd(), '../www/public/images/docs');

/**
 * Capture a focused element (or the full page) into the docs image directory when
 * DOCS_SHOTS is set, otherwise into the gitignored tmp dir with a viewport suffix.
 */
export async function docsShot(
  page: Page,
  name: string,
  locator?: ReturnType<Page['locator']>
): Promise<void> {
  await page.waitForTimeout(500);
  const target = locator ?? page;
  if (process.env.DOCS_SHOTS) {
    mkdirSync(DOCS_IMAGE_DIR, { recursive: true });
    await target.screenshot({ path: `${DOCS_IMAGE_DIR}/${name}.png` });
    return;
  }
  const suffix = page.viewportSize()?.width ?? 'x';
  const tmp = `${process.cwd()}/.codex/tmp/playwright-screenshots`;
  mkdirSync(tmp, { recursive: true });
  await target.screenshot({ path: `${tmp}/${name}-${suffix}.png` });
}

/**
 * Make the modal backdrop fully opaque so the page behind a drawer does not bleed
 * through its rounded corners in a cropped docs image.
 */
export async function opaqueBackdrop(page: Page): Promise<void> {
  await page.addStyleTag({
    content:
      '.glass-backdrop-dim{background:#0a0e0c !important;opacity:1 !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}',
  });
}
