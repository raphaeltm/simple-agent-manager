import { type BrowserContext, type Page, expect } from '@playwright/test';

/**
 * Authenticate a Playwright browser context using a smoke test token.
 *
 * POSTs to /api/auth/token-login with the provided token,
 * extracts the session cookie from the Set-Cookie header,
 * and injects it into the browser context for the app domain.
 *
 * Returns the authenticated page ready for use.
 */
export async function loginWithToken(
  context: BrowserContext,
  options?: {
    apiUrl?: string;
    appUrl?: string;
    token?: string;
  }
): Promise<Page> {
  const apiUrl = options?.apiUrl || process.env.SMOKE_TEST_API_URL || 'https://api.sammy.party';
  const appUrl = options?.appUrl || process.env.SMOKE_TEST_URL || 'https://app.sammy.party';
  const token = options?.token || process.env.SMOKE_TEST_TOKEN;

  if (!token) {
    throw new Error(
      'SMOKE_TEST_TOKEN environment variable is required. ' +
        'Generate one from Settings → Test Tokens in the app.'
    );
  }

  // Call the token-login endpoint
  const response = await context.request.post(`${apiUrl}/api/auth/token-login`, {
    data: { token },
    headers: { 'Content-Type': 'application/json' },
  });

  expect(response.ok(), `Token login failed: ${response.status()} ${await response.text()}`).toBe(
    true
  );

  const body = await response.json();
  expect(body.success).toBe(true);

  // Get the session token. Try multiple sources for robustness:
  // 1. Response body (most reliable — our endpoint includes it)
  // 2. Set-Cookie header
  // 3. Playwright cookie jar
  let sessionTokenValue: string | undefined = body.sessionToken;

  if (!sessionTokenValue) {
    const setCookieHeader = response.headers()['set-cookie'] || '';
    const sessionTokenMatch = setCookieHeader.match(/better-auth\.session_token=([^;]+)/);
    sessionTokenValue = sessionTokenMatch?.[1];
  }

  if (!sessionTokenValue) {
    const cookies = await context.cookies(apiUrl);
    const sessionCookie = cookies.find((c) => c.name === 'better-auth.session_token');
    sessionTokenValue = sessionCookie?.value;
  }

  if (!sessionTokenValue) {
    throw new Error(
      'Token login succeeded but no session cookie was returned. ' +
        `Set-Cookie header: ${setCookieHeader ? setCookieHeader.substring(0, 100) : '(empty)'}`
    );
  }

  // Extract the base domain for cookie sharing
  // e.g., from "api.sammy.party" we need ".sammy.party"
  const apiHostname = new URL(apiUrl).hostname;
  const parts = apiHostname.split('.');
  const baseDomain = parts.length >= 2 ? `.${parts.slice(-2).join('.')}` : apiHostname;

  // Set the session cookie for the base domain so both app and API subdomains can use it
  await context.addCookies([
    {
      name: 'better-auth.session_token',
      value: sessionTokenValue,
      domain: baseDomain,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    },
  ]);

  // Create a page and navigate to the app
  const page = await context.newPage();
  await page.goto(appUrl);

  return page;
}
