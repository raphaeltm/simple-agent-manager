import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  bestText,
  contrastRatio,
  grade,
  rgbTriplet,
  SECTIONS,
  sectionNumber,
  SWATCHES,
} from '../src/data/brand';

const uiSrc = resolve(__dirname, '../../../packages/ui/src');
const stylesheets = ['brand/brand.css', 'glass/glass.css', 'tokens/sam-glass.css'].map((file) =>
  readFileSync(resolve(uiSrc, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
);

/** The value of `name` in the first rule block for the theme: `:root {` for dark, a light selector for light. */
function tokenValue(name: string, theme: 'dark' | 'light'): string | undefined {
  for (const css of stylesheets) {
    const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    for (const [, selector, body] of blocks) {
      const isLight = /data-theme='light'|data-ui-theme='sam-light'/.test(selector ?? '');
      const isDark = (selector ?? '').trim() === ':root';
      if ((theme === 'light' && !isLight) || (theme === 'dark' && !isDark)) continue;
      const match = new RegExp(`${name}:\\s*([^;]+);`).exec(body ?? '');
      if (match?.[1]) return match[1].trim().toLowerCase();
    }
  }
  return undefined;
}

describe('brand guide colour data', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
    // brand.css documents white on #15803d at 5.0:1.
    expect(contrastRatio('#15803d', '#ffffff')).toBeCloseTo(5.02, 2);
  });

  it('grades ratios at the WCAG thresholds', () => {
    expect(grade(7)).toBe('AAA');
    expect(grade(6.99)).toBe('AA');
    expect(grade(4.5)).toBe('AA');
    expect(grade(4.49)).toBe('AA large');
    expect(grade(3)).toBe('AA large');
    expect(grade(2.99)).toBe('Fail');
  });

  it('picks the more readable text colour for each swatch', () => {
    expect(bestText('#010302').ink).toBe('#ffffff');
    expect(bestText('#e6f2ee').ink).toBe('#070d0b');
    for (const swatch of SWATCHES) {
      expect(bestText(swatch.hex).ratio, swatch.name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('rejects malformed colours instead of reporting a ratio', () => {
    expect(() => contrastRatio('#fff', '#000000')).toThrow();
    expect(() => contrastRatio('green', '#000000')).toThrow();
  });

  it('formats rgb triplets', () => {
    expect(rgbTriplet('#16a34a')).toBe('22 163 74');
  });

  it('keeps every token-backed swatch equal to the token it names', () => {
    const withTokens = SWATCHES.filter((swatch) => swatch.token);
    expect(withTokens.length).toBeGreaterThan(10);
    for (const swatch of withTokens) {
      const { name, theme } = swatch.token!;
      expect(tokenValue(name, theme), `${swatch.name} → ${name} (${theme})`).toBe(swatch.hex);
    }
  });

  it('has unique swatch names and hex values', () => {
    expect(new Set(SWATCHES.map((s) => s.name)).size).toBe(SWATCHES.length);
    expect(new Set(SWATCHES.map((s) => s.hex)).size).toBe(SWATCHES.length);
  });

  it('numbers sections in order', () => {
    expect(sectionNumber(SECTIONS[0].id)).toBe('01');
    expect(sectionNumber('assets')).toBe(String(SECTIONS.length).padStart(2, '0'));
  });
});
