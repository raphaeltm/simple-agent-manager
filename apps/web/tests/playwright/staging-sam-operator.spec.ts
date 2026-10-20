/**
 * Run only after the SAM operator has been deployed to staging:
 * PLAYWRIGHT_BASE_URL=https://app.sammy.party pnpm exec playwright test \
 *   tests/playwright/staging-sam-operator.spec.ts --project='Desktop (1280x800)' --workers=1
 *
 * Uses the existing dedicated primary/secondary token-login accounts. Performs at
 * most two read-only model turns; never dispatches project work. Both accounts
 * must start opted out, and both are opted out again in cleanup.
 */
import { expect, type Page, test } from '@playwright/test';

import { dismissStagingOnboarding, STAGING_API, STAGING_APP, stagingShot } from './staging-helpers';

const SAM_API = `${STAGING_API}/api/sam`;
const MODEL_TIMEOUT_MS = 150_000;
const REQUEST_TIMEOUT_MS = 20_000;

interface Turn {
  id: string;
  request_key: string;
  state: string;
  message: string;
  response: string | null;
  actions: unknown[];
}
interface History {
  conversationId: string | null;
  turns: Turn[];
}

test.describe.configure({ mode: 'serial' });
// Token-login bodies and session cookies must not enter trace/HAR artifacts.
test.use({ trace: 'off', video: 'off' });
test.setTimeout(300_000);

async function login(page: Page, token: string): Promise<void> {
  const response = await page.request.post(`${STAGING_API}/api/auth/token-login`, {
    data: { token },
    timeout: REQUEST_TIMEOUT_MS,
  });
  // Never include the auth response body or request data in assertion messages.
  expect(response.status(), 'Dedicated staging account token-login succeeds').toBe(200);
}

async function history(page: Page): Promise<History> {
  const response = await page.request.get(`${SAM_API}/turns`, { timeout: REQUEST_TIMEOUT_MS });
  expect(response.status()).toBe(200);
  return response.json();
}

async function setEnabled(page: Page, enabled: boolean): Promise<void> {
  const response = await page.request.patch(`${SAM_API}/settings`, {
    data: { enabled },
    timeout: REQUEST_TIMEOUT_MS,
  });
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ enabled, available: true });
}

async function expectDisabledApi(page: Page, key: string): Promise<void> {
  const responses = [
    await page.request.get(`${SAM_API}/turns`),
    await page.request.post(`${SAM_API}/turns`, {
      data: { requestKey: key, message: 'This opted-out request must never execute.' },
    }),
  ];
  for (const response of responses) {
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'sam_disabled',
      rejectedBeforeEffects: true,
    });
  }
}

test('SAM opt-in, private durable chat, cancellation, and stale-tab revocation', async ({
  browser,
  page,
}, testInfo) => {
  // One account-mutating execution even when the full multi-viewport suite is selected.
  test.skip(
    testInfo.project.name !== 'Desktop (1280x800)',
    'Serialized dedicated-account scenario'
  );
  const primaryToken = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  const secondaryToken = process.env.SAM_PLAYWRIGHT_SECONDARY_USER;
  expect(
    Boolean(primaryToken && secondaryToken),
    'Both dedicated staging token envs are required'
  ).toBe(true);
  expect(Boolean(primaryToken !== secondaryToken), 'Dedicated account tokens must differ').toBe(
    true
  );

  const secondaryContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const secondary = await secondaryContext.newPage();
  const authenticated: Page[] = [];
  const runId = crypto.randomUUID();
  const answer = `SAM_STAGING_${runId.replaceAll('-', '')}`;
  const message = `Reply with exactly ${answer}. This is a read-only staging check. Do not call tools, start project work, send messages, change data, or access project resources.`;

  try {
    await login(page, primaryToken!);
    authenticated.push(page);
    await login(secondary, secondaryToken!);
    authenticated.push(secondary);

    await test.step('Default-off settings, API, direct route, and navigation', async () => {
      for (const account of authenticated) {
        const response = await account.request.get(`${SAM_API}/settings`);
        expect(response.status()).toBe(200);
        expect(await response.json()).toEqual({ enabled: false, available: true });
        await expectDisabledApi(account, `disabled-${runId}`);
      }
      await page.goto(`${STAGING_APP}/sam`);
      await dismissStagingOnboarding(page);
      await expect(page.getByRole('link', { name: 'Open Settings', exact: true })).toBeVisible();
      await expect(page.getByLabel('Message SAM', { exact: true })).toHaveCount(0);
      await expect(page.getByRole('link', { name: 'SAM', exact: true })).toHaveCount(0);
      await stagingShot(page, 'sam-default-off');
    });

    await test.step('Enable in Settings and retain opt-in after refresh', async () => {
      await page.getByRole('link', { name: 'Open Settings', exact: true }).click();
      const toggle = page.getByRole('switch', { name: 'Enable SAM assistant' });
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await page.reload();
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByRole('link', { name: 'SAM', exact: true }).first()).toBeVisible();
      // A primary-account preference cannot opt in the secondary account.
      await expectDisabledApi(secondary, `secondary-disabled-${runId}`);
      await setEnabled(secondary, true);
      await page.goto(`${STAGING_APP}/sam`);
      await expect(page.getByLabel('Message SAM', { exact: true })).toBeVisible();
    });

    let acceptedId = '';
    let requestKey = '';
    await test.step('Send through UI, replay identical key, and reconnect to durable history', async () => {
      await page.getByLabel('Message SAM', { exact: true }).fill(message);
      const acceptedResponse = page.waitForResponse(
        (response) =>
          response.url() === `${SAM_API}/turns` && response.request().method() === 'POST'
      );
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      const accepted = await acceptedResponse;
      expect(accepted.status()).toBe(202);
      const receipt = await accepted.json();
      expect(receipt).toMatchObject({ accepted: true, replayed: false });
      acceptedId = receipt.turn.id;
      requestKey = accepted.request().postDataJSON().requestKey;
      expect(receipt.turn.request_key).toBe(requestKey);

      const replay = await page.request.post(`${SAM_API}/turns`, {
        data: { requestKey, message },
      });
      expect(replay.status()).toBe(200);
      expect(await replay.json()).toMatchObject({
        accepted: true,
        replayed: true,
        turn: { id: acceptedId, request_key: requestKey },
      });
      const mismatch = await page.request.post(`${SAM_API}/turns`, {
        data: { requestKey, message: `${message} Different content.` },
      });
      expect(mismatch.status()).toBe(409);
      expect(await mismatch.json()).toMatchObject({ rejectedBeforeEffects: true });

      // Destroy the current app tree, then reconnect using the real persisted API state.
      await page.goto('about:blank');
      await page.goto(`${STAGING_APP}/sam`);
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      await expect
        .poll(
          async () => {
            const turn = (await history(page)).turns.find((item) => item.id === acceptedId);
            return turn?.state;
          },
          { timeout: MODEL_TIMEOUT_MS, intervals: [1_000, 2_000, 5_000] }
        )
        .toBe('completed');
      const recorded = (await history(page)).turns.filter(
        (turn) => turn.request_key === requestKey
      );
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ id: acceptedId, response: answer, actions: [] });
      await expect(page.getByText(answer, { exact: true })).toBeVisible();
      await stagingShot(page, 'sam-durable-chat-desktop');
      await page.setViewportSize({ width: 375, height: 667 });
      await expect(page.getByLabel('Message SAM', { exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
      ).toBe(true);
      await stagingShot(page, 'sam-durable-chat-mobile');
      await page.setViewportSize({ width: 1280, height: 800 });
    });

    await test.step('Secondary account cannot read or cancel primary private work', async () => {
      const primaryHistory = await history(page);
      const secondaryHistory = await history(secondary);
      expect(secondaryHistory.conversationId).not.toBe(primaryHistory.conversationId);
      expect(JSON.stringify(secondaryHistory)).not.toContain(answer);
      expect(secondaryHistory.turns.some((turn) => turn.id === acceptedId)).toBe(false);
      const cancel = await secondary.request.post(`${SAM_API}/turns/${acceptedId}/cancel`, {
        data: {},
      });
      expect(cancel.status()).toBe(404);
      const foreignHistory = await secondary.request.get(
        `${SAM_API}/conversations/${primaryHistory.conversationId}/messages`
      );
      // Legacy history returns an empty page for an unknown ID in this user's DO.
      expect(foreignHistory.status()).toBe(200);
      expect(await foreignHistory.json()).toEqual({ messages: [], nextCursor: null });
      await secondary.goto(`${STAGING_APP}/sam`);
      await dismissStagingOnboarding(secondary);
      await expect(secondary.getByLabel('Message SAM', { exact: true })).toBeVisible();
      await expect(secondary.getByText(message, { exact: true })).toHaveCount(0);
      await stagingShot(secondary, 'sam-secondary-isolation');
    });

    await test.step('Cancel an accepted turn and preserve its receipt on replay', async () => {
      const input = {
        requestKey: `cancel-${runId}`,
        message:
          'Read-only cancellation check. Do not use tools, access project resources, or change anything. Reply with the word cancelled.',
      };
      const accepted = await page.request.post(`${SAM_API}/turns`, { data: input });
      expect(accepted.status()).toBe(202);
      const { turn } = await accepted.json();
      const cancelled = await page.request.post(`${SAM_API}/turns/${turn.id}/cancel`, { data: {} });
      expect(cancelled.status()).toBe(200);
      expect(await cancelled.json()).toMatchObject({ turn: { id: turn.id, state: 'cancelled' } });
      const replay = await page.request.post(`${SAM_API}/turns`, { data: input });
      expect(replay.status()).toBe(200);
      expect(await replay.json()).toMatchObject({
        replayed: true,
        turn: { id: turn.id, state: 'cancelled' },
      });
      await page.reload();
      await expect(page.getByText('SAM · cancelled', { exact: true })).toBeVisible();
      await stagingShot(page, 'sam-cancelled-turn');
    });

    await test.step('Disable in another tab and revoke the stale UI and API', async () => {
      const settingsTab = await page.context().newPage();
      try {
        await settingsTab.goto(`${STAGING_APP}/settings`);
        const toggle = settingsTab.getByRole('switch', { name: 'Enable SAM assistant' });
        await expect(toggle).toHaveAttribute('aria-checked', 'true');
        await toggle.click();
        await expect(toggle).toHaveAttribute('aria-checked', 'false');
        await expectDisabledApi(page, `after-disable-${runId}`);
        await page.bringToFront();
        await expect(page.getByRole('link', { name: 'Open Settings', exact: true })).toBeVisible();
        await expect(page.getByLabel('Message SAM', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'SAM', exact: true })).toHaveCount(0);
        await stagingShot(page, 'sam-disabled-stale-tab');
        // Disabling primary must not alter the secondary preference either.
        const secondarySettings = await secondary.request.get(`${SAM_API}/settings`);
        expect(await secondarySettings.json()).toMatchObject({ enabled: true });
      } finally {
        await settingsTab.close();
      }
    });
  } finally {
    // Attempt both cleanups even if either fails; never leave an account enabled
    // because the other account's cleanup request was rejected.
    const cleanups = await Promise.allSettled(
      authenticated.map((account) => setEnabled(account, false))
    );
    await secondaryContext.close();
    expect(
      cleanups.every((result) => result.status === 'fulfilled'),
      'Both authenticated accounts are opted out in cleanup'
    ).toBe(true);
  }
});
