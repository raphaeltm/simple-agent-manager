/**
 * Renders the downloadable SAM lockups offered on /brand/:
 *   public/images/brand/sam-lockup-on-dark.png   (for dark grounds)
 *   public/images/brand/sam-lockup-on-light.png  (for light grounds)
 *
 * The proportions mirror src/components/brand/Lockup.astro. Chillax is embedded as a data URL
 * and the render fails unless the browser reports it loaded: a missing font falls back
 * silently, which is how earlier social images shipped in the wrong typeface.
 *
 * Run: pnpm --filter @simple-agent-manager/www build:brand-lockups
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const font = readFileSync(resolve(root, 'public/fonts/Chillax-Variable.woff2')).toString('base64');
const mascot = readFileSync(resolve(root, 'public/images/sam-head.png')).toString('base64');
const outDir = resolve(root, 'public/images/brand');

/** Lockup type size in CSS px; rendered at 2x. */
const SIZE = 100;
const SCALE = 2;

const TONES = {
  'on-dark': { sam: '#22c55e', sub: '#e6f2ee' },
  'on-light': { sam: '#16a34a', sub: '#2e4a31' },
} as const;

function html(tone: keyof typeof TONES) {
  const { sam, sub } = TONES[tone];
  return `<!doctype html><html><head><style>
    @font-face { font-family: 'Chillax'; src: url(data:font/woff2;base64,${font}) format('woff2'); font-weight: 200 700; }
    html, body { margin: 0; background: transparent; }
    .lockup { display: inline-flex; align-items: center; gap: 0.32em; padding: 0.3em; font: ${SIZE}px/1 'Chillax'; }
    .mark { width: 2.1em; height: auto; }
    .words { display: grid; gap: 0.16em; }
    .sam { font-size: 1.62em; font-weight: 700; letter-spacing: 0.01em; line-height: 0.82; color: ${sam}; }
    .sub { font-size: 0.4em; font-weight: 600; letter-spacing: 0.035em; white-space: nowrap; color: ${sub}; }
  </style></head><body>
    <span class="lockup"><img class="mark" src="data:image/png;base64,${mascot}" alt="" />
    <span class="words"><span class="sam">SAM</span><span class="sub">Simple Agent Manager</span></span></span>
  </body></html>`;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      deviceScaleFactor: SCALE,
      viewport: { width: 1200, height: 600 },
    });
    for (const tone of Object.keys(TONES) as (keyof typeof TONES)[]) {
      await page.setContent(html(tone));
      await page.evaluate(() => document.fonts.ready);
      const loaded = await page.evaluate(() => document.fonts.check(`700 100px Chillax`));
      if (!loaded)
        throw new Error('Chillax did not load; refusing to render a lockup in a fallback font');
      const path = resolve(outDir, `sam-lockup-${tone}.png`);
      await page.locator('.lockup').screenshot({ path, omitBackground: true });
      console.log(`wrote ${path}`);
    }
  } finally {
    await browser.close();
  }
}

await main();
