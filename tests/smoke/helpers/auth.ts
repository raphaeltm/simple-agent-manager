import { type BrowserContext, type Page, expect } from '@playwright/test';

/**
 * Authenticate a Playwright browser context using a smoke test token.
 *
 * Uses a page-level fetch to call the token-login endpoint, which lets the
 * browser handle Set-Cookie headers natively (including domain scoping).
 * Then navigates to the app URL.
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

  // Open a page on the API domain first — this ensures the browser
  // processes Set-Cookie headers for the correct domain.
  const page = await context.newPage();

  // Navigate to the API domain (health endpoint is lightweight)
  await page.goto(`${apiUrl}/health`, { waitUntil: 'domcontentloaded' });

  // Use the browser's fetch to call token-login. This ensures:
  // 1. The browser sees the Set-Cookie header directly
  // 2. Cookie domain scoping works correctly
  // 3. No manual cookie extraction/injection needed
  const loginResult = await page.evaluate(
    async ({ apiUrl, token }) => {
      const res = await fetch(`${apiUrl}/api/auth/token-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
        credentials: 'include',
      });

      const body = await res.json();
      return {
        ok: res.ok,
        status: res.status,
        body,
      };
    },
    { apiUrl, token }
  );

  expect(
    loginResult.ok,
    `Token login failed: ${loginResult.status} ${JSON.stringify(loginResult.body)}`
  ).toBe(true);
  expect(loginResult.body.success).toBe(true);

  // Now navigate to the app — the browser already has the session cookie
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });

  return page;
}
