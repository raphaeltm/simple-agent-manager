#!/usr/bin/env -S npx tsx
/**
 * Builds the homepage hero's real-UI layers from committed SAM screenshots.
 *
 * Every layer is a crop of a screenshot in public/images/features/ (rendered
 * from production components by apps/web/tests/playwright/marketing-shots-*.spec.ts),
 * in both themes. "Streaming" windows get a strip: a stretched empty background
 * band on top of the real transcript, so sliding the strip up inside the window
 * reveals each real row in turn (see src/components/hero/StreamingWindow.astro).
 *
 * Outputs (committed): public/images/hero/*.webp and src/data/hero-layers.json.
 * Re-run after re-capturing any source screenshot, and re-check the geometry
 * below if the captured layout moved.
 *
 * Usage: pnpm --filter @simple-agent-manager/www build:hero-layers
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = path.join(ROOT, 'public/images/features');
const OUT_DIR = path.join(ROOT, 'public/images/hero');
const MANIFEST_PATH = path.join(ROOT, 'src/data/hero-layers.json');
const PUBLIC_PREFIX = '/images/hero';
const WEBP_QUALITY = Number(process.env.HERO_LAYER_WEBP_QUALITY ?? 80);
const THEMES = { dark: '', light: '-light' } as const;
type Theme = keyof typeof THEMES;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A screenshot whose transcript streams in. All values are source pixels. */
interface WindowSpec {
  source: string;
  /** Output width of the base image; the strip and stop button share its scale. */
  outWidth: number;
  /** The scrolling transcript, between the session header and the composer dock. */
  view: Box;
  /** A row inside `view` that holds only background; stretched into the band above the transcript. */
  emptyRowY: number;
  /** Height of the band above the transcript; must cover the largest step plus `capRows`. */
  ext: number;
  /** Top rows of the view (the session header's shadow) that stay fixed: the strip fades in below them. */
  capRows: number;
  /** Rows over which the band blends into the first transcript row, so the junction has no seam. */
  rampRows: number;
  /** Square around the Interrupt button, which pokes up into the transcript. */
  stop: { x: number; y: number; size: number };
  /** How far the transcript is pushed down at each beat, ending at 0 (the real frame). */
  steps: number[];
}

interface CropSpec {
  source: string;
  box: Box;
  outWidth: number;
}

const WINDOWS: Record<string, WindowSpec> = {
  desktop: {
    source: 'sam-hero-live-session',
    outWidth: 1560,
    view: { x: 679, y: 106, w: 1178, h: 1120 },
    emptyRowY: 200,
    ext: 800,
    capRows: 36,
    rampRows: 48,
    stop: { x: 1268, y: 1197, size: 60 },
    steps: [738, 508, 278, 183, 98, 0],
  },
  phone: {
    source: 'sam-hero-phone',
    outWidth: 780,
    view: { x: 0, y: 348, w: 688, h: 1123 },
    emptyRowY: 800,
    ext: 700,
    capRows: 12,
    rampRows: 60,
    stop: { x: 349, y: 1431, size: 82 },
    steps: [668, 143, 0],
  },
};

const CROPS: Record<string, CropSpec> = {
  nodes: { source: 'sam-nodes-multi-provider', box: { x: 316, y: 662, w: 1582, h: 538 }, outWidth: 1520 },
  comment: { source: 'sam-comments-chat-thread', box: { x: 1446, y: 132, w: 398, h: 576 }, outWidth: 398 },
  placement: {
    source: 'sam-compute-placement-decision',
    box: { x: 690, y: 566, w: 560, h: 360 },
    outWidth: 560,
  },
  notifyInput: { source: 'sam-notifications-feed', box: { x: 317, y: 308, w: 1150, h: 108 }, outWidth: 1150 },
  notifyDone: { source: 'sam-notifications-feed', box: { x: 317, y: 199, w: 864, h: 108 }, outWidth: 864 },
};

const round = (value: number) => Math.round(value * 10_000) / 10_000;
const sourcePath = (name: string, theme: Theme) => path.join(SOURCE_DIR, `${name}${THEMES[theme]}.png`);
const layerFile = (name: string, theme: Theme) => `${name}${THEMES[theme]}.webp`;

async function writeWebp(image: sharp.Sharp, file: string, width: number) {
  const info = await image
    .resize({ width, kernel: 'lanczos3' })
    .webp({ quality: WEBP_QUALITY, effort: 6 })
    .toFile(path.join(OUT_DIR, file));
  return { width: info.width, height: info.height };
}

function files(name: string) {
  return {
    dark: `${PUBLIC_PREFIX}/${layerFile(name, 'dark')}`,
    light: `${PUBLIC_PREFIX}/${layerFile(name, 'light')}`,
  };
}

async function sourceSize(name: string) {
  const sizes = await Promise.all(
    (Object.keys(THEMES) as Theme[]).map(async (theme) => {
      const { width = 0, height = 0 } = await sharp(sourcePath(name, theme)).metadata();
      return { width, height };
    }),
  );
  const [dark, light] = sizes;
  if (!dark || !light || dark.width !== light.width || dark.height !== light.height) {
    throw new Error(`${name}: dark and light sources must have the same size`);
  }
  return dark;
}

function assertInside(label: string, box: Box, size: { width: number; height: number }) {
  if (box.x < 0 || box.y < 0 || box.x + box.w > size.width || box.y + box.h > size.height) {
    throw new Error(`${label}: box ${JSON.stringify(box)} falls outside ${size.width}x${size.height}`);
  }
}

/** One source row (RGB) across the view's width. */
async function sourceRow(src: string, x: number, y: number, width: number) {
  return sharp(src).extract({ left: x, top: y, width, height: 1 }).removeAlpha().raw().toBuffer();
}

/**
 * The band above the transcript: the empty row repeated, then a linear blend into the first
 * transcript row, so the junction that slides through the view during streaming has no seam.
 */
async function buildBand(src: string, spec: WindowSpec) {
  const { view, ext, rampRows } = spec;
  const empty = await sourceRow(src, view.x, spec.emptyRowY, view.w);
  const first = await sourceRow(src, view.x, view.y + spec.capRows, view.w);
  const rowBytes = view.w * 3;
  const band = Buffer.alloc(rowBytes * ext);
  for (let y = 0; y < ext; y++) {
    const t = Math.max(0, (y - (ext - rampRows) + 1) / (rampRows + 1));
    for (let i = 0; i < rowBytes; i++) {
      band[y * rowBytes + i] = Math.round((empty[i] ?? 0) * (1 - t) + (first[i] ?? 0) * t);
    }
  }
  return sharp(band, { raw: { width: view.w, height: ext, channels: 3 } }).png().toBuffer();
}

async function buildWindow(name: string, spec: WindowSpec) {
  const size = await sourceSize(spec.source);
  const { view, stop, ext, steps, capRows } = spec;
  assertInside(`${name}.view`, view, size);
  assertInside(`${name}.stop`, { x: stop.x, y: stop.y, w: stop.size, h: stop.size }, size);
  if (spec.emptyRowY < view.y || spec.emptyRowY >= view.y + view.h) throw new Error(`${name}: emptyRowY outside view`);
  if (spec.rampRows >= ext || capRows >= view.h) throw new Error(`${name}: rampRows/capRows too large`);
  if (steps.at(-1) !== 0 || Math.max(...steps) > ext - capRows || steps.some((s, i) => i > 0 && s >= (steps[i - 1] ?? 0))) {
    throw new Error(`${name}: steps must strictly decrease to 0 and stay within ext - capRows`);
  }

  const scale = spec.outWidth / size.width;
  // The strip holds the band plus the transcript below the fixed cap rows.
  const stripHeight = ext + view.h - capRows;
  let base = { width: 0, height: 0 };
  let strip = { width: 0, height: 0 };
  for (const theme of Object.keys(THEMES) as Theme[]) {
    const src = sourcePath(spec.source, theme);
    base = await writeWebp(sharp(src), layerFile(name, theme), spec.outWidth);

    const transcript = await sharp(src)
      .extract({ left: view.x, top: view.y + capRows, width: view.w, height: view.h - capRows })
      .removeAlpha()
      .png()
      .toBuffer();
    const composed = await sharp({ create: { width: view.w, height: stripHeight, channels: 3, background: '#000' } })
      .composite([
        { input: await buildBand(src, spec), left: 0, top: 0 },
        { input: transcript, left: 0, top: ext },
      ])
      .png()
      .toBuffer();
    strip = await writeWebp(sharp(composed), layerFile(`${name}-strip`, theme), Math.round(view.w * scale));

    await writeWebp(
      sharp(src).extract({ left: stop.x, top: stop.y, width: stop.size, height: stop.size }),
      layerFile(`${name}-stop`, theme),
      Math.round(stop.size * scale),
    );
  }

  return {
    base: { files: files(name), ...base },
    strip: {
      files: files(`${name}-strip`),
      ...strip,
      // translateY of the strip (percent of its own height) for each beat; the last is the real frame.
      offsets: steps.map((step) => round(((capRows + step - ext) / stripHeight) * 100)),
      // The strip is transparent above this point (percent of the view) so the real cap rows show.
      maskStop: round((capRows / view.h) * 100),
    },
    stop: { files: files(`${name}-stop`) },
    // Placement inside the base image, in percent.
    view: {
      left: round((view.x / size.width) * 100),
      top: round((view.y / size.height) * 100),
      width: round((view.w / size.width) * 100),
      height: round((view.h / size.height) * 100),
    },
    stopBox: {
      left: round((stop.x / size.width) * 100),
      top: round((stop.y / size.height) * 100),
      width: round((stop.size / size.width) * 100),
    },
  };
}

async function buildCrop(name: string, spec: CropSpec) {
  const size = await sourceSize(spec.source);
  assertInside(name, spec.box, size);
  let out = { width: 0, height: 0 };
  for (const theme of Object.keys(THEMES) as Theme[]) {
    const { box } = spec;
    out = await writeWebp(
      sharp(sourcePath(spec.source, theme)).extract({ left: box.x, top: box.y, width: box.w, height: box.h }),
      layerFile(name, theme),
      spec.outWidth,
    );
  }
  return { files: files(name), ...out };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const windows: Record<string, Awaited<ReturnType<typeof buildWindow>>> = {};
  for (const [name, spec] of Object.entries(WINDOWS)) windows[name] = await buildWindow(name, spec);
  const crops: Record<string, Awaited<ReturnType<typeof buildCrop>>> = {};
  for (const [name, spec] of Object.entries(CROPS)) crops[name] = await buildCrop(name, spec);

  await writeFile(MANIFEST_PATH, `${JSON.stringify({ windows, crops }, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(windows).length} windows and ${Object.keys(crops).length} crops to ${OUT_DIR}`);
}

await main();
