#!/usr/bin/env -S npx tsx
/**
 * Optimize feature screenshots in public/images/features/.
 *
 * For every *.png in that directory:
 *  - Downsizes the PNG in place to a max width (default 1920px) when wider.
 *  - Writes a same-named .webp sibling at the given quality.
 *
 * OptimizedFeatureImage.astro serves the .webp as a <source> and the .png as
 * the <img> fallback, so every screenshot referenced by src/data/features.ts
 * needs both files present. Re-run this after adding or replacing a PNG.
 *
 * A WebP that is already newer than its PNG is left alone so re-running the
 * script never churns committed files; set FEATURE_IMAGE_FORCE=1 to rebuild.
 *
 * Usage: pnpm --filter @simple-agent-manager/www optimize:features
 */
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const MAX_WIDTH = Number(process.env.FEATURE_IMAGE_MAX_WIDTH ?? 1920);
const WEBP_QUALITY = Number(process.env.FEATURE_IMAGE_WEBP_QUALITY ?? 82);
const FORCE = process.env.FEATURE_IMAGE_FORCE === '1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FEATURES_DIR = path.resolve(__dirname, '../public/images/features');

async function listPngFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
    .map((entry) => path.join(dir, entry.name));
}

async function isUpToDate(pngPath: string, webpPath: string): Promise<boolean> {
  try {
    const [png, webp] = await Promise.all([stat(pngPath), stat(webpPath)]);
    return webp.mtimeMs >= png.mtimeMs;
  } catch {
    return false;
  }
}

async function optimizeOne(pngPath: string): Promise<void> {
  const relName = path.basename(pngPath);
  const webpPath = pngPath.replace(/\.png$/i, '.webp');

  if (!FORCE && (await isUpToDate(pngPath, webpPath))) {
    console.log(`${relName}: up to date, skipped`);
    return;
  }

  const original = sharp(pngPath);
  const metadata = await original.metadata();
  const width = metadata.width ?? 0;
  const needsResize = width > MAX_WIDTH;

  // Downsize the PNG in place when it's larger than the max width.
  if (needsResize) {
    const resizedBuffer = await sharp(pngPath)
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .png()
      .toBuffer();
    await sharp(resizedBuffer).toFile(pngPath);
  }

  // Always (re)generate the WebP sibling from the current (possibly just
  // resized) PNG contents, capped at the same max width.
  await sharp(pngPath)
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY })
    .toFile(webpPath);

  const beforeSize = (await stat(pngPath)).size;
  const webpSize = (await stat(webpPath)).size;
  const resizeNote = needsResize ? ` (resized to ${MAX_WIDTH}px wide)` : '';
  const pngKb = (beforeSize / 1024).toFixed(0);
  const webpKb = (webpSize / 1024).toFixed(0);
  console.log(
    `${relName}${resizeNote} -> ${path.basename(webpPath)} (png ${pngKb}KB, webp ${webpKb}KB)`
  );
}

async function main(): Promise<void> {
  let pngFiles: string[];
  try {
    pngFiles = await listPngFiles(FEATURES_DIR);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      console.log(`No such directory: ${FEATURES_DIR} — nothing to optimize.`);
      return;
    }
    throw error;
  }

  if (pngFiles.length === 0) {
    console.log(`No PNG files found in ${FEATURES_DIR}.`);
    return;
  }

  console.log(`Optimizing ${pngFiles.length} screenshot(s) in ${FEATURES_DIR}...`);
  for (const pngPath of pngFiles) {
    await optimizeOne(pngPath);
  }
  console.log('Done.');
}

try {
  await main();
} catch (error) {
  console.error('optimize-feature-images failed:', error);
  process.exitCode = 1;
}
