// Playwright screenshot script for glassomorphic prototypes
const { chromium } = require('/workspaces/simple-agent-manager/node_modules/.pnpm/playwright@1.59.1/node_modules/playwright');
const { readdir } = require('fs/promises');
const { resolve, basename } = require('path');

const PROTO_DIR = __dirname;
const OUT_DIR = resolve(__dirname, '../playwright-screenshots/glass');

const viewports = [
  { name: 'mobile', width: 375, height: 812 },
  { name: 'desktop', width: 1280, height: 800 },
];

async function main() {
  const files = (await readdir(PROTO_DIR)).filter(f => f.endsWith('.html'));

  if (files.length === 0) {
    console.log('No HTML files found in', PROTO_DIR);
    return;
  }

  console.log(`Found ${files.length} HTML files. Taking ${files.length * viewports.length} screenshots...`);

  const browser = await chromium.launch({ headless: true });

  for (const file of files) {
    const pageName = basename(file, '.html');
    const filePath = resolve(PROTO_DIR, file);

    for (const vp of viewports) {
      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.goto(`file://${filePath}`);
      await page.waitForTimeout(500);

      const outPath = resolve(OUT_DIR, `${pageName}-${vp.name}.png`);
      await page.screenshot({ path: outPath, fullPage: true });
      console.log(`  ✓ ${pageName}-${vp.name}.png`);

      await context.close();
    }
  }

  await browser.close();
  console.log(`\nDone! ${files.length * viewports.length} screenshots saved to ${OUT_DIR}`);
}

main().catch(console.error);
