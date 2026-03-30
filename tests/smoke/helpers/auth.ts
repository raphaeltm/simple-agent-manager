import { type BrowserContext, type Page, expect } from '@playwright/test';

/**
 * Authenticate a Playwright browser context using a smoke test token.
 *
 * POSTs to /api/auth/token-login with the provided token,
 * captures the session cookie, and adds it to the browser context.
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

  // The response sets the session cookie. Playwright's context.request
  // automatically captures Set-Cookie headers, but we need to ensure
  // the cookie is available for page navigation too.
  // Extract cookies from the API domain and set them for the app domain.
  const cookies = await context.cookies(apiUrl);
  const sessionCookie = cookies.find((c) => c.name === 'better-auth.session_token');

  if (sessionCookie) {
    // Extract the base domain for cookie sharing
    // e.g., from "api.sammy.party" we need ".sammy.party"
    const apiHostname = new URL(apiUrl).hostname;
    const parts = apiHostname.split('.');
    const baseDomain = parts.length >= 2 ? `.${parts.slice(-2).join('.')}` : apiHostname;

    await context.addCookies([
      {
        ...sessionCookie,
        domain: baseDomain,
        path: '/',
      },
    ]);
  }

  // Create a page and navigate to the app
  const page = await context.newPage();
  await page.goto(appUrl);

  return page;
}
