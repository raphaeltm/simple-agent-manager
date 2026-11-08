import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Browser, chromium, expect, type Page } from '@playwright/test';

import { maintenanceSource } from '../src/maintenance';
import { digest } from '../src/security';
import { InstallerSession } from '../src/session';
import type { Env, Session } from '../src/types';
const output = '../../.codex/tmp/playwright-screenshots';

async function installFixtureRoutes(
  page: Page,
  getState: () => string,
  setState: (value: string) => void,
  previewState: { attempts: number } = { attempts: 0 },
  installGate: { release: () => void; hold: Promise<void> } = {
    release: () => {},
    hold: Promise.resolve(),
  }
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
  await page.route('**/api/session/preview', (r) => {
    if (getState() === 'full-expired')
      return r.fulfill({
        status: 401,
        json: { error: 'Your installer session expired. Sign in again.' },
      });
    let conflicts: Array<{ name: string; type: string }> = [];
    if (getState() === 'full-conflict')
      conflicts = [{ name: 'api.sam.example.com', type: 'CNAME' }];
    if (getState() === 'full-flow') {
      previewState.attempts++;
      // The first review attempt hits a conflict; "Check again" resolves it,
      // the way a real re-run would after the owner clears the blocking record.
      conflicts =
        previewState.attempts === 1 ? [{ name: 'api.sam.example.com', type: 'CNAME' }] : [];
    }
    return r.fulfill({
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
          conflicts,
        },
      },
    });
  });
  await page.route('**/api/session/install', async (r) => {
    if (getState() === 'error')
      return r.fulfill({
        status: 500,
        json: {
          error:
            'Cloudflare could not complete this step. Try again. Details: POST /workers/scripts returned HTTP 403 (codes 10000). No credentials were logged.',
        },
      });
    // Held open by 'installing' until the test releases it, so the busy
    // button state is genuinely observed rather than hand-fed.
    if (getState() === 'installing') await installGate.hold;
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
async function captureState(page: Page, name: string) {
  let count = 0;
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    await page
      .getByRole('button', { name: theme === 'light' ? 'Light theme' : 'Dark theme', exact: true })
      .click();
    await expect(
      page.getByRole('button', {
        name: theme === 'light' ? 'Light theme' : 'Dark theme',
        exact: true,
      })
    ).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(350);
    for (const [device, width, height] of [
      ['mobile', 375, 667],
      ['desktop', 1280, 800],
      ['narrow', 320, 700],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => document.fonts.ready);
      await page.evaluate(() => scrollTo(0, 0));
      await assertNoOverflow(page, name + '-' + device + '-' + theme);
      await page.screenshot({
        path: output + '/installer-' + name + '-' + device + '-' + theme + '.png',
        fullPage: true,
      });
      count++;
    }
  }
  return count;
}
async function captureMaintenanceControls(page: Page, target: string) {
  let screenshots = 0;
  for (const theme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
    for (const [device, width, height] of [
      ['mobile', 375, 667],
      ['desktop', 1280, 800],
      ['narrow', 320, 700],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(target);
      await page
        .getByRole('button', {
          name: theme === 'light' ? 'Light theme' : 'Dark theme',
          exact: true,
        })
        .click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.waitForTimeout(350);
      await page.evaluate(() => document.fonts.ready);
      await assertNoOverflow(page, 'Maintenance');
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({
        path: output + '/installer-maintenance-controls-' + device + '-' + theme + '.png',
        fullPage: true,
      });
      screenshots++;
    }
  }

  return screenshots;
}
async function auditFullChoose(page: Page) {
  // Pick a normal account name (index 0 is a deliberately hostile/long name
  // fixture, exercised separately by the default "choose" scenario) so the
  // review summary assertions below are deterministic.
  await page.locator('#account-id').selectOption({ label: 'Account 1' });
  await expect(page.locator('#zone-id')).toHaveValue('b'.repeat(32));
  await expect(page.locator('#base-domain-shown')).toHaveText('example.com');
  // Advanced subdomain override starts collapsed.
  await expect(page.locator('#subdomain-details')).not.toHaveAttribute('open', '');
  await page.locator('#owner-email').fill('owner+installation@example.com');
  await expect(page.locator('#preview')).toBeEnabled();
  // The "install" primary action is not visible until the plan has been reviewed.
  await expect(page.locator('#review')).toBeHidden();
  // Choose/Review/Handoff drop the marketing hero and extra panels for a slim header.
  await expect(page.locator('#hero-copy')).toBeHidden();
  await expect(page.locator('#slim-header')).toBeVisible();
  await expect(page.locator('#mode-note')).toBeHidden();
  await expect(page.locator('#trust')).toBeHidden();
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
    await page.locator('#login').focus();
    await expect(page.locator('#login')).toBeFocused();
    expect(
      await page.locator('#login').evaluate((el) => getComputedStyle(el).outlineStyle)
    ).not.toBe('none');
    await page.getByText('What will SAM be allowed to do?').click();
    await expect(page.getByText(/These may allow changes to existing Workers/)).toBeVisible();
    await page.getByText('What will SAM be allowed to do?').click();
  }
  // The step indicator always has 4 entries in both modes; it never changes
  // length between screens. Bootstrap mode greys Review out instead of
  // removing it, so Connect/Choose/Handoff numbering stays identical.
  await expect(page.locator('.steps li')).toHaveCount(4);
  const stepBounds = await page.locator('.steps').evaluate((el) => {
    const parent = el.getBoundingClientRect();
    return [...el.querySelectorAll('li')].every((item) => {
      const r = item.getBoundingClientRect();
      return r.left >= parent.left && r.right <= parent.right;
    });
  });
  expect(stepBounds).toBe(true);
  if (!scenario.startsWith('full-'))
    await expect(page.locator('#step-review')).toHaveClass(/skipped/);
  if (scenario === 'full-choose') await auditFullChoose(page);
  if (scenario === 'full-review') {
    await auditFullChoose(page);
    await page.locator('#preview').click();
    await expect(page.locator('#review')).toBeVisible();
    // The app hostname comes from the server's own plan.hostnames, not a
    // client-side reconstruction of the (possibly different) base-domain
    // input — this fixture's plan intentionally returns a distinct domain.
    await expect(page.locator('#plan-summary-line')).toContainText(
      'SAM will live at app.sam.example.com in Account 1. Cloudflare usage charges apply.'
    );
    await expect(page.locator('#plan-details')).toBeVisible();
    await expect(page.locator('#plan-summary')).toBeHidden();
    await page.locator('#plan-details summary').click();
    await expect(page.locator('#plan-summary')).toContainText('sam-account.workers.dev (new)');
    await expect(page.locator('#plan-summary')).not.toContainText('Initialize account address');
    await expect(page.locator('#review-blocked')).toBeHidden();
    await expect(page.locator('#review-form')).toBeVisible();
    await expect(page.locator('#confirm-full')).not.toBeChecked();
    await expect(page.locator('#install')).toBeDisabled();
    await page.locator('#confirm-full').check();
    await expect(page.locator('#install')).toBeEnabled();
    await expect(page.locator('#step-review')).toHaveAttribute('aria-current', 'step');
    await expect(page.locator('#step-review')).not.toHaveClass(/skipped/);
  }
  if (scenario === 'full-conflict') {
    await auditFullChoose(page);
    await page.locator('#preview').click();
    await expect(page.locator('#review')).toBeVisible();
    await expect(page.locator('#message > p')).toContainText('block installation');
    await expect(page.locator('#plan-details')).toBeHidden();
    await expect(page.locator('#review-blocked')).toBeVisible();
    await expect(page.locator('#review-form')).toBeHidden();
    await expect(
      page.getByRole('button', { name: 'Use a different domain', exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: "I've removed them — check again", exact: true })
    ).toBeVisible();
    // The install action is unavailable while a conflict exists.
    await expect(page.locator('#install')).toBeHidden();
    await expect(page.locator('#back-to-choose')).toBeVisible();
  }
  if (scenario === 'choose') {
    await expect(page.locator('#install-simple')).toBeDisabled();
    await page.locator('#confirm').check();
    await expect(page.locator('#install-simple')).toBeEnabled();
    await page.locator('#confirm').uncheck();
    await expect(page.locator('#install-simple')).toBeDisabled();
  }
  if (scenario === 'empty' || scenario === 'unconfigured')
    await expect(page.locator(scenario === 'empty' ? '#install-simple' : '#login')).toBeDisabled();
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
    await page.locator('#install-simple').click();
    // Plain language first; the raw provider detail stays behind a disclosure.
    await expect(page.locator('#message > p')).toContainText('Try again');
    await expect(page.locator('#message details p')).toBeHidden();
    await page.getByText('Technical details').click();
    await expect(page.locator('#message details p')).toContainText('HTTP 403');
    await expect(page.locator('#install-simple')).toBeEnabled();
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
  const page = await browser.newPage({
    viewport: { width, height },
    colorScheme: theme,
    reducedMotion: 'reduce',
  });
  const cspErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Content Security Policy'))
      cspErrors.push(message.text());
  });
  let state = 'connect';
  const previewState = { attempts: 0 };
  let releaseInstall: () => void = () => {};
  const installGate = {
    release: () => releaseInstall(),
    hold: new Promise<void>((resolve) => {
      releaseInstall = resolve;
    }),
  };
  await installFixtureRoutes(
    page,
    () => state,
    (value) => {
      state = value;
    },
    previewState,
    installGate
  );
  for (const scenario of [
    'connect',
    'choose',
    'full-choose',
    'full-review',
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
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: `${output}/installer-${scenario}-${label}.png`,
      fullPage: true,
    });
    screenshots++;
  }
  // Exercise the real non-full UI handlers across create -> ready -> disconnect.
  // 'installing' holds /api/session/install open with a real deferred promise
  // so the busy button state below is genuinely observed, not hand-fed.
  state = 'installing';
  await page.goto(baseUrl);
  await page.locator('#confirm').check();
  const installClick = page.locator('#install-simple').click();
  await expect(page.locator('#install-simple')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#install-simple')).toHaveText(/Creating your installation service/);
  await expect(page.locator('#install-simple')).toBeDisabled();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth))
    throw new Error(`Overflow ${label} installing`);
  await page.screenshot({
    path: `${output}/installer-installing-${label}.png`,
    fullPage: true,
  });
  screenshots++;
  installGate.release();
  await installClick;
  await expect(page.locator('#ready')).toBeVisible();
  await expect(page.locator('#step-handoff')).toHaveAttribute('aria-current', 'step');
  await page.locator('#disconnect').click();
  await expect(page.locator('#connect')).toBeVisible();
  await expect(page.locator('#step-connect')).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('.steps .completed')).toHaveCount(0);

  // Full flow: choose -> review hits a conflict -> "Check again" resolves it ->
  // install -> handoff. This is the real trigger path, not a hand-fed state.
  state = 'full-flow';
  previewState.attempts = 0;
  await page.goto(baseUrl);
  await expect(page.locator('#choose')).toBeVisible();
  await page.locator('#owner-email').fill('owner+flow@example.com');
  await page.locator('#preview').click();
  await expect(page.locator('#review-blocked')).toBeVisible();
  await page.locator('#check-again').click();
  await expect(page.locator('#review-form')).toBeVisible();
  // The quiet "Back" link returns to Choose without losing the resolved plan.
  await page.locator('#back-to-choose').click();
  await expect(page.locator('#choose')).toBeVisible();
  await expect(page.locator('#step-choose')).toHaveAttribute('aria-current', 'step');
  await page.locator('#preview').click();
  await expect(page.locator('#review-form')).toBeVisible();
  await page.locator('#confirm-full').check();
  await page.locator('#install').click();
  await expect(page.locator('#ready')).toBeVisible();
  await expect(page.locator('#step-handoff')).toHaveAttribute('aria-current', 'step');

  // Session expiry mid-flow returns to Step 1 with a calm message, not a silent
  // failure or stuck button.
  state = 'full-expired';
  await page.goto(baseUrl);
  await page.locator('#owner-email').fill('owner+expired@example.com');
  await page.locator('#preview').click();
  await expect(page.locator('#connect')).toBeVisible();
  await expect(page.locator('#step-connect')).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('#message')).toContainText('session expired');
  await expect(page.locator('#disconnect')).toBeHidden();

  await page
    .getByRole('button', { name: theme === 'light' ? 'Dark theme' : 'Light theme' })
    .press('Enter');
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
  expect(cspErrors).toEqual([]);
  await page.close();
  return screenshots;
}
async function auditMaintenance(browser: Browser) {
  let screenshots = 0;
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
  const context = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: 'reduce' });
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
  const installer = createServer(tls, async (req, res) => {
    if (
      /^\/(?:_astro\/[a-zA-Z0-9_.-]+|theme-init\.js|fonts\/[a-zA-Z0-9_.-]+|(?:brand-icon|sam-head)\.png)$/.test(
        req.url || ''
      )
    ) {
      const path = req.url!;
      res.setHeader(
        'Content-Type',
        path.endsWith('.js')
          ? 'application/javascript'
          : path.endsWith('.css')
            ? 'text/css'
            : path.endsWith('.png')
              ? 'image/png'
              : 'font/woff2'
      );
      res.end(await readFile('site-static' + path));
      return;
    }
    if (req.url === '/handoff.js') {
      res.setHeader('Content-Type', 'application/javascript');
      res.end(handoffScript);
      return;
    }
    const session: Session = {
      expires: Date.now() + 60000,
      verifier: 'fixture',
      state: 'fixture',
      job: {
        status: 'ready',
        url: target,
        key,
        accountId: 'a'.repeat(32),
        name: 'sam-maintenance-fixture',
      },
    };
    const handoff = new InstallerSession(
      {
        storage: { get: async () => session, put: async () => {} },
      } as unknown as DurableObjectState,
      {} as Env
    );
    const response = await handoff.fetch(new Request(origin + '/handoff', { method: 'POST' }));
    res.writeHead(response.status, {
      ...Object.fromEntries(response.headers),
      'Referrer-Policy': 'strict-origin',
    });
    res.end(await response.text());
  });
  await new Promise((resolve) => installer.listen(0, resolve));
  origin = 'https://localhost:' + installer.address().port;
  env.INSTALLER_ORIGIN = origin;
  await page.goto(origin);
  await expect(page.locator('#maintenance-recovery-display')).toHaveValue(/^[a-f0-9]{64}$/);
  screenshots += await captureState(page, 'handoff');
  await page.locator('#maintenance-recovery-saved').check();
  await page.getByRole('button', { name: 'Open my installation service' }).click();
  await page.getByText('Ownership handoff verified.').waitFor();
  screenshots += await captureState(page, 'maintenance-claimed');

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
  // The first-install consent checkbox is pre-checked (the installer's Review
  // screen already captured consent); the shared script keeps the primary
  // button in sync with it rather than requiring a second identical click.
  await expect(page.locator('input[name="confirmed"]')).toBeChecked();
  await expect(page.getByRole('button', { name: 'Install SAM', exact: true })).toBeEnabled();
  await page.locator('input[name="confirmed"]').uncheck();
  await expect(page.getByRole('button', { name: 'Install SAM', exact: true })).toBeDisabled();
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
  // Running builds show the current stage, a live "last checked" signal and a
  // progress bar; the full 13-stage list stays collapsed until asked for.
  await expect(page.getByText(/^Step \d+ of \d+:/)).toBeVisible();
  await expect(page.getByText(/Last checked \d{2}:\d{2}:\d{2} UTC/)).toBeVisible();
  await expect(page.getByText(/updates every \d+s/)).toBeVisible();
  await expect(page.locator('progress.build-progress')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh progress' })).toHaveCount(0);
  const showStages = page.locator('summary', { hasText: 'Show all stages' });
  await expect(showStages).toBeVisible();
  await expect(page.locator('.build-steps li').first()).toBeHidden();
  await showStages.click();
  await expect(page.locator('.build-steps li').first()).toBeVisible();
  // An open stage list must not freeze the page (staging, 2026-11-07): the page
  // still reloads on its interval and the list comes back open afterwards.
  await page.waitForEvent('load', { timeout: 25_000 });
  await expect(page.locator('.build-steps li').first()).toBeVisible();
  const stop = page.locator('summary', { hasText: 'Stop this build' });
  await expect(stop).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop build', exact: true })).toBeHidden();
  await stop.click();
  // The stop confirmation also starts unchecked/disabled, same as handoff.
  await expect(page.getByRole('button', { name: 'Stop build', exact: true })).toBeDisabled();
  await page.locator('form[action="/cancel"] input[type="checkbox"]').check();
  await expect(page.getByRole('button', { name: 'Stop build', exact: true })).toBeEnabled();
  screenshots += await captureState(page, 'maintenance-stop-disclosure');
  // A failed build gets a plain-language headline with warning styling; the
  // raw engine tail stays collapsed behind "Technical details".
  builderJob = {
    ...builderJob,
    status: 'failed',
    checkpoint: { activePhase: 'publish-application' },
    failure: { step: 'bootstrap', tail: ['<script>route already exists</script>', 'exit 1'] },
  };
  await page.goto(target);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.deployment-status--attention')).toBeVisible();
  await expect(page.locator('.deployment-status')).toContainText('Installation needs attention');
  await expect(page.locator('.deployment-status')).toContainText(
    'Your installation and what has been built so far are kept.'
  );
  await expect(page.getByText('route already exists')).toBeHidden();
  await page.locator('summary', { hasText: 'Technical details' }).click();
  await expect(page.getByText('route already exists')).toBeVisible();
  screenshots += await captureState(page, 'maintenance-failed');
  for (const state of ['running', 'completed']) {
    builderJob = {
      ...builderJob,
      status: state,
      checkpoint: { activePhase: 'publish-application' },
      failure: undefined,
    };
    await page.goto(target);
    await page.evaluate(() => document.fonts.ready);
    screenshots += await captureState(page, 'maintenance-' + state);
  }
  // Completed: one primary action; "Check for an update" is a quiet text
  // link, not a second competing button; its body text lives in the status box.
  await expect(page.locator('.deployment-status')).toContainText(
    'Your instance passed its deployment health check.'
  );
  const updateLink = page.getByRole('button', { name: 'Check for an update', exact: true });
  await expect(updateLink).not.toHaveClass(/sam-btn--secondary/);
  await page.getByRole('button', { name: 'Finish setting up SAM', exact: true }).click();
  await expect(page.getByText('synthetic-private-setup-token-for-audit')).toBeVisible();
  screenshots += await captureState(page, 'maintenance-setup');
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
