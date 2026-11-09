/**
 * Visual + interaction audit for the inline, multi-agent onboarding wizard.
 *
 * Regression target: onboarding steps used to advance without collecting any
 * input (the OAuth step showed no field at all) and the copy was Claude-locked.
 * This audit drives every inline form — agent selection with per-agent auth
 * methods, OAuth-token widgets, the SAM budget inputs, and the Hetzner/Scaleway
 * cloud toggle — at both mobile (375px) and desktop (1280px), asserting no
 * horizontal overflow after each interaction.
 *
 * Each step is reached as the FIRST executable step by pre-populating
 * `existing-*` tags via mocked credential/installation responses, which mark the
 * other steps optional so they are filtered out of the executable list.
 *
 * Run with:
 *   npx playwright test onboarding-inline-audit \
 *     --project="iPhone SE (375x667)" --project="Desktop (1280x800)"
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, jsonResponse, makeMockUser, screenshot } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'demo@example.com',
  name: 'Demo User',
  role: 'superadmin',
  sessionId: 'session-demo-1',
  userId: 'user-demo-1',
});

const INSTALLATION = {
  id: 'inst-1',
  userId: 'user-demo-1',
  installationId: '100',
  accountType: 'organization',
  accountName: 'serverspresentation2025',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const REPOSITORY = {
  id: 123,
  fullName: 'serverspresentation2025/VoyajApp',
  name: 'VoyajApp',
  private: true,
  defaultBranch: 'main',
  installationId: 'inst-1',
};

interface ExistingState {
  existingAgent: boolean;
  existingCloud: boolean;
  existingGithub: boolean;
  /** Whether this installation can host repositories on Cloudflare Artifacts. */
  artifactsEnabled?: boolean;
  /** Whether SAM can run the provider sign-in for Claude Code and Codex. */
  guidedSignIn?: boolean;
}

interface Recorded {
  projectCreates: unknown[];
}

/**
 * Route every API call. The `existing-*` flags steer the pre-population effect
 * in ChoosePathWizard so we can land the wizard on a chosen step as the first
 * executable step.
 */
async function setupMocks(page: Page, state: ExistingState): Promise<Recorded> {
  const recorded: Recorded = { projectCreates: [] };
  await page.route('**/api/**', async (route: Route) => {
    const p = new URL(route.request().url()).pathname;
    const isGet = route.request().method() === 'GET';
    const isPost = route.request().method() === 'POST';

    if (p.includes('/api/auth/')) return jsonResponse(route, 200, MOCK_USER);
    if (p === '/api/dashboard/active-tasks') return jsonResponse(route, 200, { tasks: [] });
    if (p.startsWith('/api/notifications'))
      return jsonResponse(route, 200, { notifications: [], unreadCount: 0 });
    if (p === '/api/agents') return jsonResponse(route, 200, []);

    // Pre-population endpoints — drive existing-agent / existing-cloud / existing-github.
    if (p === '/api/credentials/agent' && isGet)
      return jsonResponse(route, 200, {
        credentials: state.existingAgent ? [{ id: 'agent-cred-1', isActive: true }] : [],
      });
    if (p === '/api/credentials' && isGet)
      return jsonResponse(
        route,
        200,
        state.existingCloud ? [{ id: 'cred-1', provider: 'hetzner' }] : []
      );
    if (p === '/api/github/installations')
      return jsonResponse(route, 200, state.existingGithub ? [INSTALLATION] : []);

    // Inline persistence endpoints — accept everything the forms submit.
    if (p === '/api/credentials/agent/validate') return jsonResponse(route, 200, { valid: true });
    if (p === '/api/credentials/agent') return jsonResponse(route, 200, { id: 'agent-cred-2' });
    if (p.startsWith('/api/agent-settings/')) return jsonResponse(route, 200, { ok: true });
    if (p === '/api/usage/ai/budget') return jsonResponse(route, 200, { ok: true });
    if (p === '/api/credentials/validate') return jsonResponse(route, 200, { valid: true });
    if (p === '/api/credentials' && isPost) return jsonResponse(route, 201, { id: 'cred-2' });

    if (p === '/api/config/artifacts-enabled')
      return jsonResponse(route, 200, { enabled: state.artifactsEnabled === true });
    if (p === '/api/agent-credential-setup-sessions/config')
      return jsonResponse(
        route,
        200,
        state.guidedSignIn
          ? { enabled: true, agentTypes: ['openai-codex', 'claude-code'], scopes: ['user'] }
          : { enabled: false }
      );
    if (p === '/api/projects' && isPost) {
      recorded.projectCreates.push(route.request().postDataJSON());
      return jsonResponse(route, 201, { id: 'project-1', name: 'created' });
    }

    if (p === '/api/github/repositories')
      return jsonResponse(route, 200, { repositories: [REPOSITORY] });
    if (p === '/api/projects' && isGet) return jsonResponse(route, 200, { projects: [] });

    if (p === '/api/trial-status' || p === '/api/trial/status')
      return jsonResponse(route, 200, { available: false });
    if (p.startsWith('/api/workspaces')) return jsonResponse(route, 200, []);

    return jsonResponse(route, 200, {});
  });
  return recorded;
}

type CloudAnswer = 'byoc' | 'sam';
type RepoAnswer = 'github' | 'sam-hosted';

/**
 * Walk the two-question tree and start execution. Pre-pop tags determine which
 * step renders first.
 */
async function reachExecution(page: Page, cloud: CloudAnswer, repo: RepoAnswer = 'github') {
  await page.goto('/dashboard?onboarding');

  const wizard = page.locator('[data-testid="onboarding-wizard"]');
  await expect(wizard).toBeVisible({ timeout: 5000 });

  // Let the async pre-population effect resolve before answering.
  await page.waitForTimeout(300);

  if (cloud === 'byoc') {
    await wizard.getByRole('button', { name: 'I have Hetzner or Scaleway' }).click();
  } else {
    await wizard.getByRole('button', { name: 'Use SAM-managed infrastructure' }).click();
  }
  await wizard
    .getByRole('button', { name: repo === 'github' ? /GitHub — I have a repo/ : /Let SAM host it/ })
    .click();
  await wizard.getByRole('button', { name: /Start setup/ }).click();

  return wizard;
}

/* ─── Scenario A: AI setup step (agent selection + auth methods) ─── */

test('ai-setup inline form: agent grid, api-key, OAuth, and SAM budget', async ({ page }) => {
  await setupMocks(page, { existingAgent: false, existingCloud: true, existingGithub: true });
  const wizard = await reachExecution(page, 'byoc');

  // Lands on ai-setup (cloud + github pre-satisfied → optional → filtered out).
  await expect(
    wizard.getByRole('heading', { name: /set up your.*agent|coding agent|ai/i }).first()
  ).toBeVisible({ timeout: 5000 });

  // All six catalog agents are selectable.
  await expect(wizard.getByRole('button', { name: /Claude Code/ })).toBeVisible();
  await expect(wizard.getByRole('button', { name: /OpenAI Codex/ })).toBeVisible();
  await expect(wizard.getByRole('button', { name: /Gemini CLI/ })).toBeVisible();
  await expect(wizard.getByRole('button', { name: /Mistral Vibe/ })).toBeVisible();
  await expect(wizard.getByRole('button', { name: /OpenCode/ })).toBeVisible();
  await expect(wizard.getByRole('button', { name: /Amp/ })).toBeVisible();

  await assertNoOverflow(page);
  await screenshot(page, 'onboarding-inline-ai-agent-grid');

  // Claude Code opens on its subscription (the quick path). Without guided sign-in on this
  // installation the paste field is the only control. Screenshot the empty field BEFORE
  // filling so no secret value (even a test value) is ever captured to disk.
  await wizard.getByRole('button', { name: /Claude Code/ }).click();
  await expect(page.locator('#onboarding-oauth-token')).toBeVisible();
  await expect(wizard.getByRole('button', { name: 'Connect with Claude Code' })).toHaveCount(0);
  await assertNoOverflow(page);
  await screenshot(page, 'onboarding-inline-ai-oauth-claude');
  await page.locator('#onboarding-oauth-token').fill('claude-oauth-token');

  // API key stays one click away.
  await wizard.getByRole('button', { name: 'API key' }).click();
  await expect(page.locator('#onboarding-api-key')).toBeVisible();
  await assertNoOverflow(page);
  await screenshot(page, 'onboarding-inline-ai-apikey');
  await page.locator('#onboarding-api-key').fill('sk-test-key');

  // OpenAI Codex → ChatGPT subscription → auth.json textarea.
  await wizard.getByRole('button', { name: /OpenAI Codex/ }).click();
  await expect(wizard.getByRole('button', { name: 'ChatGPT subscription' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(page.locator('textarea#onboarding-oauth-token')).toBeVisible();
  await assertNoOverflow(page);
  await screenshot(page, 'onboarding-inline-ai-oauth-codex');
  await page.locator('#onboarding-oauth-token').fill('{"OPENAI_API_KEY":"x"}');

  // SAM-managed AI → inline budget inputs.
  await wizard.getByRole('button', { name: 'SAM-managed AI' }).click();
  await expect(page.locator('#onboarding-daily-input')).toBeVisible();
  await expect(page.locator('#onboarding-daily-output')).toBeVisible();
  await expect(page.locator('#onboarding-monthly-cap')).toBeVisible();
  await page.locator('#onboarding-daily-input').fill('100000');
  await page.locator('#onboarding-daily-output').fill('50000');
  await page.locator('#onboarding-monthly-cap').fill('25');
  await assertNoOverflow(page);
  await screenshot(page, 'onboarding-inline-ai-sam-budget');
});

/* ─── Scenario B: Cloud BYOC step (Hetzner / Scaleway toggle) ─── */

test('cloud-byoc inline form: Hetzner and Scaleway provider toggle', async ({ page }) => {
  await setupMocks(page, { existingAgent: true, existingCloud: false, existingGithub: true });
  const wizard = await reachExecution(page, 'byoc');

  // Hetzner is the default provider. Screenshot the empty field BEFORE filling
  // so no credential value is ever captured to disk.
  await expect(page.locator('#onboarding-hetzner-token')).toBeVisible({ timeout: 5000 });
  await assertNoOverflow(page);
  await screenshot(page, 'onboarding-inline-cloud-hetzner');
  await page.locator('#onboarding-hetzner-token').fill('hetzner-token-xyz');

  // Switch to Scaleway → secret key + project ID.
  await wizard.getByRole('button', { name: 'scaleway' }).click();
  await expect(page.locator('#onboarding-scaleway-secret')).toBeVisible();
  await expect(page.locator('#onboarding-scaleway-project')).toBeVisible();
  await assertNoOverflow(page);
  await screenshot(page, 'onboarding-inline-cloud-scaleway');
  await page.locator('#onboarding-scaleway-secret').fill('scw-secret');
  await page.locator('#onboarding-scaleway-project').fill('proj-1234');
});

/* ─── Scenario C: Cloud SAM-managed step (confirmation) ─── */

test('cloud-sam inline form: SAM-managed infrastructure confirmation', async ({ page }) => {
  await setupMocks(page, { existingAgent: true, existingCloud: false, existingGithub: true });
  const wizard = await reachExecution(page, 'sam');

  await expect(wizard.getByRole('button', { name: /Continue/ })).toBeVisible({ timeout: 5000 });
  await assertNoOverflow(page);
  await screenshot(page, 'onboarding-inline-cloud-sam');
});

/* ─── Scenario D: guided subscription sign-in (no pasting) ─── */

for (const [agent, button, slug] of [
  ['Claude Code', 'Connect with Claude Code', 'claude'],
  ['OpenAI Codex', 'Connect with Codex', 'codex'],
] as const) {
  test(`ai-setup offers guided ${agent} sign-in before the paste fallback`, async ({ page }) => {
    await setupMocks(page, {
      existingAgent: false,
      existingCloud: true,
      existingGithub: true,
      guidedSignIn: true,
    });
    const wizard = await reachExecution(page, 'byoc');
    await wizard.getByRole('button', { name: new RegExp(agent) }).click();

    const connect = wizard.getByRole('button', { name: button });
    await expect(connect).toBeVisible({ timeout: 5000 });
    const paste = page.locator('#onboarding-oauth-token');
    await expect(wizard.getByText(/^Or paste/)).toBeVisible();
    // The quick path sits above the manual one.
    const [connectBox, pasteBox] = [await connect.boundingBox(), await paste.boundingBox()];
    expect(connectBox!.y + connectBox!.height).toBeLessThanOrEqual(pasteBox!.y);
    await connect.scrollIntoViewIfNeeded();
    await assertNoOverflow(page);
    await screenshot(page, `onboarding-inline-ai-guided-${slug}`);
  });
}

/* ─── Scenario E: where the code lives ─── */

test('repository question offers SAM hosting only where Artifacts is enabled', async ({ page }) => {
  for (const enabled of [true, false]) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await setupMocks(page, {
      existingAgent: false,
      existingCloud: false,
      existingGithub: false,
      artifactsEnabled: enabled,
    });
    await page.goto('/dashboard?onboarding');
    const wizard = page.locator('[data-testid="onboarding-wizard"]');
    await expect(wizard).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(300);
    await wizard.getByRole('button', { name: 'Use SAM-managed infrastructure' }).click();
    await expect(
      wizard.getByRole('heading', { name: 'Where should your code live?' })
    ).toBeVisible();
    await expect(wizard.getByRole('button', { name: /GitHub — I have a repo/ })).toBeVisible();
    await expect(wizard.getByRole('button', { name: /Let SAM host it/ })).toHaveCount(
      enabled ? 1 : 0
    );
    await assertNoOverflow(page);
    await screenshot(page, `onboarding-repo-source-artifacts-${enabled ? 'on' : 'off'}`);
  }
});

test('SAM-hosted path skips GitHub and creates an Artifacts project from a name', async ({
  page,
}) => {
  const recorded = await setupMocks(page, {
    existingAgent: true,
    existingCloud: true,
    existingGithub: false,
    artifactsEnabled: true,
  });
  const wizard = await reachExecution(page, 'sam', 'sam-hosted');

  await expect(wizard.getByText(/No GitHub needed/)).toBeVisible({ timeout: 5000 });
  await expect(wizard.getByText(/GitHub App/)).toHaveCount(0);
  const name =
    'a-very-long-project-name-that-keeps-going-to-check-wrapping-on-small-screens-1234567890';
  await wizard.getByLabel('Project name').fill(name);
  await assertNoOverflow(page);
  await screenshot(page, 'onboarding-sam-hosted-project');
  await wizard.getByRole('button', { name: /Create Project/ }).click();

  await expect.poll(() => recorded.projectCreates.length).toBe(1);
  expect(recorded.projectCreates[0]).toEqual({
    name,
    repoProvider: 'artifacts',
    defaultBranch: 'main',
  });
});
