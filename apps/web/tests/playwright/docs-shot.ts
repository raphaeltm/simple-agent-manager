/**
 * Shared capture helper for the documentation screenshot specs.
 *
 * Lives outside the spec files because two of them need it and rule 24 bans a second
 * copy: a divergent `DOCS_IMAGE_DIR` would silently write half the docs images to the
 * gitignored tmp dir while the spec still passed.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Locator, Page } from '@playwright/test';

/** Where committed docs images live, relative to `apps/web` (Playwright's cwd). */
export const DOCS_IMAGE_DIR = resolve(process.cwd(), '../www/public/images/docs');

/** A page region, for captures that must span several elements (e.g. a list beside a chat). */
export interface DocsShotClip {
  clip: { x: number; y: number; width: number; height: number };
}

/**
 * Capture a focused element, a page region, or the whole viewport into the docs image
 * directory when DOCS_SHOTS is set, otherwise into the gitignored tmp dir with a viewport
 * suffix.
 */
export async function docsShot(
  page: Page,
  name: string,
  target?: Locator | DocsShotClip
): Promise<void> {
  await page.waitForTimeout(500);
  let path: string;
  if (process.env.DOCS_SHOTS) {
    mkdirSync(DOCS_IMAGE_DIR, { recursive: true });
    path = `${DOCS_IMAGE_DIR}/${name}.png`;
  } else {
    const suffix = page.viewportSize()?.width ?? 'x';
    const tmp = `${process.cwd()}/.codex/tmp/playwright-screenshots`;
    mkdirSync(tmp, { recursive: true });
    path = `${tmp}/${name}-${suffix}.png`;
  }
  if (target && 'clip' in target) {
    await page.screenshot({ path, clip: target.clip });
    return;
  }
  await (target ?? page).screenshot({ path });
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
