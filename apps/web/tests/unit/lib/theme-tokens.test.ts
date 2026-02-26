import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Ensures that CSS variables referenced across the web app are actually defined
 * in the theme tokens file. The --sam-color-bg-page variable was previously
 * undefined, causing transparent backgrounds in the SettingsDrawer and other
 * components.
 */
describe('theme token definitions', () => {
  const themeCSS = readFileSync(
    resolve(__dirname, '../../../../../packages/ui/src/tokens/theme.css'),
    'utf-8'
  );

  // Extract all defined CSS custom properties from theme.css
  const definedVars = new Set<string>();
  for (const match of themeCSS.matchAll(/--sam-[\w-]+(?=\s*:)/g)) {
    definedVars.add(match[0]);
  }

  it('defines --sam-color-bg-page', () => {
    expect(definedVars.has('--sam-color-bg-page')).toBe(true);
  });

  it('defines --sam-color-bg-overlay', () => {
    expect(definedVars.has('--sam-color-bg-overlay')).toBe(true);
  });

  it('defines --sam-color-bg-surface', () => {
    expect(definedVars.has('--sam-color-bg-surface')).toBe(true);
  });

  it('defines z-index tokens for drawers', () => {
    expect(definedVars.has('--sam-z-drawer-backdrop')).toBe(true);
    expect(definedVars.has('--sam-z-drawer')).toBe(true);
  });

  it('defines shadow tokens for overlays', () => {
    expect(definedVars.has('--sam-shadow-overlay')).toBe(true);
  });
});
