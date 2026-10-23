/**
 * Staging verification for AI models agents can call (task 01M5JBHKNC833EZC0HQW1SNM16).
 *
 * Drives the real Project settings → Agents → AI Models section on app.sammy.party. It turns on
 * extra models in the picker, sets a monthly limit, checks both survive a reload and captures
 * desktop and mobile screenshots. `STAGING_AGENT_MODELS_MODE=usage` instead checks that the
 * calls a staging agent made show up under "Used this month", and `=skill` creates a skill whose
 * agents may call no models, through the skill form's own picker.
 *
 *   PLAYWRIGHT_BASE_URL=https://app.sammy.party SAM_PLAYWRIGHT_PRIMARY_USER=... \
 *     npx playwright test tests/playwright/staging-agent-models.spec.ts --project="Desktop (1280x800)"
 */
import { expect, type Page, test } from '@playwright/test';

import { assertNoClippedOverflow, assertNoOverflow } from './audit-helpers';
import {
  dismissStagingOnboarding,
  STAGING_APP,
  stagingLogin,
  stagingShot,
} from './staging-helpers';

// "Potato", an Artifacts-backed staging project owned by the smoke user.
const PROJECT_ID = process.env.STAGING_AGENT_MODELS_PROJECT_ID ?? '01KWHD8XS7MQ7R6KWXJYRHDVH4';
const MODE = process.env.STAGING_AGENT_MODELS_MODE ?? 'configure';
// Display names of the models to turn on, as the picker shows them.
const EXTRA_MODEL_NAMES = (
  process.env.STAGING_AGENT_MODELS_EXTRA ?? 'gpt-oss-20b,flux-1-schnell'
).split(',');
const BUDGET_USD = process.env.STAGING_AGENT_MODELS_BUDGET_USD ?? '1';
// Names expected under "Used this month" in usage mode.
const USED_MODEL_NAMES = (process.env.STAGING_AGENT_MODELS_USED ?? '').split(',').filter(Boolean);
// Skill mode: the skill to create, and the profile it defaults to (by name, as the form lists it).
const SKILL_NAME = process.env.STAGING_AGENT_MODELS_SKILL_NAME ?? 'AI models off (staging check)';
const SKILL_PROFILE_NAME = process.env.STAGING_AGENT_MODELS_SKILL_PROFILE ?? '';

async function openAiModels(page: Page): Promise<void> {
  await stagingLogin(page);
  await page.goto(`${STAGING_APP}/projects/${PROJECT_ID}/settings/agents`, {
    waitUntil: 'networkidle',
  });
  await dismissStagingOnboarding(page);
  await expect(page.getByRole('heading', { name: 'AI Models', exact: true })).toBeVisible({
    timeout: 20_000,
  });
  // The summary line renders once settings and the catalog have both loaded.
  await expect(page.getByText(/^(Recommended|Your selection) · /)).toBeVisible({ timeout: 20_000 });
  // Screenshots are viewport-sized, so bring the section itself into view.
  await page.getByRole('heading', { name: 'AI Models', exact: true }).scrollIntoViewIfNeeded();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  // Both checks: overflow inside an overflow-x-hidden shell never reaches the document (rule 56).
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
}

test.describe('AI Models settings on staging', () => {
  test.skip(MODE !== 'configure', 'configure mode only');

  test('turns on extra models and sets a monthly limit that survive a reload', async ({ page }) => {
    test.setTimeout(180_000);
    await openAiModels(page);
    // Setup, not assertions: if an earlier run left a selection or limit, reset both so this
    // run still has something to save. The checks below run unconditionally.
    const useRecommended = page.getByRole('button', { name: 'Use recommended', exact: true });
    if (await useRecommended.isVisible()) {
      await useRecommended.click();
      await expect(page.getByText(/^Recommended · /)).toBeVisible({ timeout: 15_000 });
    }
    const useDefault = page.getByRole('button', { name: /^Use default \(/ });
    if (await useDefault.isVisible()) {
      await useDefault.click();
      await expect(useDefault).toBeHidden({ timeout: 15_000 });
    }
    await stagingShot(page, 'agent-models-section-before');
    await expectNoHorizontalOverflow(page);

    await page.getByRole('button', { name: 'Choose models', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Choose AI models' });
    await expect(picker).toBeVisible();
    await stagingShot(page, 'agent-models-picker-open');

    const search = picker.getByRole('searchbox', { name: 'Search models' });
    for (const name of EXTRA_MODEL_NAMES) {
      await search.fill(name);
      const turnOn = picker.getByRole('switch', { name: `Turn on ${name}`, exact: true });
      const turnOff = picker.getByRole('switch', { name: `Turn off ${name}`, exact: true });
      await expect(turnOn.or(turnOff)).toBeVisible({ timeout: 10_000 });
      if (await turnOn.isVisible()) await turnOn.click();
      await expect(turnOff).toBeVisible();
    }
    await search.fill('');
    await stagingShot(page, 'agent-models-picker-edited');
    await picker.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(picker).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(/^Your selection · /)).toBeVisible();

    const limit = page.getByLabel('Monthly limit (USD)');
    await limit.fill(BUDGET_USD);
    const saveLimit = page
      .locator('section', { has: page.getByRole('heading', { name: 'AI Models', exact: true }) })
      .getByRole('button', { name: 'Save', exact: true });
    await saveLimit.click();
    await expect(page.getByRole('button', { name: /^Use default \(/ })).toBeVisible({
      timeout: 15_000,
    });

    // Both changes must come back from the server, not just from local state.
    await page.reload({ waitUntil: 'networkidle' });
    await dismissStagingOnboarding(page);
    await expect(page.getByText(/^Your selection · /)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByLabel('Monthly limit (USD)')).toHaveValue(BUDGET_USD);
    await page.getByRole('heading', { name: 'AI Models', exact: true }).scrollIntoViewIfNeeded();
    await stagingShot(page, 'agent-models-section-after');
  });

  test('section and picker fit a phone screen', async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 375, height: 667 });
    await openAiModels(page);
    await expectNoHorizontalOverflow(page);
    await stagingShot(page, 'agent-models-section-mobile');
    await page.getByRole('button', { name: 'Choose models', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Choose AI models' });
    await expect(picker).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await stagingShot(page, 'agent-models-picker-mobile');
    await picker.getByRole('button', { name: 'Close model picker' }).click();
    await expect(picker).toBeHidden();
  });
});

test.describe('AI Models usage on staging', () => {
  test.skip(MODE !== 'usage', 'usage mode only');

  test('shows the calls agents made this month', async ({ page }) => {
    test.setTimeout(120_000);
    await openAiModels(page);
    const used = page.locator('h3', { hasText: 'Used this month' }).locator('..');
    await expect(used.getByText('No model calls yet this month.')).toBeHidden();
    for (const name of USED_MODEL_NAMES) {
      await expect(used.getByText(name, { exact: true })).toBeVisible();
    }
    await stagingShot(page, 'agent-models-usage');
    await page.setViewportSize({ width: 375, height: 667 });
    await expectNoHorizontalOverflow(page);
    await page.locator('h3', { hasText: 'Used this month' }).scrollIntoViewIfNeeded();
    await stagingShot(page, 'agent-models-usage-mobile');
  });
});

test.describe('AI models off for one skill on staging', () => {
  test.skip(MODE !== 'skill', 'skill mode only');

  test('creates a skill whose agents can call no models', async ({ page }) => {
    test.setTimeout(180_000);
    await stagingLogin(page);
    await page.goto(`${STAGING_APP}/projects/${PROJECT_ID}/skills`, { waitUntil: 'networkidle' });
    await dismissStagingOnboarding(page);
    await page.getByRole('button', { name: 'New Skill' }).click();
    const form = page.getByRole('dialog').filter({ hasText: 'AI models this skill can call' });
    await expect(form).toBeVisible();
    await form.getByLabel('Name', { exact: true }).fill(SKILL_NAME);
    if (SKILL_PROFILE_NAME) {
      await form.getByLabel('Default Profile').selectOption({ label: SKILL_PROFILE_NAME });
    }

    await form.getByLabel('AI models this skill can call').selectOption('custom');
    const picker = page.getByRole('dialog', { name: 'Choose AI models' });
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: 'On only', exact: true }).click();
    const switchedOn = picker.getByRole('switch', { name: /^Turn off / });
    await expect(switchedOn.first()).toBeVisible({ timeout: 10_000 });
    while ((await switchedOn.count()) > 0) {
      await switchedOn.first().click();
    }
    await stagingShot(page, 'agent-models-skill-picker-none');
    await picker.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(picker).toBeHidden({ timeout: 10_000 });
    await expect(
      form.getByText("No models. Agents using this skill can't call any.")
    ).toBeVisible();
    await stagingShot(page, 'agent-models-skill-form-none');

    await form.getByRole('button', { name: 'Create Skill' }).click();
    await expect(form).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(SKILL_NAME, { exact: true })).toBeVisible();
  });
});
