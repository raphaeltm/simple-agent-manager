/**
 * Prepared bounded staging check; run once, desktop only, after deployment.
 * Inject SAM_PLAYWRIGHT_PRIMARY_USER through the existing secure runner.
 * Set SAM_RUN_VOICE_CHECK=1 and PLAYWRIGHT_BASE_URL=https://app.sammy.party.
 * Requires .codex/tmp/sam-voice-fixture/microphone.wav (synthetic speech).
 * Real getUserMedia -> MediaRecorder -> /api/transcribe -> reviewable draft.
 * No transcript mock, no turn submission, no project effects. Cleanup opts out.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, test } from '@playwright/test';

import { dismissStagingOnboarding, STAGING_API, STAGING_APP } from './staging-helpers';

const fixtureDirectory = resolve(import.meta.dirname, '../../../../.codex/tmp/sam-voice-fixture');
const audioPath = resolve(fixtureDirectory, 'microphone.wav');
const samApi = `${STAGING_API}/api/sam`;
const requestTimeoutMs = 10_000;
let authenticated = false;

test.describe.configure({ mode: 'serial', retries: 0 });
// No credentials, cookies, existing conversation, or project names in artifacts.
test.use({
  trace: 'off',
  video: 'off',
  screenshot: 'off',
  permissions: ['microphone'],
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${audioPath}%noloop`,
    ],
  },
});
// Main body plus separate cleanup budget remains below two minutes.
test.setTimeout(100_000);
test.afterEach(async ({ page }, testInfo) => {
  testInfo.setTimeout(15_000);
  if (!authenticated) return;
  const response = await page.request.patch(`${samApi}/settings`, {
    data: { enabled: false },
    timeout: requestTimeoutMs,
  });
  expect(response.status(), 'Account opt-out cleanup succeeds').toBe(200);
  expect((await response.json()).enabled, 'Account is OFF after voice check').toBe(false);
});

test('one real transcription populates a reviewable draft without sending', async ({
  page,
}, testInfo) => {
  authenticated = false;
  test.skip(
    process.env.SAM_RUN_VOICE_CHECK !== '1' || testInfo.project.name !== 'Desktop (1280x800)',
    'Explicit one-shot desktop staging voice check'
  );
  const token = process.env.SAM_PLAYWRIGHT_PRIMARY_USER;
  expect(Boolean(token), 'Dedicated staging token must be securely injected').toBe(true);
  expect(existsSync(audioPath), 'Synthetic microphone WAV must exist locally').toBe(true);
  const fixture = JSON.parse(readFileSync(resolve(fixtureDirectory, 'fixture.json'), 'utf8')) as {
    durationSeconds: number;
  };
  expect(fixture.durationSeconds).toBeGreaterThan(0);
  expect(fixture.durationSeconds).toBeLessThan(10);

  const login = await page.request.post(`${STAGING_API}/api/auth/token-login`, {
    data: { token },
    timeout: requestTimeoutMs,
  });
  expect(login.status(), 'Dedicated staging account login succeeds').toBe(200);
  authenticated = true;
  const initial = await page.request.get(`${samApi}/settings`, { timeout: requestTimeoutMs });
  expect(initial.status()).toBe(200);
  const settings = await initial.json();
  expect(settings.enabled, 'Dedicated account must start OFF').toBe(false);
  expect(settings.available, 'Installation must permit the voice journey').toBe(true);
  const enable = await page.request.patch(`${samApi}/settings`, {
    data: { enabled: true },
    timeout: requestTimeoutMs,
  });
  expect(enable.status()).toBe(200);

  const before = await page.request.get(`${samApi}/turns`, { timeout: requestTimeoutMs });
  expect(before.status()).toBe(200);
  const baseline = (await before.json()) as {
    turns: { id: string; state: string; actions: { id: string }[] }[];
  };
  expect(
    baseline.turns.some((turn) => ['accepted', 'running'].includes(turn.state)),
    'No overlapping operator turn may be active'
  ).toBe(false);
  const baselineIds = baseline.turns.map((turn) => turn.id);

  let transcriptions = 0;
  let blockedWrites = 0;
  let pageErrors = 0;
  let consoleErrors = 0;
  page.on('pageerror', () => {
    pageErrors += 1;
  });
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors += 1;
  });
  // Only unexpected writes are blocked. The one transcription reaches real staging unchanged.
  await page.route(`${STAGING_API}/api/**`, async (route) => {
    const request = route.request();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return route.continue();
    if (new URL(request.url()).pathname === '/api/transcribe' && request.method() === 'POST') {
      transcriptions += 1;
      if (transcriptions === 1) return route.continue();
    }
    blockedWrites += 1;
    return route.abort('blockedbyclient');
  });
  const browserSettings = page.waitForResponse(
    (response) => response.url() === `${samApi}/settings` && response.request().method() === 'GET',
    { timeout: 20_000 }
  );
  await page.goto(`${STAGING_APP}/sam`, { timeout: 20_000 });
  expect((await browserSettings).status(), 'Browser settings request succeeds').toBe(200);
  await dismissStagingOnboarding(page);
  const composer = page.getByLabel('Message SAM');
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(composer).toHaveValue('');
  await page.getByRole('button', { name: 'Voice input', exact: true }).click();
  const stop = page.getByRole('button', { name: 'Stop recording', exact: true });
  await expect(stop).toBeVisible({ timeout: 5_000 });
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  // Wait for the known single WAV, including leading/trailing silence, to finish.
  await page.waitForTimeout(Math.ceil(fixture.durationSeconds * 1000) + 500);
  const transcription = page.waitForResponse(
    (response) =>
      response.url() === `${STAGING_API}/api/transcribe` && response.request().method() === 'POST',
    { timeout: 35_000 }
  );
  await stop.click();
  const response = await transcription;
  expect(response.status(), 'Real staging transcription succeeds').toBe(200);
  expect(response.request().headers()['content-type']).toContain('multipart/form-data');
  const result = (await response.json()) as { text?: string };
  expect(typeof result.text).toBe('string');
  const transcript = result.text?.trim() ?? '';
  // Permit punctuation/capitalization differences while requiring recognizable speech.
  expect(transcript.toLowerCase()).toContain('voice');
  expect(transcript.toLowerCase()).toContain('draft');
  await expect(composer).toHaveValue(transcript);
  await expect(page.getByRole('button', { name: 'Voice input', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
  expect(transcriptions, 'Exactly one real transcription request').toBe(1);
  expect(blockedWrites, 'The UI must not attempt automatic send or another write').toBe(0);
  expect(pageErrors, 'No uncaught browser errors').toBe(0);
  expect(consoleErrors, 'No browser console errors').toBe(0);
  const after = await page.request.get(`${samApi}/turns`, { timeout: requestTimeoutMs });
  expect(after.status()).toBe(200);
  const finalHistory = (await after.json()) as typeof baseline;
  expect(finalHistory.turns.map((turn) => turn.id)).toEqual(baselineIds);
  expect(finalHistory.turns.flatMap((turn) => turn.actions.map((action) => action.id))).toEqual(
    baseline.turns.flatMap((turn) => turn.actions.map((action) => action.id))
  );
  // Clear the synthetic draft; never click Send.
  await composer.fill('');
  await expect(composer).toHaveValue('');
});
