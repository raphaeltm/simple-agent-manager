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
/**
 * How long to wait for the first-run modal before deciding it is not coming.
 *
 * This is paid on EVERY navigation where the modal is absent, which is the common case, so it
 * trades directly against suite runtime. Kept short deliberately: the modal is rendered by the
 * same lazy chunk as the page under test, so if the page has painted and the modal has not
 * appeared within this window, it is not coming.
 */
const ONBOARDING_PROBE_TIMEOUT_MS = 2_000;
/** How many times to attempt the dismissal before asserting the wizard is gone. */
const ONBOARDING_DISMISS_ATTEMPTS = 4;
/**
 * Short, so a click onto a node that is about to detach fails fast and the next attempt gets a
 * freshly resolved one. Playwright's default would retry inside one call until the TEST timeout.
 */
const ONBOARDING_CLICK_TIMEOUT_MS = 5_000;
/** How long the wizard must stay gone before a dismissal counts as real. */
const ONBOARDING_SETTLE_MS = 750;

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
  /*
   * `waitFor`, NOT `isVisible({ timeout })`. Playwright deprecated that option and IGNORES it:
   * `isVisible` is a one-shot check that returns the state right now. The modal renders after
   * the route chunk loads, so a one-shot probe usually runs too early, reports "absent", and the
   * caller proceeds into a screen the modal is about to cover — which is the click-swallowing
   * failure this helper exists to prevent, reintroduced by the probe meant to avoid it.
   *
   * Absent is still the common case and must not cost the test its budget, hence the short
   * bounded wait rather than an assertion.
   */
  const appeared = await wizard
    .waitFor({ state: 'visible', timeout: ONBOARDING_PROBE_TIMEOUT_MS })
    .then(
      () => true,
      () => false
    );
  if (!appeared) return;
  /*
   * Attempt the dismissal, then judge the OUTCOME, and retry the attempt — rather than
   * requiring one particular click to succeed.
   *
   * The modal remounts while the route behind it finishes loading, so a click can resolve a
   * node, scroll it into view and then find it detached. Playwright keeps retrying inside the
   * single `click()`, which turns a transient remount into the whole test's timeout: on the
   * Ideas route (87 real ideas on staging) that burnt 120s and took the other six tests with
   * it, reporting the failure against a shared helper rather than against anything the spec
   * was testing.
   *
   * The click is allowed to fail because it is not the thing being asserted; the wizard being
   * gone is, and that is asserted unconditionally below whether or not any click reported
   * success (`.claude/rules/17` — a conditional attempt still needs an unconditional
   * assertion).
   */
  const exitSetup = wizard.getByRole('button', { name: 'Exit setup' });
  for (let attempt = 0; attempt < ONBOARDING_DISMISS_ATTEMPTS; attempt += 1) {
    const gone = await wizard.waitFor({ state: 'hidden', timeout: 1_000 }).then(
      () => true,
      () => false
    );
    if (gone) {
      /*
       * Hidden once is not dismissed. The modal REMOUNTS, so `hidden` is also true in the gap
       * between the old node detaching and its replacement mounting — returning there hands
       * the next action a page the wizard is about to cover again. Confirm it stays gone.
       */
      const stayedGone = await wizard
        .waitFor({ state: 'visible', timeout: ONBOARDING_SETTLE_MS })
        .then(
          () => false,
          () => true
        );
      if (stayedGone) return;
      continue;
    }
    await exitSetup.click({ timeout: ONBOARDING_CLICK_TIMEOUT_MS }).catch(() => undefined);
  }
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
