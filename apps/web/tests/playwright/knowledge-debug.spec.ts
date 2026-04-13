import { test } from '@playwright/test';

test('debug — capture network requests', async ({ page }) => {
  page.on('request', (req) => {
    console.log('[REQ]', req.method(), req.url());
  });
  page.on('response', (resp) => {
    console.log('[RESP]', resp.status(), resp.url());
  });

  await page.goto('http://localhost:4173/projects/proj-1/knowledge');
  await page.waitForTimeout(5000);

  const url = page.url();
  console.log('[CURRENT URL]', url);
  const content = await page.content();
  console.log('[BODY snippet]', content.substring(0, 500));
});
