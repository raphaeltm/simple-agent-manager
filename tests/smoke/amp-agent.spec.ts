import { expect, test } from '@playwright/test';

import { loginWithToken } from './helpers/auth';

test.describe('Amp agent', () => {
  test('catalog and settings page expose Amp as API-key ACP agent', async ({ context }) => {
    const apiUrl = process.env.SMOKE_TEST_API_URL || 'https://api.sammy.party';
    const appUrl = process.env.SMOKE_TEST_URL || 'https://app.sammy.party';
    const page = await loginWithToken(context, { apiUrl, appUrl });

    const catalogResponse = await page.request.get(`${apiUrl}/api/agents`);
    expect(catalogResponse.status()).toBe(200);

    const catalog = await catalogResponse.json();
    const amp = catalog.agents.find((agent: { id: string }) => agent.id === 'amp');

    expect(amp).toMatchObject({
      id: 'amp',
      name: 'Amp',
      supportsAcp: true,
    });
    expect(amp.oauthSupport).toBeUndefined();
    expect(amp.fallbackCloudProvider).toBeUndefined();

    await page.goto(`${appUrl}/settings/agents`);
    await page.waitForLoadState('networkidle');

    const body = page.locator('body');
    await expect(body).toContainText('Amp');
    await expect(body).toContainText('API key');

    const pageText = await body.textContent();
    const ampSection = pageText?.match(/Amp[\s\S]{0,800}/)?.[0] ?? '';

    expect(ampSection).not.toMatch(/OAuth/i);
    expect(ampSection).not.toMatch(/ChatGPT subscription/i);
  });
});
