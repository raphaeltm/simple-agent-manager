/**
 * Content and helpers for the brand and style guide (/brand/).
 *
 * The content itself (palette, type scale, easings, copy examples, glossary) lives in
 * brand-content.json and is validated here at load, so a malformed entry fails the build.
 * Colours that mirror a CSS token name it in `token`, with the theme the value belongs to;
 * tests/brand-guide.test.ts reads the stylesheets and fails if a value drifts from the token.
 * Mascot and app-icon colours are sampled from the committed artwork
 * (public/images/sam-head.png and public/favicon.png), so they carry no token.
 */
import content from './brand-content.json';

export type SwatchGroup = 'brand' | 'mascot' | 'ground' | 'signal';

export interface Swatch {
  name: string;
  hex: string;
  group: SwatchGroup;
  role: string;
  token?: { name: string; theme: 'dark' | 'light' };
}

export interface TypeStep {
  name: string;
  sample: string;
  family: 'display' | 'body' | 'mono';
  size: string;
  weight: number;
  lineHeight: string;
  tracking: string;
  use: string;
  uppercase?: boolean;
}

export interface Easing {
  name: string;
  curve: readonly [number, number, number, number];
  duration: number;
  use: string;
}

export interface CopyPair {
  context: string;
  avoid: string;
  write: string;
}

export interface GlossaryEntry {
  term: string;
  meaning: string;
}

const HEX = /^#[0-9a-f]{6}$/i;
const GROUPS = new Set<string>(['brand', 'mascot', 'ground', 'signal']);
const FAMILIES = new Set<string>(['display', 'body', 'mono']);
const THEMES = new Set<string>(['dark', 'light']);

function fail(what: string, value: unknown): never {
  throw new Error(`brand-content.json: invalid ${what}: ${JSON.stringify(value)}`);
}

function parseSwatch(raw: (typeof content.swatches)[number]): Swatch {
  if (!HEX.test(raw.hex) || !GROUPS.has(raw.group)) fail('swatch', raw);
  const token = 'token' in raw ? raw.token : undefined;
  if (token && (!token.name.startsWith('--') || !THEMES.has(token.theme)))
    fail('swatch token', raw);
  return raw as Swatch;
}

function parseTypeStep(raw: (typeof content.typeScale)[number]): TypeStep {
  if (!FAMILIES.has(raw.family)) fail('type step', raw);
  return raw as TypeStep;
}

function parseEasing(raw: (typeof content.easings)[number]): Easing {
  if (raw.curve.length !== 4 || raw.curve.some((n) => !Number.isFinite(n))) fail('easing', raw);
  return raw as unknown as Easing;
}

export const SWATCHES: readonly Swatch[] = content.swatches.map(parseSwatch);
export const TYPE_SCALE: readonly TypeStep[] = content.typeScale.map(parseTypeStep);
export const EASINGS: readonly Easing[] = content.easings.map(parseEasing);
export const COPY_PAIRS: readonly CopyPair[] = content.copyPairs;
export const BANNED_WORDS: readonly string[] = content.bannedWords;
export const GLOSSARY: readonly GlossaryEntry[] = content.glossary;

/** The three channels of a #rrggbb colour, 0 to 255. */
function channels(hex: string): [number, number, number] {
  if (!HEX.test(hex)) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const value = hex.slice(1);
  return [0, 2, 4].map((at) => Number.parseInt(value.slice(at, at + 2), 16)) as [
    number,
    number,
    number,
  ];
}

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two #rrggbb colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** `#16a34a` → `22 163 74`, the form CSS `rgb()` takes. */
export function rgbTriplet(hex: string): string {
  return channels(hex).join(' ');
}

export const LIGHT_TEXT = '#ffffff';
export const DARK_TEXT = '#070d0b';

/** The text colour that reads best on a swatch, with its contrast ratio. */
export function bestText(hex: string): { ink: string; ratio: number } {
  const onLight = contrastRatio(hex, LIGHT_TEXT);
  const onDark = contrastRatio(hex, DARK_TEXT);
  return onLight >= onDark
    ? { ink: LIGHT_TEXT, ratio: onLight }
    : { ink: DARK_TEXT, ratio: onDark };
}

/** WCAG grade for normal-size text. */
export function grade(ratio: number): 'AAA' | 'AA' | 'AA large' | 'Fail' {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA large';
  return 'Fail';
}

export const cubicBezier = (curve: readonly number[]) => `cubic-bezier(${curve.join(', ')})`;

export const SECTIONS = [
  { id: 'essence', label: 'Essence' },
  { id: 'logo', label: 'Logo' },
  { id: 'colour', label: 'Colour' },
  { id: 'type', label: 'Typography' },
  { id: 'material', label: 'Glass' },
  { id: 'motion', label: 'Motion' },
  { id: 'interface', label: 'Interface' },
  { id: 'voice', label: 'Voice' },
  { id: 'imagery', label: 'Imagery' },
  { id: 'assets', label: 'Assets' },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];

/** "03" for the third section, so the page and the rail number chapters the same way. */
export function sectionNumber(id: SectionId): string {
  return String(SECTIONS.findIndex((section) => section.id === id) + 1).padStart(2, '0');
}
