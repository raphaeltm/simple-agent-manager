/**
 * Documentation screenshots for a new user's first run (Quickstart) and a new instance's
 * first setup (Installer guide): SAM's onboarding questions and steps, the setup welcome with
 * the token carried by the installer's link, and signing in with an emailed code.
 *
 * Drives the REAL dashboard onboarding, `/setup` and sign-in pages with mocked API data and
 * asserts on what rendered before capturing (`.claude/rules/62-tests-must-observe-the-real-
 * trigger.md`). The mocks follow `onboarding-inline-audit.spec.ts` and
 * `setup-wizard-audit.spec.ts`, which hold the stress cases; these fixtures are ordinary and
 * fictional on purpose. The wizard reads best at phone width, so every image is a phone capture.
 *
 * Write the committed images with:
 *   DOCS_SHOTS=1 npx playwright test docs-screenshots-first-run --project="iPhone SE (375x667)"
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, jsonResponse, makeMockUser } from './audit-helpers';
import { docsShot } from './docs-shot';

const OWNER_EMAIL = 'dana@example.com';

const MOCK_USER = makeMockUser({
  email: OWNER_EMAIL,
  name: 'Dana Reyes',
  sessionId: 'session-docs-first-run',
  userId: 'user-docs-first-run',
});

test.beforeEach(({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) > 500, 'phone captures only');
});

/**
 * A fresh account on an installation that offers Instant, its own machines and SAM-hosted
 * repositories, so every question shows all of its choices.
 */
async function setupOnboardingMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const p = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (p.includes('/api/auth/')) return jsonResponse(route, 200, MOCK_USER);
    if (p === '/api/dashboard/active-tasks') return jsonResponse(route, 200, { tasks: [] });
    if (p.startsWith('/api/notifications'))
      return jsonResponse(route, 200, { notifications: [], unreadCount: 0 });
    if (p === '/api/agents') return jsonResponse(route, 200, []);
    if (p === '/api/config/instant-runtime') return jsonResponse(route, 200, { enabled: true });
    if (p === '/api/config/artifacts-enabled') return jsonResponse(route, 200, { enabled: true });
    if (p === '/api/trial-status')
      return jsonResponse(route, 200, {
        available: false,
        agentType: null,
        hasInfraCredential: true,
        hasAgentCredential: false,
        dailyTokenBudget: 0,
        dailyTokenUsage: 0,
      });
    if (p === '/api/agent-credential-setup-sessions/config')
      return jsonResponse(route, 200, {
        enabled: true,
        agentTypes: ['openai-codex', 'claude-code'],
        scopes: ['user'],
      });
    if (p === '/api/credentials/agent' && method === 'GET')
      return jsonResponse(route, 200, { credentials: [] });
    if (p === '/api/credentials' && method === 'GET') return jsonResponse(route, 200, []);
    if (p === '/api/github/installations') return jsonResponse(route, 200, []);
    if (p === '/api/projects' && method === 'GET')
      return jsonResponse(route, 200, { projects: [] });
    if (p === '/api/projects' && method === 'POST')
      return jsonResponse(route, 201, { id: 'proj-receipts', name: 'receipts-app' });
    if (/^\/api\/projects\/[^/]+\/agent-profiles$/.test(p) && method === 'POST')
      return jsonResponse(route, 201, { id: 'profile-first' });
    if (p === '/api/credentials/agent/validate') return jsonResponse(route, 200, { valid: true });
    if (p === '/api/credentials/agent') return jsonResponse(route, 200, { id: 'agent-cred-1' });
    if (p.startsWith('/api/workspaces')) return jsonResponse(route, 200, []);
    return jsonResponse(route, 200, {});
  });
}

async function beginOnboarding(page: Page) {
  await setupOnboardingMocks(page);
  await page.goto('/dashboard?onboarding');
  const wizard = page.locator('[data-testid="onboarding-wizard"]');
  await expect(wizard).toBeVisible({ timeout: 5000 });
  await expect(wizard.getByRole('heading', { name: "Hi, I'm SAM." })).toBeVisible();
  return wizard;
}

/** The wizard scrolls inside its own overlay, so capture the viewport after it settles. */
async function shot(page: Page, name: string) {
  await assertNoOverflow(page);
  await page.waitForTimeout(600);
  await docsShot(page, name);
}

test('docs: onboarding from hello to the first chat', async ({ page }) => {
  const wizard = await beginOnboarding(page);
  await wizard.getByRole('button', { name: /Let's get you set up/ }).click();
  await expect(
    wizard.getByRole('heading', { name: 'Where should your agents work?' })
  ).toBeVisible();
  for (const label of [/Right here, on Cloudflare/, /installation's machines/, /my own cloud/])
    await expect(wizard.getByRole('button', { name: label })).toBeVisible();
  await shot(page, 'onboarding-where-agents-work-mobile');

  await wizard.getByRole('button', { name: /Right here, on Cloudflare/ }).click();
  await expect(wizard.getByRole('heading', { name: 'Where should your code live?' })).toBeVisible();

  await wizard.getByRole('button', { name: /Let SAM keep it/ }).click();
  await expect(wizard.getByRole('heading', { name: 'Who should do the coding?' })).toBeVisible();
  await wizard.getByRole('button', { name: /Claude Code/ }).click();
  await expect(wizard.getByRole('button', { name: 'Connect with Claude Code' })).toBeVisible();
  await shot(page, 'onboarding-agent-mobile');

  await wizard.getByRole('button', { name: 'API key' }).click();
  await page.locator('#onboarding-api-key').fill('sk-ant-docs-example');
  await wizard.getByRole('button', { name: /Use this agent/ }).click();
  await expect(wizard.getByRole('heading', { name: 'What are we building?' })).toBeVisible();
  await wizard.getByLabel('Project name').fill('receipts-app');
  await wizard.getByRole('button', { name: /Create project/ }).click();

  await expect(wizard.getByRole('heading', { name: "We're ready." })).toBeVisible();
  await expect(wizard.getByRole('button', { name: /Start your first chat/ })).toBeVisible();
});

/** A new instance whose email sending is ready, with no OAuth provider configured. */
async function setupSignInMocks(page: Page) {
  await page.routeWebSocket('**/api/notifications/ws', () => undefined);
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/get-session') return jsonResponse(route, 200, null);
    if (path === '/api/config/login-providers')
      return jsonResponse(route, 200, { github: false, google: false, gitlab: false, email: true });
    if (path === '/api/setup/status')
      return jsonResponse(route, 200, {
        completed: false,
        open: true,
        forced: false,
        tokenConfigured: true,
      });
    if (path === '/api/auth/email-otp/send-verification-otp')
      return jsonResponse(route, 200, { success: true });
    return jsonResponse(route, 200, {});
  });
}

test('docs: setup welcome with the token from the installer', async ({ page }) => {
  await setupSignInMocks(page);
  await page.goto('/setup#token=docs-setup-token');
  await expect(page.getByRole('heading', { name: 'Welcome to your SAM' })).toBeVisible();
  await expect(page.getByText('Setup token filled in from your installer')).toBeVisible();
  // The page names the instance by its own host; show the domain a real install would have.
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.textContent?.includes('localhost'))
        node.textContent = node.textContent.replace(/localhost(:\d+)?/g, 'sam.example.com');
    }
  });
  await expect(page.getByText('sam.example.com').first()).toBeVisible();
  await shot(page, 'setup-welcome-mobile');
});

test('docs: sign in with an emailed code', async ({ page }) => {
  await setupSignInMocks(page);
  await page.goto('/');
  const send = page.getByRole('button', { name: 'Email me a sign-in code' });
  await expect(send).toBeVisible();
  await page.getByLabel('Email').fill(OWNER_EMAIL);
  await send.click();
  await expect(page.getByLabel('Sign-in code')).toBeVisible();
  await expect(page.getByText(/can sign in here/)).toBeVisible();
  await shot(page, 'sign-in-email-code-mobile');
});
