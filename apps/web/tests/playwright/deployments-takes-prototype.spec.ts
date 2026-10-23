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
  RELEASE_EVENTS,
  RELEASES,
  SYSTEM_INFO,
  TASK_TITLES,
  USER_ID,
  VOLUMES,
} from './deployments-takes-fixtures';

// Outside Playwright's outputDir, which every run wipes.
const OUT = resolve(process.cwd(), '../../.tmp/deploy-takes');
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
        const events = rest.match(/^\/releases\/([^/]+)\/events$/);
        if (events) return json(route, { events: RELEASE_EVENTS[events[1] ?? ''] ?? [] });
        if (rest === '/runtime-config')
          return json(route, CONFIG[envId] ?? { envVars: [], updatedAt: null, variableCount: 0, secretCount: 0 });
        if (rest === '/public-routes') return json(route, { publicRoutes: PUBLIC_ROUTES[envId] ?? [] });
        if (rest === '/custom-domains') return json(route, { customDomains: CUSTOM_DOMAINS[envId] ?? [] });
        if (rest === '/volumes') return json(route, { volumes: VOLUMES[envId] ?? [] });
        if (rest === '/containers') return json(route, CONTAINERS);
        if (rest === '/metrics') return json(route, { systemInfo: SYSTEM_INFO, nodeId: 'node-prod', fallbackMetrics: null });
        if (rest === '/logs') {
          if (envId === 'env-eu') return json(route, { entries: [], nextCursor: null, unavailableReason: 'node_agent_unreachable' });
          if (envId === 'env-docs' || envId === 'env-load')
            return json(route, { entries: [], nextCursor: null, unavailableReason: 'node_not_running' });
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
        await expect(page.getByText('production').filter({ visible: true }).first()).toBeVisible();
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

      // Each state names the sentence it must say, so a state that renders the wrong words fails.
      for (const [envId, label, says] of [
        ['env-prod', 'live', 'Running version 42.'],
        ['env-staging', 'failed-deploy', "Version 43 didn't start"],
        ['env-preview', 'deploying', take === 'a' ? 'Version 3 is starting' : 'Deploying version 3.'],
        ['env-eu', 'server-silent', "The server hasn't checked in for 3 hours"],
        ['env-qa', 'down', "SAM couldn't get a server for version 1"],
        ['env-demo', 'paused', 'Starting brings version 12 back'],
        ['env-sandbox', 'never-deployed', 'Nothing runs here until an agent deploys to it.'],
        ['env-docs', 'starting', 'Getting a server ready for version 7.'],
        ['env-load', 'pause-failed', 'SAM stopped partway, so the app may still be running.'],
      ] as const) {
        test(`detail — ${label}`, async ({ page }) => {
          await mockApi(page);
          await page.goto(envUrl(take, envId));
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
          await expect(page.getByText(says).filter({ visible: true }).first()).toBeVisible();
          if (label === 'live' && take === 'b') {
            // A release superseded before any server ran it says so, and offers no roll back.
            await expect(page.getByText('A newer version arrived before a server picked this one up.')).toBeVisible();
          }
          if (label === 'starting') {
            // Start resets the newest release to `created`; it is on its way, not skipped.
            await expect(page.getByText('Skipped', { exact: true })).toHaveCount(0);
          }
          await page.waitForTimeout(600);
          await assertNoOverflow(page);
          await capture(page, `${take}-detail-${label}`);
          await capture(page, `${take}-detail-${label}`, { full: true });
        });
      }
    });
  }
}

// ─── Interactions: the dialogs, sheets and menus each take opens ──────────────

for (const vp of VIEWPORTS) {
  test.describe(`Interactions — ${vp.label}`, () => {
    test.use({ viewport: vp.viewport, isMobile: vp.isMobile, hasTouch: vp.isMobile });

    if (TAKES.includes('a')) {
      test('create environment sheet', async ({ page }) => {
        await mockApi(page);
        await page.goto(listUrl('a'));
        await page.getByRole('button', { name: 'New', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByPlaceholder('staging').fill('staging-eu');
        await dialog.getByText('Only some agent profiles').click();
        await dialog.getByRole('button', { name: 'Release Captain' }).click();
        await dialog.getByRole('button', { name: 'Sol' }).click();
        await expect(dialog.getByRole('button', { name: 'Create environment' })).toBeEnabled();
        await dialog.getByRole('heading', { name: 'New environment' }).scrollIntoViewIfNeeded();
        await assertNoOverflow(page);
        await capture(page, 'x-create-environment');
      });

      test('A — add a domain', async ({ page }) => {
        await mockApi(page);
        await page.goto(envUrl('a', 'env-prod'));
        await page.getByRole('button', { name: 'Your domain' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByPlaceholder('shop.example.com').fill('eu.northwind.dev');
        await expect(dialog.getByText('eu.northwind.dev')).toBeVisible();
        // The sheet ends in the exact DNS record; show all of it, above the sticky buttons.
        await dialog.getByText('Points to').evaluate((el) => el.closest('div')?.scrollIntoView({ block: 'center' }));
        await expect(dialog.getByText('r1-web-3000-env-01m5prod.apps.sammy.party')).toBeInViewport();
        await assertNoOverflow(page);
        await capture(page, 'a-add-domain');
      });

      test('A — delete confirmation', async ({ page }) => {
        await mockApi(page);
        await page.goto(envUrl('a', 'env-prod'));
        await page.getByRole('button', { name: 'Delete…' }).click();
        const dialog = page.getByRole('dialog');
        await dialog.getByRole('textbox').fill('produc');
        await expect(dialog.getByRole('button', { name: 'Delete forever' })).toBeDisabled();
        await assertNoOverflow(page);
        await capture(page, 'a-delete');
      });

      test('A — logs from a problem', async ({ page }) => {
        await mockApi(page);
        await page.goto(envUrl('a', 'env-staging'));
        await page.getByRole('button', { name: 'See logs' }).first().click();
        await expect(page.getByRole('dialog').getByText(/ECONNREFUSED/)).toBeVisible();
        await assertNoOverflow(page);
        await capture(page, 'a-logs');
      });

      test('A — who can deploy, only these', async ({ page }) => {
        await mockApi(page);
        await page.goto(envUrl('a', 'env-staging'));
        await page.getByRole('radio', { name: 'Only these' }).click();
        const section = page.getByRole('region', { name: 'Who can deploy' });
        await expect(section.getByText('Pick at least one profile')).toBeVisible();
        await section.scrollIntoViewIfNeeded();
        await assertNoOverflow(page);
        await capture(page, 'a-who-can-deploy');
      });

      test('A — behind the scenes', async ({ page }) => {
        await mockApi(page);
        await page.goto(envUrl('a', 'env-prod'));
        const summary = page.locator('summary', { hasText: 'Behind the scenes' });
        await summary.click();
        await expect(page.getByText('deploy-prod-01')).toBeVisible();
        await summary.scrollIntoViewIfNeeded();
        await assertNoOverflow(page);
        await capture(page, 'a-behind-the-scenes');
      });
    }

    if (TAKES.includes('b')) {
      test('B — settings pane and sheet', async ({ page }) => {
        await mockApi(page);
        await page.goto(envUrl('b', 'env-prod'));
        if (vp.isMobile) {
          await page.getByRole('tab', { name: 'Settings' }).click();
          await assertNoOverflow(page);
          await capture(page, 'b-pane-settings');
        }
        await page.getByRole('button', { name: /Who can deploy/ }).click();
        await expect(page.getByRole('dialog').getByText('Agents can deploy here')).toBeVisible();
        await assertNoOverflow(page);
        await capture(page, 'b-sheet-who-can-deploy');
      });

      test('B — settings and secrets sheet', async ({ page }) => {
        await mockApi(page);
        await page.goto(envUrl('b', 'env-prod'));
        if (vp.isMobile) await page.getByRole('tab', { name: 'Settings' }).click();
        await page.getByRole('button', { name: /Settings and secrets/ }).click();
        await expect(page.getByRole('dialog').getByText('STRIPE_SECRET_KEY')).toBeVisible();
        await assertNoOverflow(page);
        await capture(page, 'b-sheet-settings');
      });

      test('B — health pane', async ({ page }) => {
        await mockApi(page);
        await page.goto(envUrl('b', 'env-eu'));
        if (vp.isMobile) await page.getByRole('tab', { name: 'Health' }).click();
        await expect(page.getByText('Server', { exact: true }).filter({ visible: true }).first()).toBeVisible();
        await assertNoOverflow(page);
        await capture(page, 'b-pane-health');
      });

      test('B — more menu', async ({ page }) => {
        await mockApi(page);
        await page.goto(envUrl('b', 'env-prod'));
        await page.getByRole('button', { name: 'More actions' }).click();
        await expect(page.getByRole('menuitem', { name: /Delete environment/ })).toBeVisible();
        await assertNoOverflow(page);
        await capture(page, 'b-menu');
      });

      test('B — roll back', async ({ page }) => {
        await mockApi(page);
        await page.goto(envUrl('b', 'env-prod'));
        await page.getByRole('button', { name: 'Roll back to this' }).first().click();
        await expect(page.getByRole('dialog').getByText('Roll back to v41?')).toBeVisible();
        await assertNoOverflow(page);
        await capture(page, 'b-rollback');
      });
    }
  });
}

// ─── Today's pages, same data: the "before" for every comparison ─────────────

if (process.env.BEFORE === '1') {
  for (const vp of VIEWPORTS) {
    test.describe(`Before — ${vp.label}`, () => {
      test.use({ viewport: vp.viewport, isMobile: vp.isMobile, hasTouch: vp.isMobile });

      test('list', async ({ page }) => {
        await mockApi(page);
        await page.goto(`/projects/${PROJECT_ID}/deployments`);
        await expect(page.getByRole('heading', { name: 'Deployments' })).toBeVisible();
        await page.waitForTimeout(600);
        await capture(page, 'now-list');
        await capture(page, 'now-list', { full: true });
      });

      for (const [envId, label] of [
        ['env-prod', 'live'],
        ['env-staging', 'failed-deploy'],
        ['env-eu', 'server-silent'],
      ] as const) {
        test(`detail — ${label}`, async ({ page }) => {
          await mockApi(page);
          await page.goto(`/projects/${PROJECT_ID}/deployments/${envId}`);
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
          await page.waitForTimeout(600);
          await capture(page, `now-detail-${label}`);
          await capture(page, `now-detail-${label}`, { full: true });
        });
      }

      for (const tab of ['domains', 'volumes', 'config', 'policy', 'logs', 'node']) {
        test(`production tab — ${tab}`, async ({ page }) => {
          await mockApi(page);
          await page.goto(`/projects/${PROJECT_ID}/deployments/env-prod?tab=${tab}`);
          await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
          await page.waitForTimeout(900);
          await capture(page, `now-tab-${tab}`, { full: true });
        });
      }
    });
  }
}
