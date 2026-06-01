/**
 * PROTOTYPE ONLY — DO NOT SHIP TO PRODUCTION
 *
 * Playwright visual audit for the three onboarding prototypes.
 * Captures screenshots at both mobile and desktop viewports,
 * walking through the key states of each prototype.
 */
import { test, expect, type Page } from '@playwright/test';

const BASE = 'http://localhost:5173';
const SCREENSHOT_DIR = '../../.codex/tmp/playwright-screenshots';

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(800);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}.png`,
    fullPage: true,
  });
}

async function checkNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(overflow).toBe(false);
}

// ─── PROTOTYPE 1: Zero-to-Hero ───

test.describe('Zero-to-Hero — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('walkthrough all steps', async ({ page }) => {
    await page.goto(`${BASE}/prototype/onboarding-zero-to-hero`);
    await screenshot(page, 'zero-to-hero-01-welcome-mobile');
    await checkNoOverflow(page);

    // Step 2: Concept
    await page.click('button:has-text("get started")');
    await screenshot(page, 'zero-to-hero-02-concept-mobile');
    await checkNoOverflow(page);

    // Step 3: Choose agent
    await page.click('button:has-text("Got it")');
    await screenshot(page, 'zero-to-hero-03-agent-mobile');

    // Select Claude Code
    await page.click('button:has-text("Claude Code")');
    await screenshot(page, 'zero-to-hero-03b-agent-selected-mobile');

    // Step 4: Billing
    await page.click('button:has-text("Next: How you pay")');
    await screenshot(page, 'zero-to-hero-04-billing-mobile');

    // Select OAuth option
    await page.click('button:has-text("Use my Claude Pro")');
    await screenshot(page, 'zero-to-hero-04b-billing-oauth-mobile');

    // Select SAM credits
    await page.click('button:has-text("Use SAM credits")');
    await screenshot(page, 'zero-to-hero-04c-billing-sam-mobile');
    await checkNoOverflow(page);

    // Step 5: Cloud
    await page.click('button:has-text("Next: Where code runs")');
    await screenshot(page, 'zero-to-hero-05-cloud-mobile');

    // Select SAM-managed
    await page.click('button:has-text("Use SAM-managed")');
    await screenshot(page, 'zero-to-hero-05b-cloud-sam-mobile');

    // Step 6: GitHub
    await page.click('button:has-text("Next: Connect GitHub")');
    await screenshot(page, 'zero-to-hero-06-github-mobile');

    // Connect GitHub
    await page.click('button:has-text("Install SAM GitHub App")');
    await screenshot(page, 'zero-to-hero-06b-github-connected-mobile');
    await checkNoOverflow(page);

    // Step 7: First task
    await page.click('button:has-text("Next: Your first task")');
    await screenshot(page, 'zero-to-hero-07-first-task-mobile');

    // Click a suggestion
    await page.click('button:has-text("Add a dark mode")');
    await screenshot(page, 'zero-to-hero-07b-task-filled-mobile');

    // Submit
    await page.click('button:has-text("Start task")');
    await page.waitForTimeout(6000);
    await screenshot(page, 'zero-to-hero-07c-task-running-mobile');
    await checkNoOverflow(page);
  });
});

test.describe('Zero-to-Hero — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('walkthrough key steps', async ({ page }) => {
    await page.goto(`${BASE}/prototype/onboarding-zero-to-hero`);
    await screenshot(page, 'zero-to-hero-01-welcome-desktop');

    await page.click('button:has-text("get started")');
    await screenshot(page, 'zero-to-hero-02-concept-desktop');

    await page.click('button:has-text("Got it")');
    await page.click('button:has-text("Claude Code")');
    await screenshot(page, 'zero-to-hero-03-agent-desktop');

    await page.click('button:has-text("Next: How you pay")');
    await page.click('button:has-text("Use my API key")');
    await screenshot(page, 'zero-to-hero-04-billing-apikey-desktop');

    await page.click('button:has-text("Next: Where code runs")');
    await page.click('button:has-text("Bring my own")');
    await screenshot(page, 'zero-to-hero-05-cloud-byoc-desktop');

    await page.click('button:has-text("Next: Connect GitHub")');
    await page.click('button:has-text("Install SAM GitHub App")');
    await screenshot(page, 'zero-to-hero-06-github-desktop');

    await page.click('button:has-text("Next: Your first task")');
    await page.click('button:has-text("Write unit tests")');
    await page.click('button:has-text("Start task")');
    await page.waitForTimeout(6000);
    await screenshot(page, 'zero-to-hero-07-task-running-desktop');
    await checkNoOverflow(page);
  });
});

// ─── PROTOTYPE 2: Instant Start ───

test.describe('Instant Start — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('full flow from repo pick to agent working', async ({ page }) => {
    await page.goto(`${BASE}/prototype/onboarding-instant-start`);
    await screenshot(page, 'instant-start-01-pick-repo-mobile');
    await checkNoOverflow(page);

    // Pick a template
    await page.click('button:has-text("Next.js Starter")');
    await screenshot(page, 'instant-start-02-pick-task-mobile');

    // Type a task
    await page.click('button:has-text("Add a dark mode toggle")');
    await page.click('button:has-text("Start building")');
    await screenshot(page, 'instant-start-03-provisioning-mobile');

    // Wait for provisioning to complete
    await page.waitForTimeout(8000);
    await screenshot(page, 'instant-start-04-agent-working-mobile');

    // Wait for messages to appear
    await page.waitForTimeout(12000);
    await screenshot(page, 'instant-start-04b-agent-chat-mobile');
    await checkNoOverflow(page);

    // Click setup
    const setupBtn = page.locator('button:has-text("Set up my account")');
    if (await setupBtn.isVisible()) {
      await setupBtn.click();
      await screenshot(page, 'instant-start-05-setup-reveal-mobile');
      await checkNoOverflow(page);
    }
  });
});

test.describe('Instant Start — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('key states', async ({ page }) => {
    await page.goto(`${BASE}/prototype/onboarding-instant-start`);
    await screenshot(page, 'instant-start-01-pick-repo-desktop');

    await page.click('button:has-text("Express API")');
    await screenshot(page, 'instant-start-02-pick-task-desktop');

    await page.click('button:has-text("Fix the form validation")');
    await page.click('button:has-text("Start building")');
    await page.waitForTimeout(8000);
    await screenshot(page, 'instant-start-04-agent-working-desktop');

    await page.waitForTimeout(12000);
    await screenshot(page, 'instant-start-04b-agent-chat-desktop');
    await checkNoOverflow(page);
  });
});

// ─── PROTOTYPE 3: Choose Your Path ───

test.describe('Choose Path — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('answer questions and see generated path', async ({ page }) => {
    await page.goto(`${BASE}/prototype/onboarding-choose-path`);
    await screenshot(page, 'choose-path-01-experience-mobile');
    await checkNoOverflow(page);

    // Answer: Some experience
    await page.click('button:has-text("Some experience")');
    await screenshot(page, 'choose-path-02-ai-subscription-mobile');

    // Answer: Claude Pro
    await page.click('button:has-text("Claude Pro or Max")');
    await screenshot(page, 'choose-path-03-cloud-account-mobile');

    // Answer: No cloud
    await page.click('button:has-text("don\'t have a cloud account")');
    await screenshot(page, 'choose-path-04-github-ready-mobile');

    // Answer: Have a repo
    await page.click('button:has-text("Yes, I have a repo")');
    await screenshot(page, 'choose-path-05-path-preview-mobile');
    await checkNoOverflow(page);

    // Start setup
    await page.click('button:has-text("Start setup")');
    await screenshot(page, 'choose-path-06-executing-mobile');

    // Click through steps
    await page.click('button:has-text("Connect Claude Account")');
    await page.waitForTimeout(2000);
    await screenshot(page, 'choose-path-06b-step2-mobile');

    await page.click('button:has-text("Continue")');
    await page.waitForTimeout(2000);
    await screenshot(page, 'choose-path-06c-step3-mobile');
    await checkNoOverflow(page);
  });
});

test.describe('Choose Path — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('beginner path with SAM billing', async ({ page }) => {
    await page.goto(`${BASE}/prototype/onboarding-choose-path`);
    await screenshot(page, 'choose-path-01-experience-desktop');

    // Brand new user
    await page.click('button:has-text("Brand new")');
    await screenshot(page, 'choose-path-02-ai-subscription-desktop');

    // No AI subscription
    await page.click('button:has-text("don\'t have anything")');
    await screenshot(page, 'choose-path-03-cloud-account-desktop');

    // No cloud
    await page.click('button:has-text("don\'t have a cloud account")');
    await screenshot(page, 'choose-path-04-github-ready-desktop');

    // Use template
    await page.click('button:has-text("use a template")');
    await screenshot(page, 'choose-path-05-path-preview-desktop');
    await checkNoOverflow(page);
  });
});
