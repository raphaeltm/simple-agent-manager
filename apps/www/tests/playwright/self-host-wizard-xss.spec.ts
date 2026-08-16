import { expect, test, type Page } from '@playwright/test';

async function openWizard(page: Page) {
  await page.goto('/self-host/');
  await expect(page.locator('.sh')).toBeVisible();
}

async function continueFrom(page: Page, label = 'Continue') {
  await page.getByRole('button', { name: label }).click();
}

async function reachStep(page: Page, stepHeading: string) {
  await openWizard(page);
  await continueFrom(page, 'Get started');
  await page.locator('#sh-domain').fill('example.com');
  await page.locator('#sh-cf-account').fill('0123456789abcdef0123456789abcdef');
  await continueFrom(page);
  await continueFrom(page);
  await continueFrom(page);
  await expect(page.getByRole('heading', { name: 'Create your GitHub App' })).toBeVisible();
  if (stepHeading === 'Create your GitHub App') return;
  await page.getByRole('button', { name: 'Generate setup link' }).click();
  await continueFrom(page);
  if (stepHeading === 'Generate a Pulumi passphrase') return;
  await continueFrom(page);
}

async function expectNoXssExecution(page: Page) {
  const xssFired = await page.evaluate(() => (window as unknown as Record<string, unknown>).__xss_fired__);
  expect(xssFired).toBeFalsy();
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
}

const XSS_PAYLOADS = [
  { name: 'iframe srcdoc', value: '<iframe srcdoc="<script>window.__xss_fired__=true</script>">' },
  { name: 'img onerror', value: '<img src=x onerror="window.__xss_fired__=true">' },
  { name: 'svg onload', value: '<svg onload="window.__xss_fired__=true">' },
  { name: 'MathML', value: '<math><mtext><table><mglyph><style><!--</style><img src=x onerror="window.__xss_fired__=true">' },
  { name: 'details ontoggle', value: '<details open ontoggle="window.__xss_fired__=true"><summary>x</summary></details>' },
  { name: 'event handler attribute', value: '" onmouseover="window.__xss_fired__=true" data-x="' },
  { name: 'javascript URI', value: 'javascript:window.__xss_fired__=true' },
  { name: 'data URI', value: 'data:text/html,<script>window.__xss_fired__=true</script>' },
  { name: 'input autofocus onfocus', value: '<input autofocus onfocus="window.__xss_fired__=true">' },
  { name: 'null byte injection', value: 'abc\x00<img src=x onerror="window.__xss_fired__=true">' },
];

const CREDENTIAL_PAYLOADS = [
  { name: 'img tag in token-shaped value', value: 'ghp_R8<img/src=x onerror=alert(1)>ABCDtoken' },
  { name: 'script tag in PEM-shaped value', value: '-----BEGIN RSA PRIVATE KEY-----\n<script>alert(1)</script>\n-----END RSA PRIVATE KEY-----' },
  { name: 'svg onload in secret value', value: 'secret_<svg onload="alert(1)">_value' },
  { name: 'img onerror in hex-shaped value', value: 'abcdef0123456789<img src=x onerror=alert(1)>abcdef' },
];

async function expectNoInjectedElements(page: Page) {
  const injected = await page.evaluate(() => {
    let count = 0;
    const dangerousTags = new Set(['script', 'iframe', 'object', 'embed', 'math', 'mglyph']);
    document.querySelectorAll('*').forEach((el) => {
      if (dangerousTags.has(el.tagName.toLowerCase())) { count++; return; }
      for (const attr of el.attributes) {
        if (attr.name.startsWith('on')) { count++; return; }
      }
    });
    return count;
  });
  expect(injected).toBe(0);
}

test.describe('self-host wizard XSS resilience — credential fields', () => {
  for (const payload of XSS_PAYLOADS) {
    test(`domain field: ${payload.name} renders inertly`, async ({ page }) => {
      await openWizard(page);
      await continueFrom(page, 'Get started');
      await page.locator('#sh-domain').fill(payload.value);
      await page.waitForTimeout(200);
      await expectNoXssExecution(page);
      await expectNoInjectedElements(page);
    });
  }

  for (const payload of XSS_PAYLOADS) {
    test(`app name field: ${payload.name} renders inertly`, async ({ page }) => {
      await reachStep(page, 'Create your GitHub App');
      await page.locator('#sh-app-name').fill(payload.value);
      await page.getByRole('button', { name: 'Generate setup link' }).click();
      await page.waitForTimeout(200);
      await expectNoXssExecution(page);
      await expectNoInjectedElements(page);
    });
  }

  for (const payload of XSS_PAYLOADS) {
    test(`organization field: ${payload.name} renders inertly`, async ({ page }) => {
      await reachStep(page, 'Create your GitHub App');
      await page.getByLabel('GitHub Organization').click();
      await page.locator('#sh-org').fill(payload.value);
      await page.getByRole('button', { name: 'Generate setup link' }).click();
      await page.waitForTimeout(200);
      await expectNoXssExecution(page);
      await expectNoInjectedElements(page);
    });
  }
});

test.describe('self-host wizard XSS resilience — env output step', () => {
  for (const payload of CREDENTIAL_PAYLOADS) {
    test(`credential value: ${payload.name} renders inertly in env output`, async ({ page }) => {
      await reachStep(page, 'Create your GitHub App');
      await page.locator('#sh-app-id').fill('123456');
      await page.locator('#sh-client-id').fill('Iv1.abc123');
      await page.locator('#sh-client-secret').fill(payload.value);
      await page.locator('#sh-app-slug').fill('sam');
      await page.getByRole('button', { name: 'Generate setup link' }).click();
      await continueFrom(page);
      await continueFrom(page);
      await expect(page.getByRole('heading', { name: 'Configure the production environment' })).toBeVisible();
      await page.waitForTimeout(500);
      await expectNoXssExecution(page);
      await expectNoInjectedElements(page);
    });
  }
});

test.describe('self-host wizard — SVG icons are DOM-constructed, not innerHTML', () => {
  test('icon buttons contain real SVG elements with correct namespace', async ({ page }) => {
    await reachStep(page, 'Configure the production environment');
    await page.waitForTimeout(500);
    const icons = page.locator('.sh-secret-act svg');
    const count = await icons.count();
    expect(count).toBeGreaterThan(0);
    const ns = await icons.first().evaluate((el) => el.namespaceURI);
    expect(ns).toBe('http://www.w3.org/2000/svg');
  });
});

test.describe('self-host wizard — no secrets in DOM attributes', () => {
  test('generated secrets are not stored in data-* attributes', async ({ page }) => {
    await reachStep(page, 'Create your GitHub App');
    await page.locator('#sh-cf-token').fill('cf_test_token_value_abcdef123456');
    await page.locator('#sh-client-secret').fill('client_secret_value_xyz789');
    await page.locator('#sh-r2-secret').fill('r2_secret_key_value_000');
    await page.locator('#sh-app-id').fill('123456');
    await page.locator('#sh-client-id').fill('Iv1.abc');
    await page.locator('#sh-app-slug').fill('sam');
    await page.getByRole('button', { name: 'Generate setup link' }).click();
    await continueFrom(page);
    await continueFrom(page);
    await expect(page.getByRole('heading', { name: 'Configure the production environment' })).toBeVisible();
    await page.waitForTimeout(500);

    const dataAttrs = await page.evaluate(() => {
      const attrs: string[] = [];
      document.querySelectorAll('*').forEach((el) => {
        for (const attr of el.attributes) {
          if (attr.name.startsWith('data-') && attr.value.length > 0) {
            attrs.push(`${attr.name}=${attr.value}`);
          }
        }
      });
      return attrs.join('\n');
    });
    expect(dataAttrs).not.toContain('cf_test_token_value');
    expect(dataAttrs).not.toContain('client_secret_value');
    expect(dataAttrs).not.toContain('r2_secret_key_value');
  });
});

test.describe('self-host wizard — URL validation', () => {
  test('deploy step URLs use validated HTTPS scheme', async ({ page }) => {
    await reachStep(page, 'Configure the production environment');
    await continueFrom(page);
    await expect(page.getByRole('heading', { name: 'Deploy & verify' })).toBeVisible();

    const appLink = page.locator('#sh-app-open');
    await expect(appLink).toHaveAttribute('href', /^https:\/\//);

    const loginLink = page.locator('#sh-app-login');
    await expect(loginLink).toHaveAttribute('href', /^https:\/\//);
  });

  test('Cloudflare links use HTTPS with encoded account ID', async ({ page }) => {
    await openWizard(page);
    await continueFrom(page, 'Get started');
    await page.locator('#sh-domain').fill('example.com');
    await page.locator('#sh-cf-account').fill('0123456789abcdef0123456789abcdef');
    await continueFrom(page);
    await continueFrom(page);

    const cfApiLink = page.locator('#sh-cf-api-link');
    const href = await cfApiLink.getAttribute('href');
    expect(href).toMatch(/^https:\/\/dash\.cloudflare\.com\//);
    expect(href).toContain('0123456789abcdef0123456789abcdef');
  });
});

test.describe('self-host wizard — copy and download remain correct', () => {
  test('webhook secret copy target contains valid hex', async ({ page }) => {
    await reachStep(page, 'Create your GitHub App');
    await page.getByRole('button', { name: 'Generate setup link' }).click();
    const secret = await page.locator('#sh-webhook-secret').textContent();
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
  });

  test('passphrase copy target contains valid base64', async ({ page }) => {
    await reachStep(page, 'Generate a Pulumi passphrase');
    const passphrase = await page.locator('#sh-passphrase').textContent();
    expect(passphrase).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  test('gh CLI copy uses closure, not DOM attribute', async ({ page }) => {
    await reachStep(page, 'Configure the production environment');
    await page.waitForTimeout(500);
    await page.getByText('Faster: set everything with the GitHub CLI').click();
    const ghBox = page.locator('#sh-gh-cli-output');
    const dataScript = await ghBox.getAttribute('data-script');
    expect(dataScript).toBeNull();
  });

  test('SVG icons render as actual SVG elements (not innerHTML strings)', async ({ page }) => {
    await reachStep(page, 'Configure the production environment');
    await page.waitForTimeout(500);
    const svgIcons = await page.locator('.sh-secret-act svg').count();
    expect(svgIcons).toBeGreaterThan(0);
    const firstSvg = page.locator('.sh-secret-act svg').first();
    await expect(firstSvg).toHaveAttribute('viewBox', '0 0 24 24');
  });
});

test.describe('self-host wizard XSS — visual audit', () => {
  test('no horizontal overflow or console errors with XSS payloads at mobile and desktop', async ({
    page,
  }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (
          text.includes('CORS') ||
          text.includes('ERR_BLOCKED_BY_RESPONSE') ||
          text.includes('Failed to load resource') ||
          text.includes('net::ERR_')
        )
          return;
        consoleErrors.push(text);
      }
    });

    await reachStep(page, 'Create your GitHub App');
    await page.locator('#sh-app-name').fill('<img src=x onerror="alert(1)">');
    await page.getByRole('button', { name: 'Generate setup link' }).click();
    await page.waitForTimeout(300);

    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: `.codex/tmp/playwright-screenshots/self-host-xss-github-app-${testInfo.project.name.toLowerCase().replace(/\W+/g, '-')}.png`,
      fullPage: true,
    });

    await page.locator('#sh-client-secret').fill('<script>alert("xss")</script>');
    await continueFrom(page);
    await continueFrom(page);
    await expect(page.getByRole('heading', { name: 'Configure the production environment' })).toBeVisible();
    await page.waitForTimeout(500);

    await expectNoHorizontalOverflow(page);
    await expectNoXssExecution(page);
    await page.screenshot({
      path: `.codex/tmp/playwright-screenshots/self-host-xss-env-output-${testInfo.project.name.toLowerCase().replace(/\W+/g, '-')}.png`,
      fullPage: true,
    });

    expect(consoleErrors).toHaveLength(0);
  });
});

test.describe('self-host wizard — legitimate output preserved', () => {
  test('wizard flow from start to deploy step produces correct env vars', async ({ page }) => {
    await openWizard(page);
    await continueFrom(page, 'Get started');
    await page.locator('#sh-domain').fill('mysite.org');
    await page.locator('#sh-cf-account').fill('aabbccddee11223344556677889900ff');
    await continueFrom(page);
    await continueFrom(page);
    await page.locator('#sh-cf-token').fill('test-token-value');
    await page.locator('#sh-cf-zone').fill('aabbccddee11223344556677889900ff');
    await page.locator('#sh-r2-key').fill('R2KEY123');
    await page.locator('#sh-r2-secret').fill('R2SECRET456');
    await continueFrom(page);
    await page.locator('#sh-app-id').fill('999');
    await page.locator('#sh-client-id').fill('Iv1.testclient');
    await page.locator('#sh-client-secret').fill('ghsecretvalue');
    await page.locator('#sh-app-slug').fill('myapp');
    await page.getByRole('button', { name: 'Generate setup link' }).click();
    await continueFrom(page);
    await continueFrom(page);
    await expect(page.getByRole('heading', { name: 'Configure the production environment' })).toBeVisible();
    await page.waitForTimeout(500);

    const varsSection = page.locator('#sh-vars-output');
    await expect(varsSection).toContainText('BASE_DOMAIN');
    await expect(varsSection).toContainText('mysite.org');
    await expect(varsSection).toContainText('RESOURCE_PREFIX');

    const secretsSection = page.locator('#sh-secrets-output');
    await expect(secretsSection).toContainText('CF_API_TOKEN');
    await expect(secretsSection).toContainText('GH_CLIENT_ID');
    await expect(secretsSection).toContainText('GH_APP_ID');

    await continueFrom(page);
    await expect(page.getByRole('heading', { name: 'Deploy & verify' })).toBeVisible();
    const healthCmd = await page.locator('#sh-health-cmd').textContent();
    expect(healthCmd).toBe('curl https://api.mysite.org/health');
  });
});
