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
    console.log(`[DEBUG] success: ${body.success}, has sessionToken: ${!!body.sessionToken}`);

    const setCookieHeader = response.headers()['set-cookie'] || '';
    console.log(`[DEBUG] Set-Cookie: ${setCookieHeader.substring(0, 300)}`);

    expect(response.ok()).toBe(true);

    // Step 2: Extract signed cookie value
    const cookieMatch = setCookieHeader.match(/better-auth\.session_token=([^;]+)/);
    expect(cookieMatch, 'No session cookie in Set-Cookie').toBeTruthy();
    const signedValue = decodeURIComponent(cookieMatch![1]);
    console.log(`[DEBUG] Signed cookie (decoded, first 80): ${signedValue.substring(0, 80)}`);
    console.log(`[DEBUG] Signed cookie contains dot: ${signedValue.includes('.')}`);
    console.log(`[DEBUG] Parts: ${signedValue.split('.').length}`);

    // Step 3: Check get-session with the context.request cookie jar
    // (context.request DOES capture Set-Cookie cookies)
    const sessionRes = await context.request.get(`${API_URL}/api/auth/get-session`);
    console.log(`[DEBUG] get-session (via context.request) status: ${sessionRes.status()}`);
    const sessionText = await sessionRes.text();
    console.log(`[DEBUG] get-session body: ${sessionText.substring(0, 500)}`);

    // Step 4: Try calling get-session with explicit cookie header
    const sessionRes2 = await context.request.get(`${API_URL}/api/auth/get-session`, {
      headers: {
        Cookie: `better-auth.session_token=${encodeURIComponent(signedValue)}`,
      },
    });
    console.log(`[DEBUG] get-session (explicit cookie) status: ${sessionRes2.status()}`);
    const sessionText2 = await sessionRes2.text();
    console.log(`[DEBUG] get-session (explicit cookie) body: ${sessionText2.substring(0, 500)}`);

    // Step 5: Try with raw unsigned token
    const sessionRes3 = await context.request.get(`${API_URL}/api/auth/get-session`, {
      headers: {
        Cookie: `better-auth.session_token=${body.sessionToken}`,
      },
    });
    console.log(`[DEBUG] get-session (raw unsigned) status: ${sessionRes3.status()}`);
    const sessionText3 = await sessionRes3.text();
    console.log(`[DEBUG] get-session (raw unsigned) body: ${sessionText3.substring(0, 500)}`);

    // Step 6: Check if there is a user-status issue
    console.log(`[DEBUG] User from token-login: ${JSON.stringify(body.user)}`);
  });
});
