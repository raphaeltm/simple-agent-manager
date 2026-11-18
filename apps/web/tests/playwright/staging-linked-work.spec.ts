/**
 * Staging verification for T4 — linked work on chats and library files.
 *
 * Drives the real controls on `app.sammy.party`: the Related item in the session tool rail, and
 * the provenance disclosure in the library file preview. Nothing here sets panel state
 * directly (`.claude/rules/62`).
 *
 * Run inside `exec_with_secrets` with `secretNames: ["SAM_PLAYWRIGHT_PRIMARY_USER"]` — in an
 * agent workspace that variable holds a placeholder, not the token (linked-work program
 * decision 12). The IDs come from env vars so the spec carries no staging state of its own:
 *
 *   T4_PROJECT_ID   the staging project
 *   T4_SESSION_ID   a chat that has linked work
 *   T4_FILE_ID      a library file that has linked work (optional)
 *
 * Run with `--workers=1`: the whole run shares one token-login (see `login` below).
 */
import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const STAGING_APP = 'https://app.sammy.party';
const STAGING_API = 'https://api.sammy.party';
const SHOTS = '../../.codex/tmp/staging-screenshots';

const PROJECT_ID = process.env.T4_PROJECT_ID ?? '';
const SESSION_ID = process.env.T4_SESSION_ID ?? '';
const FILE_ID = process.env.T4_FILE_ID ?? '';

/**
 * Cookies from the one token-login this run is allowed to spend.
 *
 * `POST /api/auth/token-login` is rate limited to 20 per clock hour per IP
 * (`DEFAULT_RATE_LIMIT_TOKEN_LOGIN`, `apps/api/src/routes/api-tokens.ts`), and that budget is
 * shared with every other script in the session. Six tests logging in separately exhausted it
 * mid-run on 2026-10-24 and four of them failed on a 429 rather than on anything about the
 * feature. Each test gets a fresh browser context, but module state lives for the worker, so
 * one login is reused — run this spec with `--workers=1`.
 */
type SessionCookies = Awaited<ReturnType<BrowserContext['cookies']>>;
let sessionCookies: SessionCookies | null = null;

async function login(page: Page): Promise<void> {
  if (sessionCookies && sessionCookies.length > 0) {
    await page.context().addCookies(sessionCookies);
    return;
  }
  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  if (!token) throw new Error('SAM_PLAYWRIGHT_PRIMARY_USER is not set');
  if (token.startsWith('__SAM_SECRET')) {
    throw new Error('SAM_PLAYWRIGHT_PRIMARY_USER is a placeholder — run under exec_with_secrets');
  }
  const res = await page.request.post(`${STAGING_API}/api/auth/token-login`, {
    data: { token },
    headers: { 'Content-Type': 'application/json' },
    timeout: 20_000,
  });
  if (res.status() === 429) {
    throw new Error(
      'token-login is rate limited (20 per clock hour per IP). Wait for the next clock hour ' +
        'rather than retrying — the window does not slide.'
    );
  }
  expect(res.status(), `token-login rejected: ${await res.text()}`).toBe(200);
  sessionCookies = await page.context().cookies();
}

/** The first-run wizard swallows clicks, so it has to go before anything is driven. */
async function dismissOnboarding(page: Page): Promise<void> {
  const wizard = page.getByRole('dialog', { name: 'Account setup' });
  const appeared = await wizard.waitFor({ state: 'visible', timeout: 2_000 }).then(
    () => true,
    () => false
  );
  if (!appeared) return;
  await page.getByRole('button', { name: 'Exit setup' }).click();
  await expect(wizard).toBeHidden({ timeout: 10_000 });
}

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(900);
  await page.screenshot({
    path: `${SHOTS}/${name}-${page.viewportSize()?.width ?? 0}.png`,
    fullPage: false,
  });
}

test.beforeEach(async ({ page }) => {
  expect(PROJECT_ID, 'T4_PROJECT_ID must be set').not.toBe('');
  await login(page);
});

test.describe('T4 staging — the chat Related panel', () => {
  test('opens from the real tool rail and lists the chat linked work', async ({ page }) => {
    expect(SESSION_ID, 'T4_SESSION_ID must be set').not.toBe('');
    await page.goto(`${STAGING_APP}/projects/${PROJECT_ID}/chat/${SESSION_ID}`, {
      waitUntil: 'domcontentloaded',
    });
    await dismissOnboarding(page);

    // Liveness: the rail rendered, so the page did not crash. Without this every assertion
    // below could pass vacuously on a broken page.
    const related = page.getByTestId('session-tool-related');
    await expect(related).toBeVisible({ timeout: 30_000 });
    await shot(page, 't4-staging-rail');

    await related.click();
    const drawer = page.getByTestId('session-linked-work-drawer');
    await expect(drawer).toBeVisible({ timeout: 15_000 });
    // Something is actually listed — an empty panel here would mean the read failed.
    await expect(drawer.getByTestId('linked-work-idea').first()).toBeVisible({ timeout: 15_000 });
    await expect(drawer.getByTestId('linked-work-error')).toHaveCount(0);
    await shot(page, 't4-staging-related');

    // Every console error on this page, so a silent failure cannot hide behind a rendered row.
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.waitForTimeout(500);
    expect(errors.filter((e) => /links|linked/i.test(e))).toEqual([]);
  });

  test('a linked idea row opens the idea', async ({ page }) => {
    await page.goto(`${STAGING_APP}/projects/${PROJECT_ID}/chat/${SESSION_ID}`, {
      waitUntil: 'domcontentloaded',
    });
    await dismissOnboarding(page);
    await page.getByTestId('session-tool-related').click();
    const row = page
      .getByTestId('session-linked-work-drawer')
      .getByTestId('linked-work-idea')
      .first();
    await expect(row).toBeVisible({ timeout: 20_000 });
    const href = await row.getAttribute('href');
    expect(href, 'the idea row must link to the idea page').toMatch(
      new RegExp(`^/projects/${PROJECT_ID}/ideas/`)
    );
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT_ID}/ideas/`), { timeout: 20_000 });
    await shot(page, 't4-staging-idea-from-row');
  });
});

test.describe('T4 staging — the library file preview', () => {
  test('says where the file came from and expands to the detail', async ({ page }) => {
    test.skip(FILE_ID === '', 'T4_FILE_ID not set — no linked library file to check');
    await page.goto(`${STAGING_APP}/projects/${PROJECT_ID}/library?preview=${FILE_ID}`, {
      waitUntil: 'domcontentloaded',
    });
    await dismissOnboarding(page);

    // Liveness: the preview opened.
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30_000 });
    const toggle = page.getByTestId('file-linked-work-toggle');
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await shot(page, 't4-staging-file-collapsed');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const rows = page.getByTestId('file-linked-chat').or(page.getByTestId('file-linked-idea'));
    await expect(rows.first()).toBeVisible({ timeout: 15_000 });
    await shot(page, 't4-staging-file-expanded');
  });
});
