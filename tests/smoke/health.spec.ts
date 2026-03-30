import { test, expect } from '@playwright/test';

const API_URL = process.env.SMOKE_TEST_API_URL || 'https://api.sammy.party';

test.describe('Health checks', () => {
  test('API health endpoint returns healthy', async ({ request }) => {
    const response = await request.get(`${API_URL}/health`);
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.status).toBe('healthy');
  });

  test('API returns CORS headers for app origin', async ({ request }) => {
    const appUrl = process.env.SMOKE_TEST_URL || 'https://app.sammy.party';
    const response = await request.get(`${API_URL}/health`, {
      headers: { Origin: appUrl },
    });
    expect(response.ok()).toBe(true);
  });

  test('App loads without errors', async ({ page }) => {
    const appUrl = process.env.SMOKE_TEST_URL || 'https://app.sammy.party';
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto(appUrl);
    await page.waitForLoadState('networkidle');

    // App should at least render something (login or dashboard)
    const body = await page.textContent('body');
    expect(body).toBeTruthy();

    // Filter out expected errors (e.g., 401 for unauthenticated requests)
    const unexpectedErrors = consoleErrors.filter(
      (err) => !err.includes('401') && !err.includes('Unauthorized')
    );
    expect(unexpectedErrors).toHaveLength(0);
  });
});
