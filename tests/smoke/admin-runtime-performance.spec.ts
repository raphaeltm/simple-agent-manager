import { mkdir, writeFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';

import { loginWithToken } from './helpers/auth';

test.describe.configure({ retries: 0 });

const DEFAULT_AUDIT_TIMEOUT_MS = 30_000;
const auditTimeoutMs =
  Number(process.env.SAM_PERFORMANCE_AUDIT_TIMEOUT_MS) || DEFAULT_AUDIT_TIMEOUT_MS;

test('bounded admin and Runtime performance audit', async ({ context }, info) => {
  test.skip(process.env.SAM_PERFORMANCE_AUDIT !== 'true', 'Opt-in staging performance audit');
  test.setTimeout(auditTimeoutMs * 20);
  const api = process.env.SMOKE_TEST_API_URL || 'https://api.sammy.party';
  const app = process.env.SMOKE_TEST_URL || 'https://app.sammy.party';
  const page = await loginWithToken(context, {
    apiUrl: api,
    appUrl: app,
    waitUntil: 'domcontentloaded',
  });
  const session = await (
    await page.request.get(`${api}/api/auth/get-session`, { timeout: auditTimeoutMs })
  ).json();
  expect(session.user.role, 'Performance audit requires the staging superadmin smoke account').toBe(
    'superadmin'
  );
  await page.evaluate(
    (id) => localStorage.setItem(`sam-onboarding-wizard-dismissed-${id}`, 'true'),
    session.user.id
  );
  const projects = await (
    await page.request.get(`${api}/api/projects?limit=1`, { timeout: auditTimeoutMs })
  ).json();
  const projectId = projects.projects[0]?.id as string | undefined;
  expect(projectId, 'Performance audit requires an accessible staging project').toBeTruthy();
  const output = info.outputPath('performance');
  await mkdir(output, { recursive: true });
  const startedAt = new Date().toISOString();
  const endpoints = [
    '/api/github/installations',
    '/api/admin/agent-email',
    '/api/admin/agent-email/setup',
    '/api/admin/settings',
    '/api/admin/connector/settings',
    '/api/admin/connector/clients',
    '/api/admin/platform-config',
    '/api/admin/platform-credentials',
    '/api/admin/ai-proxy/config',
    '/api/admin/trials/config',
    '/api/admin/quotas/users',
    '/api/admin/usage/nodes',
    '/api/admin/observability/errors',
    '/api/admin/observability/diagnoses?summaryOnly=true',
    '/api/admin/capacity-pools/defaults',
    '/api/admin/costs',
    `/api/projects/${projectId}`,
    `/api/projects/${projectId}/runtime-config`,
  ];
  const timings = [];
  // Limit audit concurrency; each response body is included in the measured wall time.
  for (let index = 0; index < endpoints.length; index += 3) {
    timings.push(
      ...(await Promise.all(
        endpoints.slice(index, index + 3).map(async (path) => {
          const start = performance.now();
          try {
            const response = await page.request.get(`${api}${path}`, { timeout: auditTimeoutMs });
            await response.body();
            return {
              path,
              status: response.status(),
              wallMs: Math.round(performance.now() - start),
            };
          } catch {
            return { path, status: 'deadline', wallMs: Math.round(performance.now() - start) };
          }
        })
      ))
    );
  }
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.name));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push('browser console error');
  });
  const routes = [
    [`/projects/${projectId}/settings/runtime`, 'Runtime Config'],
    ['/admin/integrations', 'GitHub OAuth'],
    ['/admin/settings', 'Runtime settings'],
    ['/admin/users', 'Signup approval'],
    ['/admin/diagnoses', 'All diagnosis runs'],
    ['/admin/infrastructure', 'Refresh machine list'],
    ['/admin/quotas', 'Default Quota'],
    ['/admin/analytics', 'Analytics'],
    ['/admin/costs', 'LLM'],
  ];
  const browserTimings = [];
  await writeFile(`${output}/timings.json`, JSON.stringify({ startedAt, timings }, null, 2));
  for (const width of [375, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [path, content] of routes) {
      const start = performance.now();
      await page.goto(`${app}${path}`, { waitUntil: 'domcontentloaded', timeout: auditTimeoutMs });
      const ready =
        path === '/admin/infrastructure'
          ? page.getByRole('button', { name: 'Refresh machine list' }).first()
          : path === '/admin/analytics'
            ? page.getByRole('heading', { name: 'Analytics', exact: true })
            : page.getByText(content!, { exact: false }).first();
      await expect(ready).toBeVisible({ timeout: auditTimeoutMs });
      if (path!.endsWith('/settings/runtime')) {
        await expect(
          page.getByRole('heading', { name: 'Environment Variables', exact: true })
        ).toBeVisible({ timeout: auditTimeoutMs });
        await expect(page.getByText('Loading runtime config...')).toHaveCount(0);
      }
      await expect(page.getByText('Something went wrong')).toHaveCount(0);
      browserTimings.push({ path, width, contentMs: Math.round(performance.now() - start) });
      await writeFile(
        `${output}/timings.json`,
        JSON.stringify({ startedAt, timings, browserTimings, errors }, null, 2)
      );
      await page.screenshot({
        path: `${output}/${width}-${path!.split('/').pop()}.png`,
        fullPage: true,
      });
    }
  }
  // Exercise navigation from chat, then the real reconcile control without creating compute.
  await page.goto(`${app}/projects/${projectId}/chat`, {
    waitUntil: 'domcontentloaded',
    timeout: auditTimeoutMs,
  });
  await page.getByRole('link', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('tab', { name: 'Runtime', exact: true }).click();
  await expect(page.getByText('Runtime Config', { exact: true })).toBeVisible({
    timeout: auditTimeoutMs,
  });
  await expect(
    page.getByRole('heading', { name: 'Environment Variables', exact: true })
  ).toBeVisible({ timeout: auditTimeoutMs });
  // Hold any revalidation so cached content, rather than a fast server, must satisfy revisits.
  const cachedRevisits = [
    {
      path: `/projects/${projectId}/settings/runtime`,
      apiPath: `/api/projects/${projectId}/runtime-config`,
      content: 'Runtime Config',
      away: 'General',
      back: 'Runtime',
    },
    {
      path: '/admin/settings',
      apiPath: '/api/admin/settings',
      content: 'Runtime settings',
      away: 'Quotas',
      back: 'Settings',
    },
  ];
  for (const revisit of cachedRevisits) {
    await page.goto(`${app}${revisit.path}`, {
      waitUntil: 'domcontentloaded',
      timeout: auditTimeoutMs,
    });
    await expect(page.getByText(revisit.content, { exact: true })).toBeVisible({
      timeout: auditTimeoutMs,
    });
    await expect(page.getByText('Loading runtime config...')).toHaveCount(0);
    await page.getByRole('tab', { name: revisit.away, exact: true }).click();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pattern = `${api}${revisit.apiPath}`;
    await page.route(pattern, async (route) => {
      await gate;
      await route.continue();
    });
    try {
      const start = performance.now();
      await page.getByRole('tab', { name: revisit.back, exact: true }).click();
      await expect(page.getByText(revisit.content, { exact: true })).toBeVisible({
        timeout: auditTimeoutMs,
      });
      await expect(page.getByText('Loading runtime config...')).toHaveCount(0);
      browserTimings.push({
        path: revisit.path,
        width: 1280,
        contentMs: Math.round(performance.now() - start),
        cachedRevisit: true,
      });
    } finally {
      release();
      await page.unroute(pattern);
    }
  }
  await page.goto(`${app}/admin/infrastructure`, {
    waitUntil: 'domcontentloaded',
    timeout: auditTimeoutMs,
  });
  const reconcileStart = performance.now();
  const reconcile = page.waitForResponse(
    (response) => response.url().includes('/capacity-pools/defaults/reconcile'),
    { timeout: auditTimeoutMs * 3 }
  );
  await page.getByRole('button', { name: 'Refresh machine list' }).first().click();
  const response = await reconcile;
  timings.push({
    path: '/api/admin/capacity-pools/defaults/reconcile',
    status: response.status(),
    wallMs: Math.round(performance.now() - reconcileStart),
  });
  const report = {
    startedAt,
    endedAt: new Date().toISOString(),
    auditCodeSha: process.env.GITHUB_SHA,
    timings,
    browserTimings,
    errors,
  };
  await writeFile(`${output}/timings.json`, JSON.stringify(report, null, 2));
  console.log('PERFORMANCE_AUDIT', JSON.stringify(report));
  expect(errors).toEqual([]);
});
