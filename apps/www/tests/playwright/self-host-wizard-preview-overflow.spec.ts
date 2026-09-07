import { expect, type Page, test } from './fixtures';
import {
  assertPreviewValuesWithinViewport,
  expectNoHorizontalOverflow,
} from './self-host-overflow-helpers';

async function openWizard(page: Page) {
  await page.goto('/self-host/');
  await expect(page.locator('.sh')).toBeVisible();
}

async function continueFrom(page: Page, label = 'Continue') {
  await page.getByRole('button', { name: label }).click();
}

async function reachPreviewWithValues(
  page: Page,
  opts: { domain: string; appName: string; accountType?: 'personal' | 'org'; orgName?: string }
) {
  await openWizard(page);
  await continueFrom(page, 'Get started');
  await page.locator('#sh-domain').fill(opts.domain);
  await page.locator('#sh-cf-account').fill('0123456789abcdef0123456789abcdef');
  await continueFrom(page);
  await continueFrom(page);
  await continueFrom(page);
  await expect(page.getByRole('heading', { name: 'Create your GitHub App' })).toBeVisible();

  if (opts.accountType === 'org') {
    await page.locator('input[name="sh-account-type"][value="org"]').click();
    if (opts.orgName) await page.locator('#sh-org').fill(opts.orgName);
  }

  await page.locator('#sh-app-name').fill(opts.appName);
  await page.getByRole('button', { name: 'Generate setup link' }).click();
  await expect(page.locator('#sh-app-result')).toBeVisible();
}

test.describe('self-host wizard preview overflow (mobile)', () => {
  test('personal install preview values stay within viewport', async ({ page }) => {
    await reachPreviewWithValues(page, {
      domain: 'example.com',
      appName: 'My SAM Instance',
    });
    await expectNoHorizontalOverflow(page);
    await assertPreviewValuesWithinViewport(page);
  });

  test('org install preview values stay within viewport', async ({ page }) => {
    await reachPreviewWithValues(page, {
      domain: 'example.com',
      appName: 'SAM',
      accountType: 'org',
      orgName: 'acme-corp',
    });
    await expectNoHorizontalOverflow(page);
    await assertPreviewValuesWithinViewport(page);
  });

  test('long domain and app name preview values stay within viewport', async ({ page }) => {
    await reachPreviewWithValues(page, {
      domain: 'my-very-long-subdomain.internal.example-company.org',
      appName: 'My-Extremely-Long-Self-Hosted-SAM-Instance-Name-For-Testing',
    });
    await expectNoHorizontalOverflow(page);
    await assertPreviewValuesWithinViewport(page);
  });

  test('special character inputs preview values stay within viewport', async ({ page }) => {
    await reachPreviewWithValues(page, {
      domain: 'example.com',
      appName: 'SAM-Ünïcödé-<b>bold</b>',
    });
    await expectNoHorizontalOverflow(page);
    await assertPreviewValuesWithinViewport(page);
  });
});
