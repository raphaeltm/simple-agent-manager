// Staging live check for Insights · Accounts (slice A). Not committed (.tmp.mjs).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
const API = 'https://api.sammy.party';
const APP = 'https://app.sammy.party';
const OUT = '/workspaces/simple-agent-manager/.tmp/a/staging';
mkdirSync(OUT, { recursive: true });
const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
if (!token) throw new Error('missing token');
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const login = await ctx.request.post(`${API}/api/auth/token-login`, { data: { token } });
console.log('login', login.status());
const projects = await (await ctx.request.get(`${API}/api/projects?limit=100`)).json();
const list = projects.projects ?? projects.items ?? projects;
let best = null;
for (const p of list) {
  const r = await ctx.request.get(`${API}/api/projects/${p.id}/insights/accounts?range=90d`);
  if (r.status() !== 200) { console.log('accounts', p.id, r.status()); continue; }
  const body = await r.json();
  const stalls = body.stallEpisodes.total;
  console.log('project', p.id, JSON.stringify(p.name), 'runs', body.totals.runs, 'stalls', stalls, 'accounts', body.accounts.map((a) => `${a.key}:${a.owner}:${a.kind}:${a.runs}`).join(' '), 'cache', r.headers()['cache-control'], 'unavailable', body.unavailable.join(','));
  if (!best || body.totals.runs + stalls * 100 > best.score) best = { id: p.id, score: body.totals.runs + stalls * 100 };
}
const bad = await ctx.request.get(`${API}/api/projects/${list[0]?.id}/insights/accounts?range=365d`);
console.log('bad range', bad.status());
const foreign = await ctx.request.get(`${API}/api/projects/01NOTAPROJECT0000000000000/insights/accounts`);
console.log('unknown project', foreign.status());
if (!best) { console.log('no project'); process.exit(1); }
const errors = [];
for (const [w, h, name] of [[1280, 900, 'desktop'], [375, 667, 'phone']]) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: w, height: h });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); });
  page.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) errors.push(`${name}: ${r.status()} ${r.url()}`); });
  await page.goto(`${APP}/projects/${best.id}/insights/flow?range=90d`);
  await page.getByRole('tab', { name: 'Accounts', exact: true }).click();
  await page.getByTestId('insights-accounts').waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
  console.log(name, 'url', page.url());
  console.log(name, 'cards', await page.locator('[data-testid^="insights-account-"]').count(), 'chart', await page.getByTestId('insights-accounts-chart').count(), 'stall-list', await page.getByTestId('insights-stall-list').count());
  console.log(name, 'text', (await page.getByTestId('insights-accounts').innerText()).slice(0, 900).replace(/\n+/g, ' | '));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  console.log(name, 'overflow', overflow);
  await page.evaluate(() => { let n = document.querySelector('[data-testid="project-insights"]'); while (n) { n.style.overflow = 'visible'; n.style.height = 'auto'; n.style.maxHeight = 'none'; n = n.parentElement; } });
  await page.screenshot({ path: `${OUT}/staging-accounts-90d-${name}.png`, fullPage: true });
  if (name === 'desktop') {
    await page.getByRole('button', { name: '7 days' }).click();
    await page.waitForURL(/range=7d/);
    await page.getByText(/Runs per day by account|No runs in this range/).first().waitFor();
    console.log('7d text', (await page.getByTestId('insights-accounts').innerText()).slice(0, 300).replace(/\n+/g, ' | '));
    await page.screenshot({ path: `${OUT}/staging-accounts-7d-desktop.png`, fullPage: true });
  }
  await page.close();
}
console.log('errors', JSON.stringify(errors));
await browser.close();
