import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Browser, chromium, expect, type Page } from '@playwright/test';

import { maintenanceSource } from '../src/maintenance';
import { digest } from '../src/security';
const output = '../../.codex/tmp/playwright-screenshots';

async function installFixtureRoutes(
  page: Page,
  getState: () => string,
  setState: (value: string) => void
) {
  await page.route('**/api/config', (r) =>
    r.fulfill({
      json: {
        configured: getState() !== 'unconfigured',
        fullInstaller: getState().startsWith('full-'),
        sourceUrl: 'https://github.com/raphaeltm/simple-agent-manager/tree/main/apps/installer',
        docsUrl: '/self-host.html',
        sha: 'audit-fixture',
      },
    })
  );
  await page.route('**/api/session/status', (r) =>
    ['connect', 'unconfigured', 'authorization'].includes(getState())
      ? r.fulfill({ status: 401, json: { error: 'Sign in' } })
      : r.fulfill({
          json: {
            currentCleanupReceipt: 'e'.repeat(64),
            accounts:
              getState() === 'empty'
                ? []
                : Array.from({ length: 35 }, (_, i) => ({
                    id: String(i).padStart(32, 'a'),
                    name:
                      i === 0
                        ? 'Organization <script>alert(1)</script> & équipe 🧑‍💻 '.repeat(6)
                        : `Account ${i}`,
                  })),
            job:
              getState() === 'ready' || getState() === 'pending'
                ? { status: getState(), name: 'sam-maintenance-1234567890123456' }
                : null,
          },
        })
  );
  await page.route('**/api/session/zones', (r) =>
    r.fulfill({ json: { zones: [{ id: 'b'.repeat(32), name: 'example.com' }] } })
  );
  await page.route('**/api/session/preview', (r) =>
    r.fulfill({
      json: {
        plan: {
          sourceCommit: 'c'.repeat(40),
          fingerprint: 'd'.repeat(64),
          workersDev: { action: 'create', subdomain: 'sam-account' },
          hostnames: [
            'api.sam.example.com',
            'app.sam.example.com',
            'preview.sam.example.com',
            '*.sam.example.com',
          ],
          conflicts:
            getState() === 'full-conflict' ? [{ name: 'api.sam.example.com', type: 'CNAME' }] : [],
        },
      },
    })
  );
  await page.route('**/api/session/install', (r) => {
    if (getState() === 'error')
      return r.fulfill({
        status: 500,
        json: { error: 'Cloudflare could not create the service. Please retry.' },
      });
    setState('ready');
    return r.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/session/reconcile-cleanup', async (r) => {
    expect(r.request().postDataJSON()).toEqual({
      receipt: 'd'.repeat(64),
      accountId: 'a'.repeat(31) + '0',
    });
    await r.fulfill({ json: { ok: true, authorityPreserved: true } });
  });
  await page.route('**/api/session/finish', (r) => r.fulfill({ json: { revoked: true } }));
}
async function assertNoOverflow(page: Page, label: string) {
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error(label + ' overflow');
}
async function captureMaintenanceControls(page: Page, target: string) {
  let screenshots = 0;
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme });
    for (const [device, width, height] of [
      ['mobile', 375, 667],
      ['desktop', 1280, 800],
      ['narrow', 320, 700],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(target);
      await page.evaluate(() => document.fonts.ready);
      await assertNoOverflow(page, 'Maintenance');
      await page.screenshot({
        path: output + '/installer-maintenance-controls-' + device + '-' + theme + '.png',
        fullPage: true,
      });
      screenshots++;
    }
  }

  return screenshots;
}
async function auditFullSettings(page: Page, scenario: string) {
  await expect(page.locator('#zone-id')).toHaveValue('b'.repeat(32));
  await page.locator('#owner-email').fill('owner+installation@example.com');
  await expect(page.locator('#install')).toBeDisabled();
  if (scenario !== 'full-account') {
    await page.locator('#preview').click();
    await expect(page.locator('#plan-summary')).toContainText(
      scenario === 'full-conflict' ? 'block installation' : 'Build source'
    );
    if (scenario === 'full-conflict') await expect(page.locator('#install')).toBeDisabled();
    else {
      await expect(page.locator('#plan-summary')).toContainText(
        'Initialize account address sam-account.workers.dev'
      );
      await expect(page.locator('#install')).toBeEnabled();
    }
  }
}
async function auditScenario(page: Page, scenario: string, baseUrl: string) {
  if (scenario === 'cleanup')
    await page.evaluate(() =>
      sessionStorage.setItem(
        'sam-installer-cleanup',
        JSON.stringify({ receipt: 'd'.repeat(64), accountId: 'a'.repeat(31) + '0' })
      )
    );
  await page.goto(baseUrl + (scenario === 'authorization' ? '/?error=authorization' : '/'));
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('#version')).toHaveText('Build audit-fixtur');
  if (scenario === 'connect') {
    await expect(page.locator('#login')).toBeEnabled();
    await page.getByText('What access am I granting?').click();
    await expect(page.getByText(/These may allow changes to existing Workers/)).toBeVisible();
    await page.getByText('What access am I granting?').click();
  }
  if (scenario.startsWith('full-')) await auditFullSettings(page, scenario);
  if (scenario === 'empty' || scenario === 'unconfigured')
    await expect(page.locator(scenario === 'empty' ? '#install' : '#login')).toBeDisabled();
  if (scenario === 'unconfigured') {
    await expect(page.locator('#message')).toContainText('not available');
    await expect(page.getByRole('link', { name: 'See setup options →' })).toHaveAttribute(
      'href',
      '/self-host.html'
    );
    await expect(page.locator('#explore')).toHaveAttribute('href', '/self-host.html');
  }
  if (scenario === 'cleanup') {
    await expect(page.locator('#cleanup-panel')).toBeVisible();
    await expect(page.locator('#cleanup-resume')).toBeVisible();
  }
  if (scenario === 'authorization')
    await expect(page.locator('#message')).toContainText('cancelled');
  if (scenario === 'error') {
    await page.locator('#confirm').check();
    await page.locator('#install').click();
    await expect(page.locator('#message')).toContainText('Please retry');
    await expect(page.locator('#install')).toBeEnabled();
  }
}
async function auditViewport(
  browser: Browser,
  theme: 'light' | 'dark',
  device: string,
  width: number,
  height: number,
  baseUrl: string
) {
  let screenshots = 0;
  const label = `${device}-${theme}`;
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
  let state = 'connect';
  await installFixtureRoutes(
    page,
    () => state,
    (value) => {
      state = value;
    }
  );
  for (const scenario of [
    'connect',
    'account',
    'full-account',
    'full-preview',
    'full-conflict',
    'empty',
    'ready',
    'pending',
    'unconfigured',
    'authorization',
    'error',
    'cleanup',
  ]) {
    state = scenario;
    await auditScenario(page, scenario, baseUrl);
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
      throw new Error(`Overflow ${label} ${scenario}`);
    await page.screenshot({
      path: `${output}/installer-${scenario}-${label}.png`,
      fullPage: true,
    });
    screenshots++;
  }
  // Exercise the real UI handlers across create -> ready -> disconnect.
  state = 'account';
  await page.goto(baseUrl);
  await page.locator('#confirm').check();
  await page.locator('#install').click();
  await expect(page.locator('#ready')).toBeVisible();
  await expect(page.locator('#step-handoff')).toHaveAttribute('aria-current', 'step');
  await page.locator('#disconnect').click();
  await expect(page.locator('#connect')).toBeVisible();
  await expect(page.locator('#step-connect')).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('.steps .completed')).toHaveCount(0);
  await page
    .getByRole('button', { name: theme === 'light' ? 'Dark theme' : 'Light theme' })
    .click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute(
    'data-theme',
    theme === 'light' ? 'dark' : 'light'
  );
  await page.getByRole('button', { name: 'System theme' }).click();
  await page.goto(baseUrl + '/privacy.html');
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error(`Privacy overflow ${label}`);
  await page.screenshot({ path: `${output}/installer-privacy-${label}.png`, fullPage: true });
  screenshots++;
  await page.goto(baseUrl + '/self-host.html');
  await expect(page.getByRole('heading', { name: '1. Get the source' })).toBeVisible();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error(`Self-host guide overflow ${label}`);
  await page.screenshot({
    path: `${output}/installer-self-host-${label}.png`,
    fullPage: true,
  });
  screenshots++;
  await page.close();
  return screenshots;
}
async function auditMaintenance(browser: Browser) {
  let screenshots = 2;
  const temp = await mkdtemp(join(tmpdir(), 'sam-installer-browser-'));
  execFileSync(
    '/usr/bin/openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(temp, 'key.pem'),
      '-out',
      join(temp, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ],
    { stdio: 'ignore' }
  );
  const tls = {
    key: await readFile(join(temp, 'key.pem')),
    cert: await readFile(join(temp, 'cert.pem')),
  };
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const key = 'synthetic-owner-key';
  // Execute the exact repository-owned ESM module, retaining its exports unchanged.
  const { MaintenanceCoordinator: Coordinator } = await import(
    'data:text/javascript;base64,' + Buffer.from(maintenanceSource).toString('base64')
  );
  const values = new Map();
  const storage = {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => values.set(key, structuredClone(value)),
    delete: async (key) => values.delete(key),
    transaction: async (work) => work(storage),
  };
  let origin = '',
    target = '';
  const env = {
    INSTALLER_ORIGIN: '',
    CLIENT_RECOVERY_REQUIRED: 'true',
    OWNER_KEY_HASH: await digest(key),
    CLAIM_EXPIRES: String(Date.now() + 60000),
  };
  const maintenance = new Coordinator({ storage }, env);
  const received: { path?: string; origin?: string }[] = [];
  const service = createServer(tls, async (req, res) => {
    received.push({ path: req.url, origin: req.headers.origin });
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await maintenance.fetch(
      new Request(target + req.url, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
      })
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });
  await new Promise((resolve) => service.listen(0, resolve));
  target = 'https://127.0.0.1:' + service.address().port;
  const handoffScript = await readFile('public/handoff.js', 'utf8');
  const installer = createServer(tls, (req, res) => {
    if (req.url === '/handoff.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(handoffScript);
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Referrer-Policy', 'strict-origin');
    res.end(
      '<script src="/handoff.js" defer></script><form id="maintenance-claim-form" method="POST" action="' +
        target +
        '/claim"><input name="key" value="' +
        key +
        '"><input id="maintenance-recovery" name="recovery" type="hidden"><input id="maintenance-recovery-display" readonly><input id="maintenance-recovery-saved" type="checkbox"><button id="maintenance-claim-submit" disabled>Continue</button></form>'
    );
  });
  await new Promise((resolve) => installer.listen(0, resolve));
  origin = 'https://localhost:' + installer.address().port;
  env.INSTALLER_ORIGIN = origin;
  await page.goto(origin);
  await expect(page.locator('#maintenance-recovery-display')).toHaveValue(/^[a-f0-9]{64}$/);
  await page.locator('#maintenance-recovery-saved').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Ownership handoff verified.').waitFor();
  await page.screenshot({ path: output + '/installer-handoff-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 667 });
  await page.screenshot({ path: output + '/installer-handoff-mobile.png', fullPage: true });

  let builderJob: Record<string, unknown> = { status: 'idle' };
  Object.assign(env, {
    CF_ACCOUNT_ID: 'a'.repeat(32),
    BUILDER_CONTROL_SECRET: 'synthetic-builder-control',
    INSTALLATION_CONFIG: JSON.stringify({
      accountId: 'a'.repeat(32),
      zoneId: 'b'.repeat(32),
      zoneName: 'example.com',
      baseDomain: 'sam.example.com',
      ownerEmail: 'owner@example.com',
      sourceCommit: 'c'.repeat(40),
    }),
    BUILDER: {
      idFromName: () => 'installation',
      get: () => ({
        fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          if (path === '/start') {
            const input = (await request.json()) as Record<string, unknown>;
            builderJob = {
              status: 'running',
              jobId: input.jobId,
              sourceCommit: input.sourceCommit,
            };
          }
          if (path === '/result')
            return Response.json({
              appUrl: 'https://app.sam.example.com',
              setupToken: 'synthetic-private-setup-token-for-audit',
            });
          return Response.json(builderJob);
        },
      }),
    },
  });
  screenshots += await captureMaintenanceControls(page, target);
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto(target);
  await page.locator('input[name="confirmed"]').check();
  const [deploymentResponse] = await Promise.all([
    page.waitForResponse((response) => response.url() === target + '/deploy'),
    page.getByRole('button', { name: 'Install SAM', exact: true }).click(),
  ]);
  if (deploymentResponse.status() !== 303)
    throw new Error(
      'Maintenance deployment browser response ' +
        deploymentResponse.status() +
        ' origins ' +
        JSON.stringify(received)
    );
  await expect(page.getByRole('button', { name: 'Cancel deployment', exact: true })).toBeVisible();
  for (const state of ['running', 'failed', 'completed']) {
    builderJob = {
      ...builderJob,
      status: state,
      checkpoint: { activePhase: 'publish-application' },
    };
    await page.goto(target);
    await page.evaluate(() => document.fonts.ready);
    for (const [device, width, height] of [
      ['mobile', 375, 667],
      ['desktop', 1280, 800],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.screenshot({
        path: output + '/installer-maintenance-' + state + '-' + device + '.png',
        fullPage: true,
      });
      screenshots++;
    }
  }
  await page.getByRole('button', { name: 'Open initial setup instructions' }).click();
  await expect(page.getByText('synthetic-private-setup-token-for-audit')).toBeVisible();
  for (const [device, width, height] of [
    ['mobile', 375, 667],
    ['desktop', 1280, 800],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.screenshot({
      path: output + '/installer-maintenance-setup-' + device + '.png',
      fullPage: true,
    });
    screenshots++;
  }
  await context.close();
  service.close();
  installer.close();
  await rm(temp, { recursive: true, force: true });

  return screenshots;
}
async function main() {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const baseUrl = process.env.INSTALLER_AUDIT_URL || 'http://localhost:8787';
  let screenshots = 0;
  if (!process.env.INSTALLER_AUDIT_MAINTENANCE_ONLY)
    for (const theme of ['light', 'dark'] as const) {
      for (const [device, width, height] of [
        ['mobile', 375, 667],
        ['desktop', 1280, 800],
        ['narrow', 320, 700],
      ] as const) {
        screenshots += await auditViewport(browser, theme, device, width, height, baseUrl);
      }
    }
  screenshots += await auditMaintenance(browser);
  await browser.close();
  console.log(
    `${screenshots} screenshots captured; themes, create/disconnect, errors, cross-site POST/redirect/cookie verified; no overflow.`
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
