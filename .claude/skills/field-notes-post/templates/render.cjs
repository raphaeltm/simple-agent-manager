const path = require('path');
const { chromium } = require('playwright');

(async () => {
  const targets = process.argv.slice(2);
  const browser = await chromium.launch();
  for (const t of targets) {
    const [name, size] = t.split(':');
    const [w, h] = size.split('x').map(Number);
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    await page.goto('file://' + path.join(__dirname, name + '.html'), { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(__dirname, 'out', name + '.png') });
    console.log('rendered', name);
    await page.close();
  }
  await browser.close();
})();
