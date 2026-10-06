import { expect, type Page, test } from './fixtures';

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
}

test.describe('self-host wizard generateAppLink regression', () => {
  test('no console errors during wizard initialization (catches missing handler)', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openWizard(page);
    expect(errors).toEqual([]);
  });

  test('generate setup link produces correct link, preview, and secret for personal install', async ({
    page,
  }) => {
    await reachGitHubAppStep(page);
    await page.locator('#sh-app-name').fill('My SAM Instance');
    await page.getByRole('button', { name: 'Generate setup link' }).click();

    const link = page.locator('#sh-app-link');
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href');
    expect(href).toBeTruthy();
    const url = new URL(href!);
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/settings/apps/new');
    expect(url.searchParams.get('name')).toBe('My SAM Instance');
    expect(url.searchParams.get('url')).toBe('https://app.example.com');
    expect(url.searchParams.get('webhook_url')).toBe('https://api.example.com/api/github/webhook');
    expect(url.searchParams.get('contents')).toBe('write');
    expect(url.searchParams.get('issues')).toBe('read');
    expect(url.searchParams.get('checks')).toBe('read');
    expect(url.searchParams.get('actions')).toBe('read');
    expect(url.searchParams.getAll('events[]').sort()).toEqual([
      'check_run',
      'check_suite',
      'issue_comment',
      'issues',
      'pull_request',
      'pull_request_review',
      'pull_request_review_comment',
      'push',
      'repository',
      'workflow_run',
    ]);

    const secret = await page.locator('#sh-webhook-secret').textContent();
    expect(secret).toMatch(/^[a-f0-9]{64}$/);

    const result = page.locator('#sh-app-result');
    await expect(result).toBeVisible();

    const preview = page.locator('#sh-app-preview');
    await expect(preview).toContainText('My SAM Instance');
    await expect(preview).toContainText('https://app.example.com');
    await expect(preview).toContainText('Issues: read');
    await expect(preview).toContainText('Checks: read');
    await expect(preview).toContainText('Actions: read');
  });

  test('generate setup link uses organization URL path for org installs', async ({ page }) => {
    await reachGitHubAppStep(page);
    await page.locator('input[name="sh-account-type"][value="org"]').click();
    await page.locator('#sh-org').fill('acme-corp');
    await page.locator('#sh-app-name').fill('SAM');
    await page.getByRole('button', { name: 'Generate setup link' }).click();

    const href = await page.locator('#sh-app-link').getAttribute('href');
    expect(href).toBeTruthy();
    const url = new URL(href!);
    expect(url.pathname).toBe('/organizations/acme-corp/settings/apps/new');
  });

  test('generate setup link with long app name', async ({ page }) => {
    await reachGitHubAppStep(page);
    const longName = 'My-Extremely-Long-Self-Hosted-SAM-Instance-Name-For-Testing-Overflow';
    await page.locator('#sh-app-name').fill(longName);
    await page.getByRole('button', { name: 'Generate setup link' }).click();

    const href = await page.locator('#sh-app-link').getAttribute('href');
    expect(href).toBeTruthy();
    const url = new URL(href!);
    expect(url.searchParams.get('name')).toBe(longName);

    const preview = page.locator('#sh-app-preview');
    await expect(preview).toContainText(longName);
  });

  test('generate button redirects to domain step when domain is empty', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        'sam-self-host-wizard-v1',
        JSON.stringify({
          step: 4,
          furthest: 4,
          accountType: 'personal',
          fields: { 'sh-domain': '', 'sh-cf-account': '0123456789abcdef0123456789abcdef' },
        })
      );
    });
    await openWizard(page);
    await expect(page.getByRole('heading', { name: 'Create your GitHub App' })).toBeVisible();
    await page.getByRole('button', { name: 'Generate setup link' }).click();
    await expect(page.locator('#sh-domain')).toBeVisible();
  });

  test('re-clicking generate reuses existing webhook secret', async ({ page }) => {
    await reachGitHubAppStep(page);
    await page.locator('#sh-app-name').fill('SAM');
    await page.getByRole('button', { name: 'Generate setup link' }).click();
    const secret1 = await page.locator('#sh-webhook-secret').textContent();
    expect(secret1).toMatch(/^[a-f0-9]{64}$/);

    await page.locator('#sh-app-name').fill('SAM Updated');
    await page.getByRole('button', { name: 'Generate setup link' }).click();
    const secret2 = await page.locator('#sh-webhook-secret').textContent();
    expect(secret2).toBe(secret1);

    const preview = page.locator('#sh-app-preview');
    await expect(preview).toContainText('SAM Updated');
  });
});
