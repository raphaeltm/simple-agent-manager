import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from '@playwright/test';

import { maintenanceSource } from '../src/maintenance';
import { digest } from '../src/security';
const output = '../../.codex/tmp/playwright-screenshots';
(async () => {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  for (const [label, width, height] of [
    ['mobile', 375, 667],
    ['desktop', 1280, 800],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    let state = 'connect';
    await page.route('**/api/config', (r) =>
      r.fulfill({
        json: {
          configured: true,
          sourceUrl: 'https://github.com/raphaeltm/simple-agent-manager/tree/main/apps/installer',
          docsUrl: '/privacy.html',
          sha: 'audit-fixture',
        },
      })
    );
    await page.route('**/api/session/status', (r) =>
      state === 'connect'
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
                          ? 'A very long organization name with <special> & characters '.repeat(5)
                          : `Account ${i}`,
                    })),
              job:
                state === 'ready'
                  ? { status: 'ready', name: 'sam-maintenance-1234567890123456' }
                  : null,
            },
          })
    );
    for (const scenario of ['connect', 'account', 'empty', 'ready']) {
      state = scenario;
      await page.goto('http://localhost:8787');
      await page.waitForTimeout(250);
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
        throw new Error(`Overflow ${label} ${scenario}`);
      await page.screenshot({
        path: `${output}/installer-${scenario}-${label}.png`,
        fullPage: true,
      });
    }
    await page.goto('http://localhost:8787/privacy.html');
    await page.screenshot({ path: `${output}/installer-privacy-${label}.png`, fullPage: true });
    await page.close();
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
    '12 screenshots captured; actual cross-site POST/redirect/cookie verified; no overflow across installer scenarios.'
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
