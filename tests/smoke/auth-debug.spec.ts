import { test, expect } from '@playwright/test';

const API_URL = process.env.SMOKE_TEST_API_URL || 'https://api.sammy.party';
const APP_URL = process.env.SMOKE_TEST_URL || 'https://app.sammy.party';
const TOKEN = process.env.SMOKE_TEST_TOKEN;

test.describe('Auth Debug', () => {
  test('token-login returns session cookie', async ({ context }) => {
    test.skip(!TOKEN, 'SMOKE_TEST_TOKEN not configured');

    // Step 1: Call token-login via Playwright API request
    const response = await context.request.post(`${API_URL}/api/auth/token-login`, {
      data: { token: TOKEN },
      headers: { 'Content-Type': 'application/json' },
    });

    console.log(`[DEBUG] token-login status: ${response.status()}`);
    const body = await response.json();
    console.log(`[DEBUG] token-login body: ${JSON.stringify(body)}`);

    // Check response headers
    const headers = response.headers();
    console.log(`[DEBUG] Set-Cookie header: ${headers['set-cookie'] || '(not present)'}`);
    console.log(`[DEBUG] All response headers: ${JSON.stringify(headers, null, 2)}`);

    expect(response.ok()).toBe(true);
    expect(body.success).toBe(true);

    // Step 2: Check what cookies Playwright captured
    const apiCookies = await context.cookies(API_URL);
    console.log(`[DEBUG] Cookies for ${API_URL}: ${JSON.stringify(apiCookies, null, 2)}`);

    const appCookies = await context.cookies(APP_URL);
    console.log(`[DEBUG] Cookies for ${APP_URL}: ${JSON.stringify(appCookies, null, 2)}`);

    // Step 3: Manually set cookie using sessionToken from body
    if (body.sessionToken) {
      console.log(`[DEBUG] Setting cookie manually from body.sessionToken`);
      await context.addCookies([
        {
          name: 'better-auth.session_token',
          value: body.sessionToken,
          domain: '.sammy.party',
          path: '/',
          httpOnly: true,
          secure: true,
          sameSite: 'None',
        },
      ]);

      const cookiesAfterSet = await context.cookies(APP_URL);
      console.log(`[DEBUG] Cookies after manual set: ${JSON.stringify(cookiesAfterSet, null, 2)}`);
    }

    // Step 4: Try the get-session endpoint to verify session works
    const sessionResponse = await context.request.get(`${API_URL}/api/auth/get-session`);
    console.log(`[DEBUG] get-session status: ${sessionResponse.status()}`);
    const sessionBody = await sessionResponse.json().catch(() => sessionResponse.text());
    console.log(`[DEBUG] get-session body: ${JSON.stringify(sessionBody)}`);

    // Step 5: Navigate to app and check what happens
    const page = await context.newPage();
    const networkRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('auth') || req.url().includes('session')) {
        networkRequests.push(`${req.method()} ${req.url()}`);
      }
    });
    page.on('response', (res) => {
      if (res.url().includes('auth') || res.url().includes('session')) {
        networkRequests.push(`  → ${res.status()} ${res.url()}`);
      }
    });

    await page.goto(APP_URL, { waitUntil: 'networkidle' });

    console.log(`[DEBUG] Final URL: ${page.url()}`);
    console.log(`[DEBUG] Auth-related network requests:\n${networkRequests.join('\n')}`);

    const pageTitle = await page.textContent('body');
    console.log(`[DEBUG] Page content (first 200 chars): ${pageTitle?.substring(0, 200)}`);
  });
});
