import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
const sharp = createRequire(new URL('../../www/package.json', import.meta.url))('sharp');
const source = new URL('../../../.codex/tmp/playwright-screenshots/', import.meta.url);
const output = new URL('../review/', import.meta.url);
await mkdir(output, { recursive: true });
async function pair(left, right, name, width = 1280, top = false) {
  const frames = [];
  for (const file of [left, right]) {
    let frame = sharp(new URL(file, source).pathname);
    const size = await frame.metadata();
    if (top)
      frame = frame.extract({
        left: 0,
        top: 0,
        width: size.width,
        height: Math.min(900, size.height),
      });
    frames.push(await frame.resize({ width }).toBuffer());
  }
  const sizes = await Promise.all(frames.map((f) => sharp(f).metadata()));
  await sharp({
    create: {
      width: width * 2,
      height: Math.max(...sizes.map((s) => s.height)),
      channels: 3,
      background: '#13201d',
    },
  })
    .composite(frames.map((input, i) => ({ input, left: i * width, top: 0 })))
    .webp({ quality: 85 })
    .toFile(new URL(name + '.webp', output).pathname);
}
for (const [device, width, homeWidth] of [
  ['mobile', 375, 375],
  ['desktop', 1280, 1440],
])
  for (const theme of ['light', 'dark']) {
    await pair(
      `homepage-after-${homeWidth}-${theme}.png`,
      `installer-connect-${device}-${theme}.png`,
      `brand-comparison-${device}-${theme}`,
      width,
      true
    );
    await pair(
      `installer-full-preview-${device}-${theme}.png`,
      `installer-maintenance-controls-${device}-${theme}.png`,
      `plan-maintenance-${device}-${theme}`,
      width
    );
    await pair(
      `homepage-before-${homeWidth}-${theme}.png`,
      `homepage-after-${homeWidth}-${theme}.png`,
      `homepage-refactor-${device}-${theme}`,
      width,
      true
    );
    for (const state of ['privacy', 'self-host', 'handoff'])
      await sharp(new URL(`installer-${state}-${device}-${theme}.png`, source).pathname)
        .webp({ quality: 82 })
        .toFile(new URL(`${state}-${device}-${theme}.webp`, output).pathname);
  }
await writeFile(
  new URL('homepage-diffs.json', output),
  await readFile(new URL('homepage-diffs.json', source))
);
for (const w of [375, 1440])
  for (const t of ['light', 'dark']) {
    const before = await sharp(new URL(`homepage-before-${w}-${t}.png`, source).pathname)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const after = await sharp(new URL(`homepage-after-${w}-${t}.png`, source).pathname)
      .raw()
      .toBuffer();
    if (before.data.length !== after.length) throw Error('Homepage dimensions changed');
    const diff = Buffer.alloc(after.length);
    for (let i = 0; i < diff.length; i++)
      diff[i] = Math.min(255, Math.abs(before.data[i] - after[i]) * 8);
    await sharp(diff, { raw: before.info })
      .png()
      .toFile(new URL(`homepage-diff-${w}-${t}.png`, output).pathname);
  }
