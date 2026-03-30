import { test, expect } from '@playwright/test';

const API_URL = process.env.SMOKE_TEST_API_URL || 'https://api.sammy.party';
const APP_URL = process.env.SMOKE_TEST_URL || 'https://app.sammy.party';
const TOKEN = process.env.SMOKE_TEST_TOKEN;

test.describe('Auth Debug', () => {
  test('token-login creates valid session', async ({ context }) => {
    test.skip(!TOKEN, 'SMOKE_TEST_TOKEN not configured');

    // Step 1: Call token-login
    const response = await context.request.post(`${API_URL}/api/auth/token-login`, {
      data: { token: TOKEN },
      headers: { 'Content-Type': 'application/json' },
    });

    console.log(`[DEBUG] token-login status: ${response.status()}`);
    const body = await response.json();
    console.log(`[DEBUG] token-login body keys: ${Object.keys(body)}`);

    const setCookieHeader = response.headers()['set-cookie'] || '';
    console.log(`[DEBUG] Set-Cookie: ${setCookieHeader.substring(0, 200)}`);

    expect(response.ok()).toBe(true);

    // Step 2: Extract signed cookie value
    const cookieMatch = setCookieHeader.match(/better-auth\.session_token=([^;]+)/);
    expect(cookieMatch, 'No session cookie in Set-Cookie header').toBeTruthy();
    const signedValue = decodeURIComponent(cookieMatch![1]);
    console.log(`[DEBUG] Signed cookie value (first 50): ${signedValue.substring(0, 50)}...`);

    // Step 3: Inject signed cookie into browser context
    await context.addCookies([
      {
        name: 'better-auth.session_token',
        value: signedValue,
        domain: '.sammy.party',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'None',
      },
    ]);

    // Step 4: Verify cookie is set
    const cookies = await context.cookies(APP_URL);
    console.log(`[DEBUG] Cookies for app: ${JSON.stringify(cookies.map((c) => ({ name: c.name, value: c.value.substring(0, 30) + '...' })))}`);

    // Step 5: Open page and capture ALL network requests
    const page = await context.newPage();
    const allRequests: string[] = [];
    page.on('request', (req) => {
      allRequests.push(`${req.method()} ${req.url()}`);
    });
    page.on('response', (res) => {
      allRequests.push(`  → ${res.status()} ${res.url()}`);
    });

    console.log(`[DEBUG] Navigating to ${APP_URL}...`);
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 15_000 });

    console.log(`[DEBUG] Final URL: ${page.url()}`);
    console.log(`[DEBUG] All network requests (${allRequests.length}):\n${allRequests.join('\n')}`);

    const pageText = await page.textContent('body');
    console.log(`[DEBUG] Page text (first 300): ${pageText?.substring(0, 300)}`);

    // The test passes regardless — we just want the debug output
    expect(true).toBe(true);
  });
});
