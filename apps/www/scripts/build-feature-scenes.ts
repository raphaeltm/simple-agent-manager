#!/usr/bin/env -S npx tsx
/**
 * Builds the homepage feature scenes' real-UI layers from committed SAM screenshots.
 *
 * Each layer in src/data/scenes/*.json is a crop of a screenshot in public/images/features/
 * (rendered from production components by apps/web/tests/playwright/marketing-shots-*.spec.ts),
 * written in both themes. Regions that appear during the story ("tiles") are cut from the
 * resized layer and blanked in its base image with the background around them, so the resting
 * frame — base plus every tile — is exactly the original pixels. A layer with a `swap` also gets
 * the same box from its later-state capture.
 *
 * Outputs (committed): public/images/scenes/*.webp and src/data/feature-scenes.json.
 * Re-run after re-capturing a source screenshot or editing a scene, and re-check the boxes in the
 * scene JSON if the captured layout moved.
 *
 * Usage: pnpm --filter @simple-agent-manager/www build:feature-scenes
 */
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import { assertLayerFits, scenes, type SceneLayer, type SceneSpec } from '../src/data/scenes';
import {
  assertInside,
  type Box,
  layerFile,
  ROOT,
  round,
  type Size,
  sourcePath,
  sourceSize,
  THEME_NAMES,
  type Theme,
  themedFiles,
} from './lib/real-ui-layers';

const OUT_DIR = path.join(ROOT, 'public/images/scenes');
const MANIFEST_PATH = path.join(ROOT, 'src/data/feature-scenes.json');
const PUBLIC_PREFIX = '/images/scenes';
const WEBP_QUALITY = Number(process.env.SCENE_LAYER_WEBP_QUALITY ?? 78);
const CHANNELS = 3;
/** Horizontal blur (output px) applied to the background that blanks unrevealed tiles. */
const FILL_BLUR_RADIUS = 24;
/** Rows sampled on each side of a blanked band. */
const FILL_EDGE_ROWS = 5;

interface Raw {
  data: Buffer;
  width: number;
  height: number;
}

/** A rectangle in output pixels. */
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const files = (name: string) => themedFiles(PUBLIC_PREFIX, name);

async function encode(raw: Raw, name: string, theme: Theme): Promise<Size> {
  const info = await sharp(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: CHANNELS },
  })
    .webp({ quality: WEBP_QUALITY, effort: 6 })
    .toFile(path.join(OUT_DIR, layerFile(name, theme)));
  return { width: info.width, height: info.height };
}

/** The layer's box from `source`, resized to the layer's output width, as raw RGB. */
async function cut(source: string, theme: Theme, layer: SceneLayer): Promise<Raw> {
  const { box, outWidth } = layer;
  const { data, info } = await sharp(sourcePath(source, theme))
    .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
    .resize({ width: outWidth, kernel: 'lanczos3' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Maps a source-pixel box inside the layer to whole output pixels. */
function toRect(layer: SceneLayer, box: Box, out: Size): Rect {
  const scale = out.width / layer.box.w;
  const left = Math.floor((box.x - layer.box.x) * scale);
  const top = Math.floor((box.y - layer.box.y) * scale);
  const right = Math.min(out.width, Math.ceil((box.x + box.w - layer.box.x) * scale));
  const bottom = Math.min(out.height, Math.ceil((box.y + box.h - layer.box.y) * scale));
  return { left, top, width: right - left, height: bottom - top };
}

function extract(raw: Raw, rect: Rect): Raw {
  const data = Buffer.alloc(rect.width * rect.height * CHANNELS);
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.top + y) * raw.width + rect.left) * CHANNELS;
    raw.data.copy(data, y * rect.width * CHANNELS, from, from + rect.width * CHANNELS);
  }
  return { data, width: rect.width, height: rect.height };
}

/** Groups rects that touch or overlap into bands (their bounding rectangles). */
function bands(rects: Rect[]): Rect[] {
  const merged: Rect[] = [];
  for (const rect of rects) {
    let band = { ...rect };
    for (let i = merged.length - 1; i >= 0; i--) {
      const other = merged[i] as Rect;
      const touches =
        band.left <= other.left + other.width &&
        other.left <= band.left + band.width &&
        band.top <= other.top + other.height &&
        other.top <= band.top + band.height;
      if (!touches) continue;
      const left = Math.min(band.left, other.left);
      const top = Math.min(band.top, other.top);
      band = {
        left,
        top,
        width: Math.max(band.left + band.width, other.left + other.width) - left,
        height: Math.max(band.top + band.height, other.top + other.height) - top,
      };
      merged.splice(i, 1);
    }
    merged.push(band);
  }
  return merged;
}

/**
 * Background just outside a band, for columns [left, left + width): the per-column median of
 * `FILL_EDGE_ROWS` rows (so a 1-2 px divider is ignored), box-blurred horizontally so the app's
 * fine grain does not smear into stripes.
 */
function edgeRow(raw: Raw, rows: number[], left: number, width: number): Float64Array {
  const median = new Float64Array(width * CHANNELS);
  const sample: number[] = [];
  for (let x = 0; x < width; x++) {
    for (let c = 0; c < CHANNELS; c++) {
      sample.length = 0;
      for (const y of rows) sample.push(raw.data[(y * raw.width + left + x) * CHANNELS + c] ?? 0);
      sample.sort((a, b) => a - b);
      median[x * CHANNELS + c] = sample[Math.floor(sample.length / 2)] ?? 0;
    }
  }
  const smooth = new Float64Array(width * CHANNELS);
  for (let x = 0; x < width; x++) {
    const from = Math.max(0, x - FILL_BLUR_RADIUS);
    const to = Math.min(width - 1, x + FILL_BLUR_RADIUS);
    for (let c = 0; c < CHANNELS; c++) {
      let sum = 0;
      for (let i = from; i <= to; i++) sum += median[i * CHANNELS + c] ?? 0;
      smooth[x * CHANNELS + c] = sum / (to - from + 1);
    }
  }
  return smooth;
}

const clampRow = (raw: Raw, y: number) => Math.min(raw.height - 1, Math.max(0, y));

/**
 * Blanks every rect so it holds only background: each band of touching rects is filled with
 * a vertical blend between the background just above it and just below it.
 */
function blank(raw: Raw, rects: Rect[]): Raw {
  const data = Buffer.from(raw.data);
  for (const band of bands(rects)) {
    const above = Array.from({ length: FILL_EDGE_ROWS }, (_, i) => clampRow(raw, band.top - 1 - i));
    const below = Array.from({ length: FILL_EDGE_ROWS }, (_, i) =>
      clampRow(raw, band.top + band.height + i)
    );
    const top = edgeRow(raw, band.top > 0 ? above : below, band.left, band.width);
    const bottom = edgeRow(
      raw,
      band.top + band.height < raw.height ? below : above,
      band.left,
      band.width
    );
    for (let y = 0; y < band.height; y++) {
      const t = band.height > 1 ? y / (band.height - 1) : 0;
      for (let i = 0; i < band.width * CHANNELS; i++) {
        data[((band.top + y) * raw.width + band.left) * CHANNELS + i] = Math.round(
          (top[i] ?? 0) * (1 - t) + (bottom[i] ?? 0) * t
        );
      }
    }
  }
  return { ...raw, data };
}

const percent = (rect: Rect, out: Size) => ({
  left: round((rect.left / out.width) * 100),
  top: round((rect.top / out.height) * 100),
  width: round((rect.width / out.width) * 100),
  height: round((rect.height / out.height) * 100),
});

async function buildLayer(scene: SceneSpec, layer: SceneLayer) {
  const name = `${scene.slug}-${layer.id}`;
  const label = `${scene.slug}.${layer.id}`;
  assertInside(label, layer.box, await sourceSize(layer.source));
  if (layer.swap) assertInside(`${label}.swap`, layer.box, await sourceSize(layer.swap.source));
  if (layer.outWidth > layer.box.w)
    throw new Error(`${label}: outWidth ${layer.outWidth} would upscale a ${layer.box.w}px crop`);

  const tiles = layer.tiles ?? [];
  let base: Size = { width: 0, height: 0 };
  let tileRects: Rect[] = [];
  for (const theme of THEME_NAMES) {
    const full = await cut(layer.source, theme, layer);
    base = { width: full.width, height: full.height };
    tileRects = tiles.map((tile) => toRect(layer, tile.box, base));
    for (const [i, rect] of tileRects.entries())
      await encode(extract(full, rect), `${name}-tile${i}`, theme);
    await encode(tiles.length > 0 ? blank(full, tileRects) : full, name, theme);
    if (layer.swap) await encode(await cut(layer.swap.source, theme, layer), `${name}-swap`, theme);
  }
  assertLayerFits(scene, layer, base);

  return {
    files: files(name),
    ...base,
    tiles: tileRects.map((rect, i) => ({
      files: files(`${name}-tile${i}`),
      box: percent(rect, base),
    })),
    ...(layer.swap ? { swap: { files: files(`${name}-swap`) } } : {}),
  };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const manifest: Record<string, Record<string, Awaited<ReturnType<typeof buildLayer>>>> = {};
  for (const scene of scenes) {
    manifest[scene.slug] = {};
    for (const layer of scene.layers)
      manifest[scene.slug][layer.id] = await buildLayer(scene, layer);
  }
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  // Remove images no scene uses any more (a renamed layer, a dropped tile).
  const written = new Set(JSON.stringify(manifest).match(/[\w-]+\.webp/g));
  const stale = (await readdir(OUT_DIR)).filter((file) => !written.has(file));
  await Promise.all(stale.map((file) => rm(path.join(OUT_DIR, file))));
  console.log(
    `Wrote ${written.size} images for ${scenes.length} scenes to ${OUT_DIR} (removed ${stale.length} stale)`
  );
}

await main();
