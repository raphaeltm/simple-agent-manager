/**
 * STAGING verification for the Hetzner 412 placement-capacity fix — not part of the CI suite.
 *
 *   PLAYWRIGHT_BASE_URL=https://app.sammy.party npx playwright test staging-hetzner-412-provisioning \
 *     --project="Desktop (1280x800)"
 *
 * WHAT THIS CAN AND CANNOT PROVE
 * ------------------------------
 * The change is in `HetznerProvider.createVM`'s ERROR path: a 412 "error during placement" is now
 * classified `transient_capacity`, which lets the capacity-pool fallback chain descend.
 *
 * A 412 cannot be induced on demand — it means Hetzner momentarily cannot place a given server
 * type in a given location. So this file verifies the two things staging genuinely can:
 *
 *   1. The SUCCESS path through the modified provider still provisions a real VM end to end.
 *      This is the regression that would actually hurt: `createVM`'s retry/classification logic
 *      sits directly on the provisioning path, and rule 22 requires real VM provisioning for any
 *      change that can affect it.
 *   2. The app itself is unregressed.
 *
 * The error branch is covered instead by unit tests built from the real `providerFetch`
 * construction site and proven discriminating by a surgical revert — see
 * `packages/providers/tests/unit/hetzner-placement-capacity.test.ts` and the incident block in
 * `apps/api/tests/unit/durable-objects/task-runner-capacity-exhaustion.test.ts`.
 * This limitation is stated in the PR rather than papered over (`.claude/rules/30`).
 */
import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const STAGING_API = 'https://api.sammy.party';
const STAGING_APP = 'https://app.sammy.party';

const LOGIN_TIMEOUT_MS = 20_000;
const LOGIN_ATTEMPTS = 3;
/** A real Hetzner boot takes minutes; poll well past the optimistic case. */
const PROVISION_TIMEOUT_MS = 6 * 60_000;
const POLL_INTERVAL_MS = 10_000;

test.skip(
  !process.env.SAM_PLAYWRIGHT_PRIMARY_USER,
  'Staging-only: requires SAM_PLAYWRIGHT_PRIMARY_USER'
);

test.describe.configure({ timeout: 600_000 });

type StoredCookies = Awaited<ReturnType<BrowserContext['storageState']>>['cookies'];
let cachedCookies: StoredCookies | null = null;

async function login(page: Page) {
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

async function dismissOnboardingIfPresent(page: Page) {
  const wizard = page.getByRole('dialog', { name: 'Account setup' });
  if (!(await wizard.isVisible({ timeout: 3_000 }).catch(() => false))) return;
  await page.getByRole('button', { name: 'Exit setup' }).click();
  await expect(wizard).toBeHidden({ timeout: 10_000 });
}

async function shot(page: Page, name: string) {
  const w = page.viewportSize()?.width ?? 0;
  await page.waitForTimeout(800);
  await page.screenshot({
    path: `../../.codex/tmp/staging-screenshots/${name}-${w}.png`,
    fullPage: false,
  });
}

test.describe('Staging — Hetzner 412 placement fix', () => {
  test('a real VM still provisions through the modified provider path', async ({ page }) => {
    await login(page);

    const created = await page.request.post(`${STAGING_API}/api/nodes`, {
      data: {
        name: `verify-412-${Date.now()}`,
        vmSize: 'small',
        vmLocation: 'fsn1',
        provider: 'hetzner',
      },
      headers: { 'Content-Type': 'application/json' },
      timeout: 60_000,
    });
    expect(
      created.status(),
      `node creation rejected: ${await created.text()}`
    ).toBeLessThan(300);
    const node = (await created.json()) as { id: string; status?: string };
    expect(node.id, 'node creation returned no id').toBeTruthy();

    let last: { status?: string; errorMessage?: string | null; ipAddress?: string | null } = {};
    const deadline = Date.now() + PROVISION_TIMEOUT_MS;
    try {
      while (Date.now() < deadline) {
        const res = await page.request.get(`${STAGING_API}/api/nodes/${node.id}`, {
          timeout: 30_000,
        });
        if (res.status() === 200) {
          last = (await res.json()) as typeof last;
          // 'error' is terminal — fail immediately rather than burning the whole budget.
          if (last.status === 'error') break;
          if (last.status === 'running') break;
        }
        await page.waitForTimeout(POLL_INTERVAL_MS);
      }

      expect(
        last.status,
        `node did not reach running; last state ${JSON.stringify(last)}`
      ).toBe('running');
      /*
       * The IP is the proof that a REAL Hetzner allocation happened rather than a D1 row being
       * written: it is assigned by the provider and echoed back through `createVM`. The node
       * response deliberately does not expose `providerInstanceId`, so this is the strongest
       * allocation signal available to an API client.
       */
      expect(last.ipAddress, 'running node has no IP').toBeTruthy();

      /*
       * Emit the evidence BEFORE cleanup.
       *
       * `DELETE /api/nodes/:id` HARD-deletes the row — verified 2026-09-09 against staging D1,
       * where a node created by this very test left no trace at all afterwards. So a reviewer who
       * later queries D1 to confirm this test really provisioned something finds nothing and
       * reasonably concludes the test was a false green. The run's own output is therefore the
       * only durable proof, and it has to be captured here rather than reconstructed later.
       */
      test.info().annotations.push({
        type: 'provisioned',
        description: `node=${node.id} ip=${last.ipAddress} status=${last.status}`,
      });
      // eslint-disable-next-line no-console -- this line IS the verification evidence
      console.log(
        `[staging-verify] provisioned node=${node.id} ip=${last.ipAddress} status=${last.status}`
      );
    } finally {
      // Live test cleanup is mandatory (CLAUDE.md, Testing). Runs even on failure.
      const deleted = await page.request
        .delete(`${STAGING_API}/api/nodes/${node.id}`, { timeout: 60_000 })
        .catch(() => undefined);
      // eslint-disable-next-line no-console -- cleanup evidence
      console.log(`[staging-verify] cleanup node=${node.id} status=${deleted?.status() ?? 'threw'}`);
    }
  });

  test('core surfaces are unregressed', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await login(page);

    await page.goto(`${STAGING_APP}/dashboard`);
    await dismissOnboardingIfPresent(page);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await shot(page, 'dashboard');

    await page.goto(`${STAGING_APP}/projects`);
    await dismissOnboardingIfPresent(page);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await shot(page, 'projects');

    await page.goto(`${STAGING_APP}/settings`);
    await dismissOnboardingIfPresent(page);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await shot(page, 'settings');

    await page.goto(`${STAGING_APP}/nodes`);
    await dismissOnboardingIfPresent(page);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await shot(page, 'nodes');

    // Chunk-load races and auth redirects produce console errors that are not this PR's
    // doing; assert on the ones that would indicate a broken page.
    const relevant = consoleErrors.filter(
      (e) => !/Failed to load resource|net::ERR|favicon|ResizeObserver/i.test(e)
    );
    expect(relevant, `unexpected console errors: ${relevant.join(' | ')}`).toHaveLength(0);
  });
});
