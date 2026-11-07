import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const output = '../../.codex/tmp/playwright-screenshots';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
for (const width of [375, 1440])
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({
      viewport: { width, height: 900 },
      reducedMotion: 'reduce',
      colorScheme: theme,
    });
    await page.goto('http://127.0.0.1:4321/');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(800);
    await page.screenshot({
      path: `${output}/homepage-${process.argv[2]}-${width}-${theme}.png`,
      fullPage: true,
    });
    await page.close();
  }
await browser.close();
