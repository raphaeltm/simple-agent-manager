/**
 * STAGING verification for the session interrupt/stop flow — not part of CI.
 *
 * Run explicitly against the deployed staging app:
 *   PLAYWRIGHT_BASE_URL=https://app.sammy.party npx playwright test staging-interrupt-flow \
 *     --project="Desktop (1280x800)"
 *
 * This is the gate for BOTH reported symptoms, and neither can be verified by a
 * page load (`.claude/rules/30`):
 *
 *   A. "Interrupt often doesn't stop quickly and needs multiple presses."
 *      -> press it ONCE against a genuinely working agent and assert the session
 *         leaves the working state, without a second press.
 *   B. "After stopping mid-turn, follow-up prompts don't work."
 *      -> send a follow-up after the interrupt and assert the agent responds.
 *
 * Both therefore need a REAL agent mid-turn on a real workspace. There is no
 * mock anywhere in this file.
 */
import { type BrowserContext, expect, type Page, test } from '@playwright/test';

const STAGING_API = 'https://api.sammy.party';
const STAGING_APP = 'https://app.sammy.party';

const LOGIN_TIMEOUT_MS = 20_000;
const LOGIN_ATTEMPTS = 3;

/** Provisioning a VM and getting a first token out of an agent is minutes, not seconds. */
const AGENT_START_TIMEOUT_MS = 10 * 60_000;

test.skip(
  !process.env.SAM_PLAYWRIGHT_PRIMARY_USER,
  'Staging-only: requires SAM_PLAYWRIGHT_PRIMARY_USER'
);

// Real provisioning, a real agent turn, an interrupt and a follow-up all inside
// one test. The project default (30s) is not remotely enough.
test.describe.configure({ timeout: 20 * 60_000, mode: 'serial' });

type StoredCookies = Awaited<ReturnType<BrowserContext['storageState']>>['cookies'];
let cachedCookies: StoredCookies | null = null;

/** See staging-tool-rail-verify.spec.ts for why this is bounded and cached. */
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

/**
 * The first-run wizard covers the chat and SWALLOWS CLICKS, which makes a
 * working control read as a broken feature (`.claude/rules/62`). Not a
 * verification blocker: staging has an enabled platform credential.
 */
async function dismissOnboardingIfPresent(page: Page) {
  const wizard = page.getByRole('dialog', { name: 'Account setup' });
  if (!(await wizard.isVisible({ timeout: 3_000 }).catch(() => false))) return;
  await page.getByRole('button', { name: 'Exit setup' }).click();
  await expect(wizard).toBeHidden({ timeout: 10_000 });
}

const INTERRUPT = { name: 'Interrupt agent' } as const;
const INTERRUPTING = { name: 'Interrupting agent' } as const;

async function shot(page: Page, name: string) {
  await page.waitForTimeout(800);
  await page.screenshot({
    path: `../../.codex/tmp/staging-screenshots/${name}.png`,
    fullPage: false,
  });
}

test.describe('Staging — interrupt then follow-up', () => {
  test('one press ends the turn, and the follow-up that follows is answered', async ({ page }) => {
    await login(page);

    // --- Reach a project and start a chat that will actually run an agent ---
    const projectsRes = await page.request.get(`${STAGING_API}/api/projects`);
    expect(projectsRes.status(), 'could not list projects').toBe(200);
    const projects = (await projectsRes.json()) as {
      projects?: Array<{ id: string; name: string }>;
    };
    const project = projects.projects?.[0];
    test.skip(!project, 'No staging project available');

    await page.goto(`${STAGING_APP}/projects/${project!.id}/chat`);
    await dismissOnboardingIfPresent(page);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);

    // The landing surface and the in-session surface use DIFFERENT placeholders
    // (`project-chat/index.tsx` vs `project-message-view/index.tsx`), so they are
    // matched separately rather than by one loose regex that silently misses one.
    const startComposer = page.getByPlaceholder(/describe what you want/i).first();
    const sessionComposer = page
      .getByPlaceholder(/send a message|agent is working|resume the agent|wake the agent/i)
      .first();

    // A prompt long enough that the agent is demonstrably still mid-turn when we
    // interrupt — the whole point is to catch it working, not idle.
    const LONG_PROMPT =
      'Count slowly from 1 to 400, one number per line, with a short sentence about each number.';

    await expect(startComposer.or(sessionComposer)).toBeVisible({ timeout: 60_000 });
    if (await startComposer.isVisible().catch(() => false)) {
      await startComposer.fill(LONG_PROMPT);
      await startComposer.press('Control+Enter');
    } else {
      await sessionComposer.fill(LONG_PROMPT);
      await sessionComposer.press('Control+Enter');
    }

    // --- Symptom A: interrupt ONCE against a genuinely working agent ---
    const interrupt = page.getByRole('button', INTERRUPT);
    await expect(interrupt, 'agent never entered the working state').toBeVisible({
      timeout: AGENT_START_TIMEOUT_MS,
    });
    await shot(page, 'staging-interrupt-working');

    await interrupt.click();

    // The in-flight state must be visible — the bug was that a press produced no
    // feedback at all and users pressed again.
    await expect(page.getByRole('button', INTERRUPTING)).toBeVisible({ timeout: 15_000 });
    await shot(page, 'staging-interrupt-cancelling');

    // ONE press must be enough. Pre-fix, a message flushing during the cancel's
    // VM round-trip voided the turn-end write and the dock flipped straight back
    // to working, which is what "needs multiple presses" was.
    await expect(
      page.getByRole('button', INTERRUPT),
      'the dock returned to the working state after a single interrupt'
    ).toBeHidden({ timeout: 90_000 });
    // No error surfaced by the interrupt itself.
    await expect(page.getByText('Failed to interrupt the agent')).toHaveCount(0);
    await shot(page, 'staging-interrupt-stopped');

    // --- Symptom B: the follow-up after the interrupt must be answered ---
    // By now we are inside the session, so the in-session composer is the one.
    await expect(sessionComposer).toBeVisible({ timeout: 60_000 });
    await sessionComposer.fill('Reply with exactly one word: acknowledged');
    await sessionComposer.press('Control+Enter');

    // The agent producing anything at all is the proof: pre-fix the delivery
    // parked in retry_wait behind a turn that had already ended, and the session
    // only recovered via sleep/wake.
    await expect(
      page.getByRole('button', INTERRUPT),
      'the follow-up after an interrupt never reached the agent'
    ).toBeVisible({ timeout: AGENT_START_TIMEOUT_MS });
    await shot(page, 'staging-followup-accepted');
  });
});
