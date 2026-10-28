import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, expect } from '@playwright/test';

import { maintenanceSource } from '../src/maintenance';
import { digest } from '../src/security';
const output = '../../.codex/tmp/playwright-screenshots';
(async () => {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const baseUrl = process.env.INSTALLER_AUDIT_URL || 'http://localhost:8787';
  let screenshots = 0;
  for (const theme of ['light', 'dark'] as const) {
    for (const [device, width, height] of [
      ['mobile', 375, 667],
      ['desktop', 1280, 800],
      ['narrow', 320, 700],
    ] as const) {
      const label = `${device}-${theme}`;
      const page = await browser.newPage({ viewport: { width, height }, colorScheme: theme });
      let state = 'connect';
      await page.route('**/api/config', (r) =>
        r.fulfill({
          json: {
            configured: state !== 'unconfigured',
            sourceUrl: 'https://github.com/raphaeltm/simple-agent-manager/tree/main/apps/installer',
            docsUrl: '/self-host.html',
            sha: 'audit-fixture',
          },
        })
      );
      await page.route('**/api/session/status', (r) =>
        ['connect', 'unconfigured', 'authorization'].includes(state)
          ? r.fulfill({ status: 401, json: { error: 'Sign in' } })
          : r.fulfill({
              json: {
                accounts:
                  state === 'empty'
                    ? []
                    : Array.from({ length: 35 }, (_, i) => ({
                        id: String(i).padStart(32, 'a'),
                        name:
                          i === 0
                            ? 'Organization <script>alert(1)</script> & équipe 🧑‍💻 '.repeat(6)
                            : `Account ${i}`,
                      })),
                job:
                  state === 'ready' || state === 'pending'
                    ? { status: state, name: 'sam-maintenance-1234567890123456' }
                    : null,
              },
            })
      );
      await page.route('**/api/session/install', (r) => {
        if (state === 'error')
          return r.fulfill({
            status: 500,
            json: { error: 'Cloudflare could not create the service. Please retry.' },
          });
        state = 'ready';
        return r.fulfill({ json: { ok: true } });
      });
      await page.route('**/api/session/finish', (r) => r.fulfill({ json: { revoked: true } }));
      for (const scenario of [
        'connect',
        'account',
        'empty',
        'ready',
        'pending',
        'unconfigured',
        'authorization',
        'error',
      ]) {
        state = scenario;
        await page.goto(baseUrl + (scenario === 'authorization' ? '/?error=authorization' : '/'));
        await page.evaluate(() => document.fonts.ready);
        await expect(page.locator('#version')).toHaveText('Build audit-fixtur');
        if (scenario === 'connect') {
          await expect(page.locator('#login')).toBeEnabled();
          await page.getByText('What access am I granting?').click();
          await expect(page.getByText(/These may allow changes to existing Workers/)).toBeVisible();
          await page.getByText('What access am I granting?').click();
        }
        if (scenario === 'empty' || scenario === 'unconfigured')
          await expect(page.locator(scenario === 'empty' ? '#install' : '#login')).toBeDisabled();
        if (scenario === 'authorization')
          await expect(page.locator('#message')).toContainText('cancelled');
        if (scenario === 'error') {
          await page.locator('#confirm').check();
          await page.locator('#install').click();
          await expect(page.locator('#message')).toContainText('Please retry');
          await expect(page.locator('#install')).toBeEnabled();
        }
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
      await page.locator('#theme').selectOption(theme === 'light' ? 'dark' : 'light');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute(
        'data-theme',
        theme === 'light' ? 'dark' : 'light'
      );
      await page.locator('#theme').selectOption('auto');
      await page.goto(baseUrl + '/privacy.html');
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw new Error(`Privacy overflow ${label}`);
      await page.screenshot({ path: `${output}/installer-privacy-${label}.png`, fullPage: true });
      screenshots++;
      await page.goto(baseUrl + '/self-host.html');
      await expect(page.getByRole('heading', { name: '1. Get the source' })).toBeVisible();
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw new Error(`Self-host guide overflow ${label}`);
      await page.screenshot({ path: `${output}/installer-self-host-${label}.png`, fullPage: true });
      screenshots++;
      await page.close();
    }
  }
  const temp = await mkdtemp(join(tmpdir(), 'sam-installer-browser-'));
  execFileSync(
    'openssl',
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
  const maintenance = new Function(maintenanceSource.replace('export default', 'return'))();
  let origin = '',
    target = '';
  const env = {
    INSTALLER_ORIGIN: '',
    OWNER_KEY_HASH: await digest(key),
    CLAIM_EXPIRES: String(Date.now() + 60000),
  };
  const service = createServer(tls, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await maintenance.fetch(
      new Request(target + req.url, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
      }),
      env
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });
  await new Promise((resolve) => service.listen(0, resolve));
  target = 'https://127.0.0.1:' + service.address().port;
  const installer = createServer(tls, (_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(
      '<form method="POST" action="' +
        target +
        '/claim"><input name="key" value="' +
        key +
        '"><button>Continue</button></form>'
    );
  });
  await new Promise((resolve) => installer.listen(0, resolve));
  origin = 'https://localhost:' + installer.address().port;
  env.INSTALLER_ORIGIN = origin;
  await page.goto(origin);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('Ownership handoff verified.').waitFor();
  await page.screenshot({ path: output + '/installer-handoff-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 667 });
  await page.screenshot({ path: output + '/installer-handoff-mobile.png', fullPage: true });
  await context.close();
  service.close();
  installer.close();
  await rm(temp, { recursive: true, force: true });
  await browser.close();
  console.log(
    `${screenshots + 2} screenshots captured; themes, create/disconnect, errors, cross-site POST/redirect/cookie verified; no overflow.`
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
