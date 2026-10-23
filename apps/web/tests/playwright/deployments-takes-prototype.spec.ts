/**
 * PROTOTYPE screenshot run for the deployment redesign takes (task 01M5N1SJZHRS7VKWX2DPCJ0P08).
 * Never merge to main. Needs the dev server (the `?take=` switch is dev-only):
 *
 *   VITE_API_URL=http://localhost:4173 npx vite --port 4173
 *   npx playwright test tests/playwright/deployments-takes-prototype.spec.ts --project="Desktop (1280x800)"
 *
 * The mock matches on the URL path, not a `**\/api/**` glob: in dev mode that glob also
 * swallows the app's own `/src/lib/api/*.ts` modules.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, seedTheme } from './audit-helpers';
import {
  CONFIG,
  CONTAINERS,
  CUSTOM_DOMAINS,
  ENVIRONMENTS,
  LOGS,
  MOCK_PROJECT,
  MOCK_USER,
  PROFILES,
  PROJECT_ID,
  PUBLIC_ROUTES,
  RELEASES,
  SYSTEM_INFO,
  TASK_TITLES,
  USER_ID,
  VOLUMES,
} from './deployments-takes-fixtures';

const OUT = resolve(process.cwd(), '../../.codex/tmp/playwright-screenshots/takes');
const TAKES = (process.env.TAKES ?? 'a,b').split(',') as Array<'a' | 'b'>;

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function mockApi(page: Page, opts: { environments?: unknown[] } = {}) {
  const environments = opts.environments ?? ENVIRONMENTS;
  await seedTheme(page, 'dark');
  await page.addInitScript((uid) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${uid}`, 'true');
  }, USER_ID);
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname;
      const method = route.request().method();
      const envMatch = path.match(/^\/api\/projects\/[^/]+\/environments\/([^/]+)(\/.*)?$/);

      if (path === '/api/auth/get-session') return json(route, MOCK_USER);
      if (path === '/api/github/installations') return json(route, []);
      if (path === '/api/projects') return json(route, { projects: [MOCK_PROJECT], total: 1 });
      if (path === '/api/agents') return json(route, { agents: [] });
      if (path === '/api/credentials') return json(route, []);
      if (path === '/api/credentials/agent') return json(route, { credentials: [] });
      if (path === '/api/notifications') return json(route, { notifications: [], unreadCount: 0, nextCursor: null });
      if (path === '/api/trial/status') return json(route, { available: false });
      if (path === '/api/providers/catalog') return json(route, { catalogs: [] });
      if (path === `/api/projects/${PROJECT_ID}`) return json(route, MOCK_PROJECT);
      if (path === `/api/projects/${PROJECT_ID}/agent-profiles`) return json(route, { items: PROFILES });
      const task = path.match(/^\/api\/projects\/[^/]+\/tasks\/([^/]+)$/);
      if (task) {
        const id = task[1] ?? '';
        return json(route, { id, projectId: PROJECT_ID, title: TASK_TITLES[id] ?? 'A chat', status: 'completed' });
      }
      if (path === `/api/projects/${PROJECT_ID}/environments`) {
        if (method === 'POST') return json(route, { ...ENVIRONMENTS[6], id: 'env-new', name: 'staging-2' });
        return json(route, { environments });
      }
      if (envMatch) {
        const envId = envMatch[1] ?? '';
        const rest = envMatch[2] ?? '';
        const env = environments.find((item) => (item as { id: string }).id === envId);
        if (rest === '/releases') return json(route, { releases: RELEASES[envId] ?? [] });
        if (rest === '/runtime-config')
          return json(route, CONFIG[envId] ?? { envVars: [], updatedAt: null, variableCount: 0, secretCount: 0 });
        if (rest === '/public-routes') return json(route, { publicRoutes: PUBLIC_ROUTES[envId] ?? [] });
        if (rest === '/custom-domains') return json(route, { customDomains: CUSTOM_DOMAINS[envId] ?? [] });
        if (rest === '/volumes') return json(route, { volumes: VOLUMES[envId] ?? [] });
        if (rest === '/containers') return json(route, CONTAINERS);
        if (rest === '/metrics') return json(route, { systemInfo: SYSTEM_INFO, nodeId: 'node-prod', fallbackMetrics: null });
        if (rest === '/logs') {
          if (envId === 'env-eu') return json(route, { entries: [], nextCursor: null, unavailableReason: 'node_stale' });
          const level = url.searchParams.get('level');
          const entries = (LOGS[envId] ?? []) as Array<{ level: string }>;
          return json(route, { entries: level ? entries.filter((e) => e.level === level) : entries, nextCursor: null });
        }
        if (rest === '/policy') return json(route, env);
        return json(route, env ?? {});
      }
      return json(route, {});
    }
  );
}

/**
 * The app scrolls inside its own containers, so a document "full page" capture stops at
 * the fold. Grow the viewport by the largest hidden scroll height instead.
 */
async function grow(page: Page) {
  const original = page.viewportSize();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const extra = await page.evaluate(() => {
      let most = 0;
      for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const style = getComputedStyle(element);
        if (!['auto', 'scroll'].includes(style.overflowY)) continue;
        most = Math.max(most, element.scrollHeight - element.clientHeight);
      }
      return most;
    });
    const size = page.viewportSize();
    if (!size || extra <= 1) break;
    await page.setViewportSize({ width: size.width, height: size.height + extra });
    await page.waitForTimeout(250);
  }
  return original;
}

async function capture(page: Page, name: string, opts: { full?: boolean } = {}) {
  mkdirSync(OUT, { recursive: true });
  await page.waitForTimeout(500);
  const size = opts.full ? await grow(page) : page.viewportSize();
  await page.waitForTimeout(300);
  const width = size?.width ?? 0;
  await page.screenshot({ path: `${OUT}/${name}-${width}${opts.full ? '-full' : ''}.png` });
  if (opts.full && size) await page.setViewportSize(size);
}

const envUrl = (take: string, envId: string) => `/projects/${PROJECT_ID}/deployments/${envId}?take=${take}`;
const listUrl = (take: string) => `/projects/${PROJECT_ID}/deployments?take=${take}`;

const VIEWPORTS = [
  { label: 'desktop', viewport: { width: 1280, height: 800 }, isMobile: false },
  { label: 'mobile', viewport: { width: 375, height: 667 }, isMobile: true },
] as const;

for (const take of TAKES) {
  for (const vp of VIEWPORTS) {
    test.describe(`Take ${take.toUpperCase()} — ${vp.label}`, () => {
      test.use({ viewport: vp.viewport, isMobile: vp.isMobile, hasTouch: vp.isMobile });

      test('list', async ({ page }) => {
        await mockApi(page);
        await page.goto(listUrl(take));
        await expect(page.getByRole('heading', { name: 'Deployments', level: 1 })).toBeVisible();
        await expect(page.getByText('production').first()).toBeVisible();
        await assertNoOverflow(page);
        await capture(page, `${take}-list`);
        await capture(page, `${take}-list`, { full: true });
      });

      test('list — empty', async ({ page }) => {
        await mockApi(page, { environments: [] });
        await page.goto(listUrl(take));
        await expect(page.getByRole('heading', { name: 'Deployments', level: 1 })).toBeVisible();
        await page.waitForTimeout(400);
        await assertNoOverflow(page);
        await capture(page, `${take}-list-empty`);
      });

      for (const [envId, label] of [
        ['env-prod', 'live'],
        ['env-staging', 'failed-deploy'],
        ['env-preview', 'deploying'],
        ['env-eu', 'server-silent'],
        ['env-qa', 'down'],
        ['env-demo', 'paused'],
        ['env-sandbox', 'never-deployed'],
      ] as const) {
        test(`detail — ${label}`, async ({ page }) => {
          await mockApi(page);
          await page.goto(envUrl(take, envId));
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
          await page.waitForTimeout(600);
          await assertNoOverflow(page);
          await capture(page, `${take}-detail-${label}`);
          await capture(page, `${take}-detail-${label}`, { full: true });
        });
      }
    });
  }
}
