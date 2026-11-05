import { chromium } from '@playwright/test';
const API = 'https://api.sammy.party';
const APP = 'https://app.sammy.party';
const out = '/workspaces/simple-agent-manager/.tmp/staging';
const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
const browser = await chromium.launch();
const results = [];
async function run(name, { width, height, scheme }, fn) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 2 });
  const login = await ctx.request.post(`${API}/api/auth/token-login`, { data: { token } });
  if (login.status() !== 200) throw new Error(`token-login ${login.status()}`);
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  const failed = [];
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
  try { await fn(page); results.push({ name, ok: true, errors, failed }); }
  catch (e) { results.push({ name, ok: false, error: String(e), errors, failed }); await page.screenshot({ path: `${out}/${name}-FAIL.png` }); }
  await ctx.close();
}

await run('desktop-dark', { width: 1280, height: 800, scheme: 'dark' }, async (page) => {
  const mapResp = page.waitForResponse((r) => r.url().includes('/api/account-map'));
  await page.goto(`${APP}/account-map`);
  const resp = await mapResp;
  const data = await resp.json();
  console.log('account-map status', resp.status(), 'projects', data.projects.length, 'sessions', data.sessions.length, 'tasks', data.tasks.length, 'nodes', data.nodes.length, 'workspaces', data.workspaces.length);
  console.log('sessions have attention key:', data.sessions.every((s) => 'attention' in s), 'tasks have outputPrUrl key:', data.tasks.every((t) => 'outputPrUrl' in t), 'with attention:', data.sessions.filter((s) => s.attention).length, 'with pr:', data.tasks.filter((t) => t.outputPrUrl).length);
  await page.getByRole('heading', { name: 'How it all connects' }).waitFor();
  await page.waitForTimeout(1200);
  const hasColumns = await page.getByTestId('account-map-columns').count();
  const empty = await page.getByText('Nothing to connect yet').count();
  console.log('columns:', hasColumns, 'empty:', empty);
  await page.screenshot({ path: `${out}/desktop-dark-initial.png` });
  if (hasColumns) {
    const rows = page.locator('[data-column="work"] button[data-node]');
    const n = await rows.count();
    console.log('work rows', n, 'svg paths', await page.locator('svg path[data-edge]').count());
    if (n > 0) {
      await rows.first().click();
      await page.getByRole('list', { name: 'How this connects' }).waitFor();
      const links = await page.getByRole('list', { name: 'How this connects' }).getByRole('link').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      console.log('path links', links);
      console.log('lit edges', await page.locator('path[data-lit="true"]').count());
      await page.screenshot({ path: `${out}/desktop-dark-picked.png` });
      // Follow the chat link and come back.
      const chatLink = links.find((h) => h && (h.includes('/chat/') || h.includes('/tasks/')));
      if (chatLink) {
        await page.getByRole('list', { name: 'How this connects' }).locator(`a[href="${chatLink}"]`).click();
        await page.waitForURL((u) => u.pathname.includes('/projects/'), { timeout: 15000 });
        console.log('navigated to', new URL(page.url()).pathname);
        await page.goBack();
        await page.getByRole('heading', { name: 'How it all connects' }).waitFor();
      }
    }
    // Machine selection
    const machine = page.locator('[data-column="machines"] button[data-node]').first();
    if (await machine.count()) { await machine.click(); await page.waitForTimeout(300); console.log('machine summary:', await page.locator('header p').last().textContent()); }
  }
  // Filters and search
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^Live/ }).click();
  await page.waitForTimeout(300);
  await page.getByRole('group', { name: 'Show' }).getByRole('button', { name: /^Everything/ }).click();
  await page.getByRole('textbox', { name: 'Search the map' }).fill('zzzz-no-match');
  await page.waitForTimeout(300);
  console.log('no-match message:', await page.getByText('No chats or tasks match.').count());
  await page.getByRole('textbox', { name: 'Search the map' }).fill('');
  // Show finished
  const all = page.waitForResponse((r) => r.url().includes('/api/account-map?activeOnly=false'));
  await page.getByRole('button', { name: 'Show finished' }).click();
  const allResp = await all;
  const allData = await allResp.json();
  console.log('show finished status', allResp.status(), 'sessions', allData.sessions.length, 'tasks', allData.tasks.length);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/desktop-dark-finished.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  console.log('overflow', overflow);
});

await run('desktop-light', { width: 1280, height: 800, scheme: 'light' }, async (page) => {
  await page.goto(`${APP}/account-map`);
  await page.getByRole('heading', { name: 'How it all connects' }).waitFor();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/desktop-light.png` });
});

await run('mobile', { width: 375, height: 667, scheme: 'dark' }, async (page) => {
  await page.goto(`${APP}/account-map`);
  await page.getByRole('heading', { name: 'How it all connects' }).waitFor();
  await page.waitForTimeout(1200);
  const row = page.locator('button[data-node]').first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(400); console.log('mobile inline path lists:', await page.getByRole('list', { name: 'How this connects' }).count()); }
  console.log('mobile overflow', await page.evaluate(() => document.documentElement.scrollWidth > innerWidth));
  await page.screenshot({ path: `${out}/mobile.png` });
});

await run('regressions', { width: 1280, height: 800, scheme: 'dark' }, async (page) => {
  for (const path of ['/dashboard', '/projects', '/settings', '/nodes']) {
    await page.goto(`${APP}${path}`);
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    console.log('loaded', path, '->', new URL(page.url()).pathname);
  }
});

for (const r of results) console.log(JSON.stringify(r));
await browser.close();
