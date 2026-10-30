import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
const require = createRequire(new URL('../../www/package.json', import.meta.url));
const sharp = require('sharp');
const root = new URL('../../../.codex/tmp/playwright-screenshots/', import.meta.url);
let stats = [];
for (const width of [375, 1440])
  for (const theme of ['light', 'dark']) {
    const before = await sharp(new URL(`homepage-before-${width}-${theme}.png`, root).pathname)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const after = await sharp(new URL(`homepage-after-${width}-${theme}.png`, root).pathname)
      .raw()
      .toBuffer({ resolveWithObject: true });
    let changed = 0;
    for (let i = 0; i < before.data.length; i += before.info.channels)
      if (before.data.subarray(i, i + 3).some((v, j) => Math.abs(v - after.data[i + j]) > 2))
        changed++;
    stats.push({
      width,
      theme,
      before: before.info,
      after: after.info,
      changed,
      pct: (changed / (before.info.width * before.info.height)) * 100,
    });
  }
console.log(stats);
await writeFile(new URL('homepage-diffs.json', root), JSON.stringify(stats, null, 2));
