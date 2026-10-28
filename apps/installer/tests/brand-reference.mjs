// Run from apps/installer to capture the public reference and deployed baseline.
import { chromium } from '@playwright/test';
const browser = await chromium.launch();
for (const [label, width, height] of [
  ['desktop', 1280, 800],
  ['mobile', 375, 667],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  for (const [name, url] of [
    ['homepage', 'https://www.simple-agent-manager.org/'],
    ['before', 'https://install.sammy.party/'],
  ]) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: `../../.codex/tmp/playwright-screenshots/installer-${name}-${label}.png`,
    });
  }
  await page.close();
}
await browser.close();
