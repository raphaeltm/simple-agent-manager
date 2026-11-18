#!/usr/bin/env -S npx tsx
/**
 * Palette-compress committed UI screenshots in place: docs images and blog UI renders.
 * About 5x smaller with no visible change to flat UI. Files that are already palette PNGs
 * are skipped, because quantizing again would add dither noise each run.
 *
 * Usage (paths are relative to apps/www; directories mean every PNG inside them):
 *   pnpm --filter @simple-agent-manager/www compress:screenshots public/images/blog/<slug>
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import sharp from 'sharp';

function pngFiles(target: string): string[] {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target)
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .map((name) => path.join(target, name));
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('Usage: compress:screenshots <png file or directory>...');
  process.exit(1);
}

for (const file of targets.flatMap(pngFiles)) {
  const original = readFileSync(file);
  if ((await sharp(original).metadata()).isPalette) {
    console.log(`${file}: already compressed`);
    continue;
  }
  const compressed = await sharp(original)
    .png({ palette: true, quality: 90, effort: 10, dither: 0.6 })
    .toBuffer();
  if (compressed.length >= original.length) {
    console.log(`${file}: kept, compression would not shrink it`);
    continue;
  }
  writeFileSync(file, compressed);
  const kb = (bytes: number) => `${Math.round(bytes / 1024)} KB`;
  console.log(`${file}: ${kb(original.length)} -> ${kb(compressed.length)}`);
}
