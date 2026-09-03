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


/** The newest session in this project — the one the run just created. */
async function resolveSessionId(page: Page, projectId: string): Promise<string> {
  const res = await page.request.get(
    `${STAGING_API}/api/projects/${projectId}/sessions?limit=1`
  );
  expect(res.status(), 'could not list sessions').toBe(200);
  const body = (await res.json()) as { sessions?: Array<{ id: string }> };
  const id = body.sessions?.[0]?.id;
  expect(id, 'no session was created for the prompt').toBeTruthy();
  return id!;
}

/**
 * The session's server-maintained message counter.
 *
 * Deliberately NOT `messages.length` from the session-detail payload: that array
 * is a capped page, so on a long transcript the count plateaus at the cap and
 * stops rising even as new messages land — which reads exactly like "the agent
 * never answered". `messageCount` is monotonic and cannot silently saturate.
 */
/**
 * How many ASSISTANT messages exist. Used only as the pre-interrupt gate, while
 * the transcript is short enough that the detail payload's page cap cannot bite.
 *
 * Deliberately not the raw total: SAM injects its own `get_instructions` reminder
 * as an extra message, so a total of 2 is reachable with zero agent output — the
 * gate would pass before the agent had done anything.
 */
async function assistantMessageCount(
  page: Page,
  projectId: string,
  sessionId: string
): Promise<number> {
  const res = await page.request.get(
    `${STAGING_API}/api/projects/${projectId}/sessions/${sessionId}`
  );
  if (res.status() !== 200) return 0;
  const body = (await res.json()) as { messages?: Array<{ role: string }> };
  return (body.messages ?? []).filter((m) => m.role === 'assistant').length;
}

async function sessionMessageCount(
  page: Page,
  projectId: string,
  sessionId: string
): Promise<number> {
  const res = await page.request.get(
    `${STAGING_API}/api/projects/${projectId}/sessions/${sessionId}`
  );
  if (res.status() !== 200) return -1;
  const body = (await res.json()) as { session?: { messageCount?: number } };
  return body.session?.messageCount ?? -1;
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

    // --- Wait for the agent to be GENUINELY working ---
    // The dock shows Interrupt as soon as the prompt is sent, while the runtime
    // is still provisioning ("Provisioning VM / Waiting for task runner"). Pressing
    // it then proves nothing about the bug, which is specifically about a message
    // flushing DURING the cancel's round trip. Wait for real agent output first.
    const startupBanner = page.getByText(/Usually takes .* minutes|Waiting for task runner/i);
    await expect(startupBanner, 'runtime never finished starting').toBeHidden({
      timeout: AGENT_START_TIMEOUT_MS,
    });

    // Real agent output is the only proof the agent is mid-turn. Counted through
    // the API rather than by guessing at DOM structure: a hand-written selector
    // that matches nothing reports "no output" identically to a broken agent,
    // which is exactly how the first version of this spec passed while proving
    // nothing (.claude/rules/62).
    const sessionId = await resolveSessionId(page, project!.id);
    const messageCount = () => sessionMessageCount(page, project!.id, sessionId);

    await expect
      .poll(() => assistantMessageCount(page, project!.id, sessionId), {
        timeout: AGENT_START_TIMEOUT_MS,
        message: 'agent never produced output, so it was never genuinely mid-turn',
      })
      .toBeGreaterThan(0);

    // The dock's working morph lags real activity by
    // COMPLETION_DOCK_IDLE_STABILIZE_MS, so it can still show Interrupt for a
    // second after the agent has gone idle — clicking then would interrupt
    // nothing. The composer placeholder tracks `agentActivity` directly, so it is
    // the honest signal that a turn is genuinely in flight right now.
    await expect(
      page.getByPlaceholder(/agent is working/i),
      'the agent was not actually mid-turn at the moment of the interrupt'
    ).toBeVisible({ timeout: 60_000 });

    const interrupt = page.getByRole('button', INTERRUPT);
    await expect(interrupt, 'agent never entered the working state').toBeVisible({
      timeout: 60_000,
    });
    await shot(page, 'staging-interrupt-working');

    // --- Symptom A: ONE press must end the turn ---
    await interrupt.click();
    await expect(page.getByRole('button', INTERRUPTING)).toBeVisible({ timeout: 15_000 });
    await shot(page, 'staging-interrupt-cancelling');

    // The positive assertion matters here. Asserting only that "Interrupt agent"
    // disappears is satisfied by the CANCELLING state itself (that button is
    // relabelled "Interrupting agent"), so it would pass without the turn ever
    // ending. The dock's center action becoming Sleep is what actually proves the
    // session reached awake-idle — i.e. the turn-end write landed and fanned out.
    await expect(
      page.getByRole('button', { name: 'Sleep session' }),
      'the session never reached awake-idle after a single interrupt'
    ).toBeVisible({ timeout: 120_000 });
    await expect(page.getByRole('button', INTERRUPTING)).toBeHidden();
    await expect(page.getByText('Failed to interrupt the agent')).toHaveCount(0);
    await shot(page, 'staging-interrupt-stopped');

    // --- Symptom B: the follow-up after the interrupt must be answered ---
    await expect(sessionComposer).toBeVisible({ timeout: 60_000 });
    const countBefore = await messageCount();
    await sessionComposer.fill('Reply with exactly one word: acknowledged');
    await sessionComposer.press('Control+Enter');

    // Pre-fix this delivery parked in retry_wait behind a turn that had already
    // ended, and only sleep/wake recovered it. A NEW agent message is the proof
    // it was delivered rather than parked.
    await expect
      .poll(messageCount, {
        timeout: AGENT_START_TIMEOUT_MS,
        message: 'the follow-up sent after an interrupt was never answered',
      })
      // +1 would only prove the user's own message persisted. The agent's reply
      // is what proves the delivery was released rather than parked.
      .toBeGreaterThan(countBefore + 1);
    await shot(page, 'staging-followup-accepted');
  });
});
