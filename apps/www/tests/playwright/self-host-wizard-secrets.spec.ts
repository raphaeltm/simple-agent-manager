import { expect, test, type Page } from '@playwright/test';

const STORAGE_KEY = 'sam-self-host-wizard-v1';
const LEGACY_WEBHOOK_CANARY = 'legacy-webhook-secret-canary-0123456789abcdef';
const LEGACY_PASSPHRASE_CANARY = 'legacy-pulumi-passphrase-canary-0123456789abcdef';

async function storageText(page: Page): Promise<string> {
  return (await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)) ?? '';
}

async function storageJson(page: Page): Promise<Record<string, unknown>> {
  const raw = await storageText(page);
  return raw ? JSON.parse(raw) : {};
}

async function expectStorageAbsent(page: Page, values: string[]) {
  const raw = await storageText(page);
  for (const value of values.filter(Boolean)) {
    expect(raw).not.toContain(value);
  }
  const parsed = raw ? JSON.parse(raw) : {};
  expect(parsed).not.toHaveProperty('webhookSecret');
  expect(parsed).not.toHaveProperty('passphrase');
}

async function expectNoHorizontalOverflow(page: Page) {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
    .toBe(true);
}

async function openWizard(page: Page) {
  await page.goto('/self-host/');
  await expect(page.locator('.sh')).toBeVisible();
}

async function continueFrom(page: Page, label = 'Continue') {
  await page.getByRole('button', { name: label }).click();
}

async function reachGitHubAppStep(page: Page) {
  await openWizard(page);
  await continueFrom(page, 'Get started');
  await page.locator('#sh-domain').fill('example.com');
  await page.locator('#sh-cf-account').fill('0123456789abcdef0123456789abcdef');
  await continueFrom(page);
  await continueFrom(page);
  await continueFrom(page);
  await expect(page.getByRole('heading', { name: 'Create your GitHub App' })).toBeVisible();
  await page.locator('#sh-app-name').fill('SAM Canary App');
}

async function generateWebhookSecret(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Generate setup link' }).click();
  const secret = await page.locator('#sh-webhook-secret').textContent();
  expect(secret).toMatch(/^[a-f0-9]{64}$/);
  return secret ?? '';
}

async function generatePassphrase(page: Page): Promise<string> {
  await continueFrom(page);
  await expect(page.getByRole('heading', { name: 'Generate a Pulumi passphrase' })).toBeVisible();
  const passphrase = await page.locator('#sh-passphrase').textContent();
  expect(passphrase).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  return passphrase ?? '';
}

test.describe('self-host wizard generated secret persistence canaries', () => {
  test('keeps generated webhook secret and Pulumi passphrase out of localStorage after generation', async ({
    page,
  }) => {
    await reachGitHubAppStep(page);
    const webhookSecret = await generateWebhookSecret(page);
    const passphrase = await generatePassphrase(page);

    await expectStorageAbsent(page, [webhookSecret, passphrase]);
    const saved = await storageJson(page);
    expect(saved.fields).toMatchObject({
      'sh-domain': 'example.com',
      'sh-cf-account': '0123456789abcdef0123456789abcdef',
      'sh-app-name': 'SAM Canary App',
    });
  });

  test('restores non-secret progress after reload without restoring generated secrets', async ({
    page,
  }) => {
    await reachGitHubAppStep(page);
    const webhookSecret = await generateWebhookSecret(page);
    const passphrase = await generatePassphrase(page);

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Generate a Pulumi passphrase' })).toBeVisible();
    await expect(page.locator('#sh-domain')).toHaveValue('example.com');
    await expect(page.locator('#sh-app-name')).toHaveValue('SAM Canary App');
    await expectStorageAbsent(page, [webhookSecret, passphrase]);
    await expect(page.locator('body')).not.toContainText(webhookSecret);
    await expect(page.locator('body')).not.toContainText(passphrase);
  });

  test('keeps generated secrets absent after later non-secret saves and step navigation', async ({
    page,
  }) => {
    await reachGitHubAppStep(page);
    const webhookSecret = await generateWebhookSecret(page);
    const passphrase = await generatePassphrase(page);

    await page.getByRole('button', { name: 'Back' }).click();
    await page.locator('#sh-app-id').fill('123456');
    await continueFrom(page);
    await expectStorageAbsent(page, [webhookSecret, passphrase]);
    const saved = await storageJson(page);
    expect(saved.fields).toMatchObject({ 'sh-app-id': '123456' });
  });

  test('clears storage and in-memory generated outputs on reset', async ({ page }) => {
    await reachGitHubAppStep(page);
    const webhookSecret = await generateWebhookSecret(page);
    const passphrase = await generatePassphrase(page);
    page.on('dialog', (dialog) => dialog.accept());

    await page.evaluate(() => document.getElementById('sh-reset')?.click());
    await expect(page.locator('.sh')).toBeVisible();
    await expect(page.locator('body')).not.toContainText(webhookSecret);
    await expect(page.locator('body')).not.toContainText(passphrase);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), STORAGE_KEY)).toBeNull();
  });

  test('migrates legacy state by deleting persisted generated secrets while preserving non-secret progress', async ({
    page,
  }) => {
    await page.addInitScript(
      ({ storageKey, webhook, passphrase }) => {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify({
            step: 5,
            furthest: 6,
            accountType: 'org',
            webhookSecret: webhook,
            passphrase,
            fields: {
              'sh-domain': 'legacy.example.com',
              'sh-cf-account': 'fedcba9876543210fedcba9876543210',
              'sh-org': 'legacy-org',
              'sh-app-name': 'Legacy Canary App',
            },
          })
        );
      },
      {
        storageKey: STORAGE_KEY,
        webhook: LEGACY_WEBHOOK_CANARY,
        passphrase: LEGACY_PASSPHRASE_CANARY,
      }
    );

    await openWizard(page);
    await expect(page.getByRole('heading', { name: 'Generate a Pulumi passphrase' })).toBeVisible();
    await expect(page.locator('#sh-domain')).toHaveValue('legacy.example.com');
    await expect(page.locator('#sh-org')).toHaveValue('legacy-org');
    await expectStorageAbsent(page, [LEGACY_WEBHOOK_CANARY, LEGACY_PASSPHRASE_CANARY]);
    const migrated = await storageJson(page);
    expect(migrated).toMatchObject({ step: 5, furthest: 6, accountType: 'org' });
    expect(migrated.fields).toMatchObject({
      'sh-domain': 'legacy.example.com',
      'sh-cf-account': 'fedcba9876543210fedcba9876543210',
      'sh-org': 'legacy-org',
      'sh-app-name': 'Legacy Canary App',
    });
  });
});

test.describe('self-host wizard visual review', () => {
  test('desktop and mobile layout has no horizontal overflow through generated secret steps', async ({
    page,
  }, testInfo) => {
    await reachGitHubAppStep(page);
    await generateWebhookSecret(page);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: `.codex/tmp/playwright-screenshots/self-host-wizard-github-app-${testInfo.project.name.toLowerCase().replace(/\W+/g, '-')}.png`,
      fullPage: true,
    });

    await generatePassphrase(page);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: `.codex/tmp/playwright-screenshots/self-host-wizard-passphrase-${testInfo.project.name.toLowerCase().replace(/\W+/g, '-')}.png`,
      fullPage: true,
    });
  });
});
