/**
 * Shared helpers for the scripts that cut SAM's real UI into marketing layers
 * (build-hero-layers.ts, build-feature-scenes.ts).
 *
 * Sources are committed screenshots in public/images/features/, rendered from
 * production components by apps/web/tests/playwright/marketing-shots-*.spec.ts.
 * Every source exists in both themes (`<name>.png` and `<name>-light.png`) at the
 * same size, so one set of source-pixel boxes cuts both.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp, { type Sharp } from 'sharp';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SOURCE_DIR = path.join(ROOT, 'public/images/features');
export const THEMES = { dark: '', light: '-light' } as const;
export type Theme = keyof typeof THEMES;
export const THEME_NAMES = Object.keys(THEMES) as Theme[];

/** A rectangle in source pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  width: number;
  height: number;
}

export const round = (value: number) => Math.round(value * 10_000) / 10_000;
export const sourcePath = (name: string, theme: Theme) =>
  path.join(SOURCE_DIR, `${name}${THEMES[theme]}.png`);
export const layerFile = (name: string, theme: Theme) => `${name}${THEMES[theme]}.webp`;

/** Public URLs of a layer in both themes. */
export function themedFiles(publicPrefix: string, name: string) {
  return {
    dark: `${publicPrefix}/${layerFile(name, 'dark')}`,
    light: `${publicPrefix}/${layerFile(name, 'light')}`,
  };
}

export async function writeWebp(
  image: Sharp,
  outPath: string,
  width: number,
  quality: number
): Promise<Size> {
  const info = await image
    .resize({ width, kernel: 'lanczos3' })
    .webp({ quality, effort: 6 })
    .toFile(outPath);
  return { width: info.width, height: info.height };
}

/** The size shared by a source's two themes; throws if they differ. */
export async function sourceSize(name: string): Promise<Size> {
  const sizes = await Promise.all(
    THEME_NAMES.map(async (theme) => {
      const { width = 0, height = 0 } = await sharp(sourcePath(name, theme)).metadata();
      return { width, height };
    })
  );
  const [dark, light] = sizes;
  if (!dark || !light || dark.width !== light.width || dark.height !== light.height) {
    throw new Error(`${name}: dark and light sources must have the same size`);
  }
  return dark;
}

export function assertInside(label: string, box: Box, size: Size) {
  if (box.x < 0 || box.y < 0 || box.x + box.w > size.width || box.y + box.h > size.height) {
    throw new Error(
      `${label}: box ${JSON.stringify(box)} falls outside ${size.width}x${size.height}`
    );
  }
}
