/**
 * Shared capture helpers for the documentation screenshot specs and for blog post UI
 * renders (`blogShot`).
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
 * Docs and blog images are published, so they must come from the local build with mocked
 * API data. Refuse anything else, such as a run pointed at staging with real accounts.
 */
function assertLocalPage(page: Page): void {
  const { hostname } = new URL(page.url());
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
    throw new Error(
      `Refusing to capture ${page.url()}: published images must come from a local build`
    );
  }
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
  assertLocalPage(page);
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

/** Where blog post UI renders live, relative to `apps/web`: one directory per post slug. */
export const BLOG_IMAGE_DIR = resolve(process.cwd(), '../www/public/images/blog');

/**
 * Capture one element as a UI render for a blog post, into
 * `apps/www/public/images/blog/<slug>/<name>.png`, and print its size in CSS pixels. The
 * capture is at the project's device scale (2x), so the post's `<img>` must declare these
 * CSS sizes as `width` and `height` to show the render at its real size, sharply.
 * See "UI renders" in `apps/www/src/content/CLAUDE.md`.
 */
export async function blogShot(
  page: Page,
  slug: string,
  name: string,
  target: Locator
): Promise<{ width: number; height: number }> {
  assertLocalPage(page);
  await page.waitForTimeout(500);
  const box = await target.boundingBox();
  if (!box) throw new Error(`blogShot: "${name}" is not on screen`);
  const dir = resolve(BLOG_IMAGE_DIR, slug);
  mkdirSync(dir, { recursive: true });
  await target.screenshot({ path: `${dir}/${name}.png`, animations: 'disabled' });
  const size = { width: Math.round(box.width), height: Math.round(box.height) };
  console.log(`${slug}/${name}.png  width="${size.width}" height="${size.height}"`);
  return size;
}

/**
 * Make the modal backdrop fully opaque so the page behind a drawer does not bleed
 * through its rounded corners in a cropped docs or blog image.
 */
export async function opaqueBackdrop(page: Page, theme: 'dark' | 'light' = 'dark'): Promise<void> {
  const background = theme === 'dark' ? '#0a0e0c' : '#eef3ef';
  await page.addStyleTag({
    content: `.glass-backdrop-dim{background:${background} !important;opacity:1 !important;backdrop-filter:none !important;-webkit-backdrop-filter:none !important;}`,
  });
}
