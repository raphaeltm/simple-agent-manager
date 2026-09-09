/**
 * Shared helpers for the `staging-*.spec.ts` files.
 *
 * These specs talk to real staging, and every one of them needs the same three things: a
 * token-login, a way past the first-run onboarding modal, and a screenshot. Six specs had
 * grown their own copy. New staging specs should import from here rather than add a seventh
 * (`.claude/rules/24`). Migrating the pre-existing copies is tracked separately so it does not
 * ride along with unrelated changes.
 */
import { type BrowserContext, expect, type Page } from '@playwright/test';

export const STAGING_API = 'https://api.sammy.party';
export const STAGING_APP = 'https://app.sammy.party';

/** Per-attempt budget for the login request, well under any sane per-test timeout. */
const LOGIN_TIMEOUT_MS = 20_000;
const LOGIN_ATTEMPTS = 3;

type StoredCookies = Awaited<ReturnType<BrowserContext['storageState']>>['cookies'];
let cachedCookies: StoredCookies | null = null;

/** Test-only: drop the cached session so a spec can force a fresh login. */
export function resetStagingLoginCache(): void {
  cachedCookies = null;
}

/**
 * Authenticate the browser context against staging.
 *
 * `token-login` is rate limited per principal and every test gets a fresh context, so logging
 * in per test trips RATE_LIMIT_EXCEEDED and fails the run for a reason unrelated to the code
 * under test. Log in once per worker and replay the cookie.
 *
 * The bounded retry exists because a worker's FIRST request can hang on connection setup:
 * observed sitting the full test budget while the very next login succeeded in seconds and
 * curl returned 200 throughout. Unbounded, that hang reads as "login failed" and misdirects at
 * credentials. A non-2xx answer is NOT retried — the server answered, and retrying a 429 is
 * pointless.
 */
export async function stagingLogin(page: Page): Promise<void> {
  if (cachedCookies) {
    await page.context().addCookies(cachedCookies);
    return;
  }

  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  let lastError = '';
  for (let attempt = 1; attempt <= LOGIN_ATTEMPTS; attempt += 1) {
    try {
      const res = await page.request.post(`${STAGING_API}/api/auth/token-login`, {
        data: { token },
        headers: { 'Content-Type': 'application/json' },
        timeout: LOGIN_TIMEOUT_MS,
      });
      expect(res.status(), `token-login rejected: ${await res.text()}`).toBe(200);
      cachedCookies = (await page.context().storageState()).cookies;
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (lastError.includes('token-login rejected')) throw err;
    }
  }
  throw new Error(`token-login did not complete in ${LOGIN_ATTEMPTS} attempts: ${lastError}`);
}

/**
 * Dismiss the first-run "Account setup" wizard if it is up.
 *
 * Not a verification blocker — staging has an enabled platform credential, so workspaces
 * provision without a user cloud credential (CLAUDE.md, Architecture Principle 1). It IS a test
 * hazard: the modal SWALLOWS CLICKS, so a control is found, clicked, nothing happens, and the
 * test reads as a broken feature (`.claude/rules/62`).
 */
export async function dismissStagingOnboarding(page: Page): Promise<void> {
  const wizard = page.getByRole('dialog', { name: 'Account setup' });
  // Short probe: absent is the common case and must not cost the test its budget.
  if (!(await wizard.isVisible({ timeout: 3_000 }).catch(() => false))) return;
  await page.getByRole('button', { name: 'Exit setup' }).click();
  await expect(wizard).toBeHidden({ timeout: 10_000 });
}

/** Screenshot with a render settle, keyed by viewport width. */
export async function stagingShot(page: Page, name: string): Promise<void> {
  const width = page.viewportSize()?.width ?? 0;
  // Longer settle than the local audit because staging paints over a real network.
  await page.waitForTimeout(800);
  await page.screenshot({
    path: `../../.codex/tmp/staging-screenshots/${name}-${width}.png`,
    fullPage: false,
  });
}
