/**
 * Builds the real-UI images on /brand/ (Imagery chapter) from fresh app captures:
 *   public/images/brand/app-desktop{,-light}.webp  the hero chat session on a desktop
 *   public/images/brand/app-phone{,-light}.webp    the same session on a phone
 *   public/images/brand/app-detail{,-light}.webp   the plan and tool group, cropped from the desktop
 *
 * Capture first (apps/web, against `vite preview` with VITE_API_URL=http://localhost:4173),
 * once per theme. Playwright clears its output folder on every run, so copy the PNGs away
 * between runs:
 *   MARKETING_THEME=dark PLAYWRIGHT_BASE_URL=http://localhost:4173 \
 *     npx playwright test tests/playwright/marketing-shots-platform.spec.ts -g sam-hero \
 *     --project="Desktop (1280x800)"
 *   (copy ../../.codex/tmp/playwright-screenshots/sam-hero-*.png to a folder)
 *   MARKETING_THEME=light PLAYWRIGHT_BASE_URL=http://localhost:4173 \
 *     npx playwright test tests/playwright/marketing-shots-platform.spec.ts -g sam-hero \
 *     --project="Desktop (1280x800)"
 *   (copy the -light PNGs to the same folder)
 * Then build and commit the WebP outputs:
 *   pnpm --filter @simple-agent-manager/www build:brand-captures <that folder>
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = resolve(
  process.argv[2] ?? resolve(root, '../../.codex/tmp/playwright-screenshots')
);
const outDir = resolve(root, 'public/images/brand');

/** The plan card and tool-call group, as fractions of the 1440x1050 desktop capture. */
const DETAIL = { left: 0.386, top: 0.617, width: 0.548, height: 0.22 };
const DESKTOP_WIDTH = 1600;
const PHONE_WIDTH = 780;
const DETAIL_WIDTH = 1000;

async function buildTheme(suffix: '' | '-light') {
  const desktop = resolve(sourceDir, `sam-hero-live-session${suffix}.png`);
  const phone = resolve(sourceDir, `sam-hero-phone${suffix}.png`);
  for (const file of [desktop, phone]) {
    if (!existsSync(file)) throw new Error(`Missing capture: ${file}`);
  }

  await sharp(desktop)
    .resize({ width: DESKTOP_WIDTH })
    .webp({ quality: 82 })
    .toFile(resolve(outDir, `app-desktop${suffix}.webp`));
  await sharp(phone)
    .resize({ width: PHONE_WIDTH })
    .webp({ quality: 82 })
    .toFile(resolve(outDir, `app-phone${suffix}.webp`));

  const { width = 0, height = 0 } = await sharp(desktop).metadata();
  await sharp(desktop)
    .extract({
      left: Math.round(width * DETAIL.left),
      top: Math.round(height * DETAIL.top),
      width: Math.round(width * DETAIL.width),
      height: Math.round(height * DETAIL.height),
    })
    .resize({ width: DETAIL_WIDTH })
    .webp({ quality: 85 })
    .toFile(resolve(outDir, `app-detail${suffix}.webp`));
  console.log(`built app-*${suffix}.webp`);
}

mkdirSync(outDir, { recursive: true });
await buildTheme('');
await buildTheme('-light');
