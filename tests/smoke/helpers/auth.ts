import { type BrowserContext, type Page, expect } from '@playwright/test';

/**
 * Authenticate a Playwright browser context using a smoke test token.
 *
 * Calls the token-login endpoint via context.request (to get the signed
 * cookie value), then injects the signed cookie into the browser context
 * so page navigations can use it.
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

  // Call the token-login endpoint via context.request
  const response = await context.request.post(`${apiUrl}/api/auth/token-login`, {
    data: { token },
    headers: { 'Content-Type': 'application/json' },
  });

  expect(response.ok(), `Token login failed: ${response.status()} ${await response.text()}`).toBe(
    true
  );

  const body = await response.json();
  expect(body.success).toBe(true);

  // Extract the SIGNED cookie value from the Set-Cookie header.
  // BetterAuth uses HMAC-SHA256 signed cookies: `token.signature`
  // The server already signs the cookie, so we need to extract and re-inject it.
  // BetterAuth uses __Secure- prefix when baseURL starts with https://.
  // Match either prefixed or unprefixed cookie name.
  const setCookieHeader = response.headers()['set-cookie'] || '';
  const cookieMatch = setCookieHeader.match(
    /(__Secure-)?better-auth\.session_token=([^;]+)/
  );

  if (!cookieMatch) {
    throw new Error(
      `Token login succeeded but no session cookie in Set-Cookie header. ` +
        `Header: ${setCookieHeader.substring(0, 200)}`
    );
  }

  const cookiePrefix = cookieMatch[1] || '';
  const cookieName = `${cookiePrefix}better-auth.session_token`;

  // The cookie value is URL-encoded (e.g., token.signature%3D), decode it for addCookies
  const signedValue = decodeURIComponent(cookieMatch[2]);

  // Extract the base domain for cookie sharing
  const apiHostname = new URL(apiUrl).hostname;
  const parts = apiHostname.split('.');
  const baseDomain = parts.length >= 2 ? `.${parts.slice(-2).join('.')}` : apiHostname;

  // Inject the signed cookie into the browser context.
  // context.request and page share cookie storage in Playwright, but
  // we set it explicitly to ensure domain scoping is correct.
  await context.addCookies([
    {
      name: cookieName,
      value: signedValue,
      domain: baseDomain,
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
    },
  ]);

  // Create a page and navigate to the app
  const page = await context.newPage();
  await page.goto(appUrl, { waitUntil: 'networkidle', timeout: 15_000 });

  return page;
}
