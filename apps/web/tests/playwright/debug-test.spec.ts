import { test } from '@playwright/test';

test('debug app mount', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));
  
  await page.goto('/');
  await page.waitForTimeout(2000);
  
  const hasRoot = await page.evaluate(() => !!document.getElementById('root')?.childElementCount);
  console.log('ROOT HAS CHILDREN:', hasRoot);
  console.log('JS ERRORS:', errors.join('; '));
  const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 300));
  console.log('BODY TEXT:', bodyText);
});
