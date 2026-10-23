/**
 * Deployments pages audit: the list and one environment, at 375 px and 1280 px, with every
 * environment state, long names, empty and failed loads, and the dialogs. Each state asserts
 * the sentence it must say, so a page that renders the wrong words fails, not just one that
 * overflows.
 *
 * The API mock matches on the URL path, not a `**\/api/**` glob: in dev mode that glob also
 * catches the app's own `/src/lib/api/*.ts` modules.
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
} from './deployments-ui-fixtures';

const OUT = resolve(process.cwd(), '../../.codex/tmp/playwright-screenshots/deployments');

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

interface MockOptions {
  environments?: unknown[];
  /** Path suffixes (after `/environments/:id`) that answer 500, or 'list' for the list itself. */
  failing?: string[];
}

interface PolicyWrite {
  envId: string;
  body: Record<string, unknown>;
}

async function mockApi(page: Page, opts: MockOptions = {}): Promise<PolicyWrite[]> {
  const environments = opts.environments ?? ENVIRONMENTS;
  const failing = new Set(opts.failing ?? []);
  const policyWrites: PolicyWrite[] = [];
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
      if (path === '/api/notifications')
        return json(route, { notifications: [], unreadCount: 0, nextCursor: null });
      if (path === '/api/trial/status') return json(route, { available: false });
      if (path === '/api/providers/catalog') return json(route, { catalogs: [] });
      if (path === `/api/projects/${PROJECT_ID}`) return json(route, MOCK_PROJECT);
      if (path === `/api/projects/${PROJECT_ID}/agent-profiles`)
        return json(route, { items: PROFILES });
      const task = path.match(/^\/api\/projects\/[^/]+\/tasks\/([^/]+)$/);
      if (task) {
        const id = task[1] ?? '';
        return json(route, {
          id,
          projectId: PROJECT_ID,
          title: TASK_TITLES[id] ?? 'A chat',
          status: 'completed',
        });
      }
      if (path === `/api/projects/${PROJECT_ID}/environments`) {
        if (failing.has('list'))
          return json(route, { error: 'INTERNAL_ERROR', message: 'D1 is unavailable' }, 500);
        if (method === 'POST')
          return json(route, { ...ENVIRONMENTS[6], id: 'env-new', name: 'staging-eu' });
        return json(route, { environments });
      }
      if (envMatch) {
        const envId = envMatch[1] ?? '';
        const rest = envMatch[2] ?? '';
        const env = environments.find((item) => (item as { id: string }).id === envId);
        if (failing.has(rest))
          return json(route, { error: 'INTERNAL_ERROR', message: 'Upstream read failed' }, 500);
        if (rest === '/policy' && method === 'PATCH') {
          policyWrites.push({
            envId,
            body: route.request().postDataJSON() as Record<string, unknown>,
          });
          return json(route, env ?? {});
        }
        if (rest === '/releases') return json(route, { releases: RELEASES[envId] ?? [] });
        const events = rest.match(/^\/releases\/([^/]+)\/events$/);
        if (events) return json(route, { events: RELEASE_EVENTS[events[1] ?? ''] ?? [] });
        if (rest === '/runtime-config')
          return json(
            route,
            CONFIG[envId] ?? { envVars: [], updatedAt: null, variableCount: 0, secretCount: 0 }
          );
        if (rest === '/public-routes')
          return json(route, { publicRoutes: PUBLIC_ROUTES[envId] ?? [] });
        if (rest === '/custom-domains')
          return json(route, { customDomains: CUSTOM_DOMAINS[envId] ?? [] });
        if (rest === '/volumes') return json(route, { volumes: VOLUMES[envId] ?? [] });
        if (rest === '/containers') return json(route, CONTAINERS);
        if (rest === '/metrics')
          return json(route, {
            systemInfo: SYSTEM_INFO,
            nodeId: 'node-prod',
            fallbackMetrics: null,
          });
        if (rest === '/logs') {
          if (envId === 'env-eu')
            return json(route, {
              entries: [],
              nextCursor: null,
              unavailableReason: 'node_agent_unreachable',
            });
          if (envId === 'env-docs' || envId === 'env-load')
            return json(route, {
              entries: [],
              nextCursor: null,
              unavailableReason: 'node_not_running',
            });
          const level = url.searchParams.get('level');
          const entries = (LOGS[envId] ?? []) as Array<{ level: string }>;
          return json(route, {
            entries: level ? entries.filter((entry) => entry.level === level) : entries,
            nextCursor: null,
          });
        }
        return json(route, env ?? {});
      }
      return json(route, {});
    }
  );
  return policyWrites;
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
  await page.waitForTimeout(300);
  const size = opts.full ? await grow(page) : page.viewportSize();
  const width = size?.width ?? 0;
  await page.screenshot({ path: `${OUT}/${name}-${width}${opts.full ? '-full' : ''}.png` });
  if (opts.full && size) await page.setViewportSize(size);
}

const envUrl = (envId: string) => `/projects/${PROJECT_ID}/deployments/${envId}`;
const listUrl = `/projects/${PROJECT_ID}/deployments`;

const VIEWPORTS = [
  { label: 'desktop', viewport: { width: 1280, height: 800 }, isMobile: false },
  { label: 'mobile', viewport: { width: 375, height: 667 }, isMobile: true },
] as const;

for (const vp of VIEWPORTS) {
  test.describe(`Deployments — ${vp.label}`, () => {
    test.use({ viewport: vp.viewport, isMobile: vp.isMobile, hasTouch: vp.isMobile });

    test('list groups environments by what they need', async ({ page }) => {
      await mockApi(page);
      await page.goto(listUrl);
      await expect(page.getByRole('heading', { name: 'Deployments', level: 1 })).toBeVisible();
      const attention = page.getByRole('region', { name: 'Needs your attention' });
      await expect(attention.getByText("Version 43 didn't start")).toBeVisible();
      await expect(attention.getByText("SAM couldn't get a server for version 1")).toBeVisible();
      // The address people visit: the custom domain, not the generated hostname.
      await expect(page.getByText('shop.northwind.dev').first()).toBeVisible();
      await assertNoOverflow(page);
      await capture(page, 'list');
      await capture(page, 'list', { full: true });
    });

    test('list — empty', async ({ page }) => {
      await mockApi(page, { environments: [] });
      await page.goto(listUrl);
      await expect(page.getByRole('heading', { name: 'Nothing deployed yet' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'How deployments work' })).toHaveAttribute(
        'href',
        /\/docs\/guides\/app-deployments\/$/
      );
      await assertNoOverflow(page);
      await capture(page, 'list-empty');
    });

    test('list — failed load offers a retry', async ({ page }) => {
      await mockApi(page, { failing: ['list'] });
      await page.goto(listUrl);
      await expect(page.getByText(/Could not load/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
      await assertNoOverflow(page);
    });

    // Each state names the sentence it must say.
    for (const [envId, label, says] of [
      ['env-prod', 'live', 'Running version 42.'],
      ['env-staging', 'failed-deploy', "Version 43 didn't start"],
      ['env-preview', 'deploying', 'Version 3 is starting'],
      ['env-eu', 'server-silent', "The server hasn't checked in for 3 hours"],
      ['env-qa', 'down', "SAM couldn't get a server for version 1"],
      ['env-demo', 'paused', 'Starting brings version 12 back'],
      ['env-sandbox', 'never-deployed', 'Nothing runs here until an agent deploys to it.'],
      ['env-docs', 'starting', 'Getting a server ready for version 7.'],
      ['env-load', 'pause-failed', 'SAM stopped partway, so the app may still be running.'],
    ] as const) {
      test(`environment — ${label}`, async ({ page }) => {
        await mockApi(page);
        await page.goto(envUrl(envId));
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.getByText(says).filter({ visible: true }).first()).toBeVisible();
        if (label === 'failed-deploy') {
          // The failed version shows its steps: what broke, and that the old version came back.
          const steps = page.getByRole('list', { name: 'Steps for version 43' });
          await expect(steps.getByText("The app didn't start")).toBeVisible();
          await expect(steps.getByText('Put the previous version back')).toBeVisible();
          // The status names v42, and so does the credit beside it.
          await expect(page.getByText(/v42 by Opus 5\.5 Chat/)).toBeVisible();
        }
        if (label === 'deploying') {
          await expect(
            page.getByRole('list', { name: 'Steps for version 3' }).getByText('Starting the app…')
          ).toBeVisible();
        }
        if (label === 'live') {
          await expect(
            page.getByText('A newer version arrived before a server picked this one up.')
          ).toHaveCount(0);
          await page.getByRole('button', { name: 'Show all 6' }).click();
          await expect(
            page.getByText('A newer version arrived before a server picked this one up.')
          ).toBeVisible();
        }
        if (label === 'starting') {
          // Start resets the newest release to `created`: it is on its way, not skipped.
          await expect(page.getByText('Skipped', { exact: true })).toHaveCount(0);
        }
        if (label === 'down') {
          // No server ever ran: no logs to offer.
          await expect(page.getByRole('button', { name: 'Logs' })).toHaveCount(0);
        }
        await assertNoOverflow(page);
        await capture(page, `environment-${label}`);
        await capture(page, `environment-${label}`, { full: true });
      });
    }

    test('environment — a failed section load says so and the rest renders', async ({ page }) => {
      await mockApi(page, { failing: ['/releases', '/runtime-config'] });
      await page.goto(envUrl('env-prod'));
      await expect(page.getByText(/Could not load recent deploys/)).toBeVisible();
      await expect(page.getByText(/Could not load the settings/)).toBeVisible();
      await expect(page.getByRole('region', { name: 'Who can deploy' })).toBeVisible();
      await assertNoOverflow(page);
    });

    test('new environment needs an access choice before it can be created', async ({ page }) => {
      await mockApi(page);
      await page.goto(listUrl);
      await page.getByRole('button', { name: 'New', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByPlaceholder('staging').fill('staging-eu');
      const create = dialog.getByRole('button', { name: 'Create environment' });
      await expect(create).toBeDisabled();
      await dialog.getByText('Only some agent profiles').click();
      await expect(create).toBeDisabled();
      await dialog.getByRole('button', { name: 'Release Captain' }).click();
      await expect(create).toBeEnabled();
      await dialog.getByRole('heading', { name: 'New environment' }).scrollIntoViewIfNeeded();
      await assertNoOverflow(page);
      await capture(page, 'create-environment');
    });

    test('turning agent deploys on never grants access until a choice is made', async ({
      page,
    }) => {
      const writes = await mockApi(page);
      await page.goto(envUrl('env-sandbox'));
      const section = page.getByRole('region', { name: 'Who can deploy' });
      await section.getByRole('switch', { name: 'Agents can deploy here' }).click();
      await expect(
        section.getByText('Choose who first. Nothing changes until you do.')
      ).toBeVisible();
      expect(writes).toEqual([]);
      await section.getByRole('radio', { name: 'Any agent in this project' }).click();
      await expect.poll(() => writes.length).toBe(1);
      expect(writes[0]).toEqual({
        envId: 'env-sandbox',
        body: { agentDeployEnabled: true, allowedDeployProfileIds: [] },
      });
    });

    test('"Only these" with nobody picked warns that any agent can still deploy', async ({
      page,
    }) => {
      const writes = await mockApi(page);
      await page.goto(envUrl('env-staging'));
      const section = page.getByRole('region', { name: 'Who can deploy' });
      await section.getByRole('radio', { name: 'Only these' }).click();
      await expect(section.getByText(/Pick at least one profile/)).toBeVisible();
      expect(writes).toEqual([]);
      await section.scrollIntoViewIfNeeded();
      await assertNoOverflow(page);
      await capture(page, 'who-can-deploy');
    });

    test('your own domain ends in the exact DNS record', async ({ page }) => {
      await mockApi(page);
      await page.goto(envUrl('env-prod'));
      await page.getByRole('button', { name: 'Your domain' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByPlaceholder('shop.example.com').fill('eu.northwind.dev');
      await expect(dialog.getByText('eu.northwind.dev')).toBeVisible();
      await dialog
        .getByText('Points to')
        .evaluate((element) => element.closest('div')?.scrollIntoView({ block: 'center' }));
      await expect(dialog.getByText('r1-web-3000-env-01m5prod.apps.sammy.party')).toBeInViewport();
      await assertNoOverflow(page);
      await capture(page, 'add-domain');
    });

    test('delete needs the environment name typed', async ({ page }) => {
      await mockApi(page);
      await page.goto(envUrl('env-prod'));
      await page.getByRole('button', { name: 'Delete…' }).click();
      const dialog = page.getByRole('dialog');
      const confirm = dialog.getByRole('button', { name: 'Delete forever' });
      await dialog.getByRole('textbox').fill('produc');
      await expect(confirm).toBeDisabled();
      await assertNoOverflow(page);
      await capture(page, 'delete');
      await dialog.getByRole('textbox').fill('production');
      await expect(confirm).toBeEnabled();
    });

    test('logs open from a problem, filtered to errors', async ({ page }) => {
      await mockApi(page);
      await page.goto(envUrl('env-staging'));
      await page.getByRole('button', { name: 'See logs' }).first().click();
      await expect(page.getByRole('dialog').getByText(/ECONNREFUSED/)).toBeVisible();
      await assertNoOverflow(page);
      await capture(page, 'logs');
      await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    test('behind the scenes shows the server and its hardware', async ({ page }) => {
      await mockApi(page);
      await page.goto(envUrl('env-prod'));
      const summary = page.locator('summary', { hasText: 'Behind the scenes' });
      await summary.click();
      await expect(page.getByText('deploy-prod-01')).toBeVisible();
      await expect(page.getByLabel('Hardware details')).toBeVisible();
      await summary.scrollIntoViewIfNeeded();
      await assertNoOverflow(page);
      await capture(page, 'behind-the-scenes');
    });

    test('"Ask an agent" opens a new chat about this environment', async ({ page }) => {
      await mockApi(page);
      // The chat page consumes and strips `deployHelp` on arrival, so record every URL.
      const visited: string[] = [];
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) visited.push(frame.url());
      });
      await page.goto(listUrl);
      await page
        .getByRole('region', { name: 'Needs your attention' })
        .getByRole('button', { name: 'Ask an agent' })
        .last()
        .click();
      await expect
        .poll(() =>
          visited.some((url) =>
            /\/projects\/[^/]+\/chat\?deployHelp=staging&deployIntent=fix$/.test(url)
          )
        )
        .toBe(true);
    });
  });
}
