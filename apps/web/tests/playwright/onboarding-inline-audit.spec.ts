/**
 * Visual and interaction audit for first-run onboarding (ChoosePathWizard).
 *
 * Drives the real flow from the dashboard: SAM's hello, only the questions this
 * installation leaves open, the remaining steps, and the hand-off to the first chat. Each
 * scenario sets what the installation offers (Instant, the installation's own machines,
 * Cloudflare Artifacts, guided sign-in, SAM-managed AI) through the mocked config endpoints,
 * so the decision tree is exercised the way production reaches it.
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
  fullName: 'serverspresentation2025/a-repository-with-a-really-long-name-for-wrapping-checks',
  name: 'a-repository-with-a-really-long-name-for-wrapping-checks',
  private: true,
  defaultBranch: 'main',
  installationId: 'inst-1',
};

interface Installation {
  instant?: boolean;
  platformCompute?: boolean;
  artifacts?: boolean;
  guidedSignIn?: boolean;
  samAi?: boolean;
  hasAgent?: boolean;
  hasCloud?: boolean;
  hasGitHub?: boolean;
  /** Public capabilities: false without Cloudflare AI Gateway (no monthly AI cap). */
  monthlyCostCap?: boolean;
}

interface Recorded {
  projects: unknown[];
  profiles: { projectId: string; body: unknown }[];
}

async function setupMocks(page: Page, state: Installation): Promise<Recorded> {
  const recorded: Recorded = { projects: [], profiles: [] };
  await page.route('**/api/**', async (route: Route) => {
    const p = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const isGet = method === 'GET';

    if (p.includes('/api/auth/')) return jsonResponse(route, 200, MOCK_USER);
    if (p === '/api/dashboard/active-tasks') return jsonResponse(route, 200, { tasks: [] });
    if (p.startsWith('/api/notifications'))
      return jsonResponse(route, 200, { notifications: [], unreadCount: 0 });
    if (p === '/api/agents') return jsonResponse(route, 200, []);

    // What the installation offers.
    if (p === '/api/config/platform-capabilities')
      return jsonResponse(route, 200, {
        speechToText: true,
        textToSpeech: true,
        monthlyCostCap: state.monthlyCostCap !== false,
      });
    if (p === '/api/config/instant-runtime')
      return jsonResponse(route, 200, { enabled: state.instant === true });
    if (p === '/api/config/artifacts-enabled')
      return jsonResponse(route, 200, { enabled: state.artifacts === true });
    if (p === '/api/trial-status')
      return jsonResponse(route, 200, {
        available: false,
        agentType: null,
        hasInfraCredential: state.platformCompute === true,
        hasAgentCredential: state.samAi === true,
        dailyTokenBudget: 0,
        dailyTokenUsage: 0,
      });
    if (p === '/api/agent-credential-setup-sessions/config')
      return jsonResponse(
        route,
        200,
        state.guidedSignIn
          ? { enabled: true, agentTypes: ['openai-codex', 'claude-code'], scopes: ['user'] }
          : { enabled: false }
      );

    // What the user already has.
    if (p === '/api/credentials/agent' && isGet)
      return jsonResponse(route, 200, {
        credentials: state.hasAgent ? [{ agentType: 'claude-code', isActive: true }] : [],
      });
    if (p === '/api/credentials' && isGet)
      return jsonResponse(
        route,
        200,
        state.hasCloud ? [{ id: 'cred-1', provider: 'hetzner', connected: true }] : []
      );
    if (p === '/api/github/installations')
      return jsonResponse(route, 200, state.hasGitHub ? [INSTALLATION] : []);
    if (p === '/api/github/repositories')
      return jsonResponse(route, 200, { repositories: [REPOSITORY] });
    if (p === '/api/projects' && isGet) return jsonResponse(route, 200, { projects: [] });

    // Writes.
    if (p === '/api/projects' && method === 'POST') {
      recorded.projects.push(route.request().postDataJSON());
      return jsonResponse(route, 201, { id: 'project-1', name: 'created' });
    }
    const profile = p.match(/^\/api\/projects\/([^/]+)\/agent-profiles$/);
    if (profile && method === 'POST') {
      recorded.profiles.push({ projectId: profile[1] ?? '', body: route.request().postDataJSON() });
      return jsonResponse(route, 201, { id: 'profile-1' });
    }
    if (p === '/api/credentials/agent/validate') return jsonResponse(route, 200, { valid: true });
    if (p === '/api/credentials/agent') return jsonResponse(route, 200, { id: 'agent-cred-2' });
    if (p.startsWith('/api/workspaces')) return jsonResponse(route, 200, []);

    return jsonResponse(route, 200, {});
  });
  return recorded;
}

/** The wizard scrolls inside its own overlay, which a full-page capture cannot see. */
async function viewportScreenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  const viewport = page.viewportSize();
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}-${viewport?.width}x${viewport?.height}.png`,
  });
}

async function openWizard(page: Page) {
  await page.goto('/dashboard?onboarding');
  const wizard = page.locator('[data-testid="onboarding-wizard"]');
  await expect(wizard).toBeVisible({ timeout: 5000 });
  return wizard;
}

async function begin(page: Page) {
  const wizard = await openWizard(page);
  await wizard.getByRole('button', { name: /Let's get you set up/ }).click();
  return wizard;
}

test('hello: SAM introduces itself on the void', async ({ page }) => {
  await setupMocks(page, { instant: true, artifacts: true });
  const wizard = await openWizard(page);

  await expect(wizard.getByRole('heading', { name: "Hi, I'm SAM." })).toBeVisible();
  await expect(wizard.getByRole('button', { name: /Let's get you set up/ })).toBeEnabled();
  expect(await wizard.evaluate((el) => el.classList.contains('sam-void'))).toBe(true);
  await assertNoOverflow(page);
  await viewportScreenshot(page, 'onboarding-hello');
});

test('runtime question offers Instant and the installation machines only when they exist', async ({
  page,
}) => {
  await setupMocks(page, { instant: true, platformCompute: true });
  const wizard = await begin(page);

  await expect(
    wizard.getByRole('heading', { name: 'Where should your agents work?' })
  ).toBeVisible();
  for (const label of [/Right here, on Cloudflare/, /installation's machines/, /my own cloud/])
    await expect(wizard.getByRole('button', { name: label })).toBeVisible();
  await assertNoOverflow(page);
  await viewportScreenshot(page, 'onboarding-runtime-question');
});

test('without Instant or platform machines, the cloud question is skipped for a cloud step', async ({
  page,
}) => {
  await setupMocks(page, { hasAgent: true, hasGitHub: true });
  const wizard = await begin(page);

  // Only "my own cloud" was possible and GitHub is the only repository home, so no question
  // is asked: the first screen is the cloud step.
  await expect(wizard.getByRole('heading', { name: 'Which cloud should I use?' })).toBeVisible();
  await expect(wizard.getByRole('heading', { name: 'Where should your agents work?' })).toHaveCount(
    0
  );
  await assertNoOverflow(page);
  await viewportScreenshot(page, 'onboarding-cloud-step');
});

test('repository question offers SAM hosting only where Artifacts is enabled', async ({ page }) => {
  for (const artifacts of [true, false]) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await setupMocks(page, { instant: true, artifacts, hasGitHub: !artifacts });
    const wizard = await begin(page);
    await wizard.getByRole('button', { name: /Right here, on Cloudflare/ }).click();

    if (artifacts) {
      await expect(
        wizard.getByRole('heading', { name: 'Where should your code live?' })
      ).toBeVisible();
      await expect(wizard.getByRole('button', { name: /Let SAM keep it/ })).toBeVisible();
      await expect(wizard.getByRole('button', { name: /On GitHub/ })).toBeVisible();
      await assertNoOverflow(page);
      await viewportScreenshot(page, 'onboarding-repo-question');
    } else {
      // GitHub is the only home and it is already connected: straight to the agent.
      await expect(
        wizard.getByRole('heading', { name: 'Who should do the coding?' })
      ).toBeVisible();
      await expect(wizard.getByRole('button', { name: /Let SAM keep it/ })).toHaveCount(0);
    }
  }
});

for (const [agent, connect, slug] of [
  ['Claude Code', 'Connect with Claude Code', 'claude'],
  ['OpenAI Codex', 'Connect with Codex', 'codex'],
] as const) {
  test(`agent step offers guided ${agent} sign-in, and Escape closes only the sign-in`, async ({
    page,
  }) => {
    await setupMocks(page, { instant: true, hasGitHub: true, guidedSignIn: true });
    const wizard = await begin(page);
    await wizard.getByRole('button', { name: /Right here, on Cloudflare/ }).click();
    await wizard.getByRole('button', { name: new RegExp(agent) }).click();

    const button = wizard.getByRole('button', { name: connect });
    await expect(button).toBeVisible({ timeout: 5000 });
    await expect(wizard.getByText(/^Or paste/)).toBeVisible();
    // The quick path is the one action; saving appears only once something is pasted.
    await expect(wizard.getByRole('button', { name: 'Save sign-in' })).toHaveCount(0);
    const [connectBox, pasteBox] = [
      await button.boundingBox(),
      await page.locator('#onboarding-oauth-token').boundingBox(),
    ];
    expect(connectBox!.y + connectBox!.height).toBeLessThanOrEqual(pasteBox!.y);
    await button.scrollIntoViewIfNeeded();
    await assertNoOverflow(page);
    await viewportScreenshot(page, `onboarding-agent-guided-${slug}`);

    await button.click();
    // The sign-in modal makes the wizard inert while it is open, so find it as the other dialog.
    const signIn = page
      .getByRole('dialog')
      .filter({ hasNot: page.locator('[data-testid="onboarding-wizard"]') })
      .last();
    await expect(signIn).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(1);
    await expect(wizard).toBeVisible();
    await expect(button).toBeVisible();
  });
}

test('SAM-managed AI is offered only when this installation enables it', async ({ page }) => {
  for (const samAi of [false, true]) {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await setupMocks(page, { instant: true, hasGitHub: true, samAi });
    const wizard = await begin(page);
    await wizard.getByRole('button', { name: /Right here, on Cloudflare/ }).click();
    await wizard.getByRole('button', { name: /Claude Code/ }).click();
    await expect(wizard.getByRole('button', { name: 'API key' })).toBeVisible();
    await expect(wizard.getByRole('button', { name: 'SAM AI' })).toHaveCount(samAi ? 1 : 0);
  }
  await page.getByRole('button', { name: 'API key' }).click();
  await expect(page.locator('#onboarding-api-key')).toBeVisible();
  await assertNoOverflow(page);
  await viewportScreenshot(page, 'onboarding-agent-api-key');
});

for (const monthlyCostCap of [true, false]) {
  test(`SAM AI limits ${monthlyCostCap ? 'offer' : 'omit'} a monthly cap ${
    monthlyCostCap ? 'with' : 'without'
  } AI Gateway`, async ({ page }) => {
    await setupMocks(page, { instant: true, hasGitHub: true, samAi: true, monthlyCostCap });
    const wizard = await begin(page);
    await wizard.getByRole('button', { name: /Right here, on Cloudflare/ }).click();
    await wizard.getByRole('button', { name: /Claude Code/ }).click();
    await wizard.getByRole('button', { name: 'SAM AI' }).click();
    // Liveness: the daily limits are always there.
    await expect(page.locator('#onboarding-daily-input')).toBeVisible();
    await expect(page.locator('#onboarding-daily-output')).toBeVisible();
    await expect(page.locator('#onboarding-monthly-cap')).toHaveCount(monthlyCostCap ? 1 : 0);
    await assertNoOverflow(page);
    await viewportScreenshot(
      page,
      `onboarding-sam-ai-limits-${monthlyCostCap ? 'with-gateway' : 'no-gateway'}`
    );
  });
}

test('SAM-hosted path: no GitHub, an Instant profile, then the first chat', async ({ page }) => {
  const recorded = await setupMocks(page, { instant: true, artifacts: true });
  const wizard = await begin(page);

  await wizard.getByRole('button', { name: /Right here, on Cloudflare/ }).click();
  await wizard.getByRole('button', { name: /Let SAM keep it/ }).click();

  // Agent step, through the API-key path.
  await expect(wizard.getByRole('list', { name: /Step 1 of 2/ })).toBeVisible();
  await wizard.getByRole('button', { name: /Claude Code/ }).click();
  await wizard.getByRole('button', { name: 'API key' }).click();
  await page.locator('#onboarding-api-key').fill('sk-test-key');
  await wizard.getByRole('button', { name: /Use this agent/ }).click();

  // Project step: name only, no GitHub step on the way.
  await expect(wizard.getByRole('heading', { name: 'What are we building?' })).toBeVisible();
  await expect(wizard.getByText(/GitHub app/)).toHaveCount(0);
  const name = 'a-very-long-project-name-that-keeps-going-to-check-wrapping-on-small-screens';
  await wizard.getByLabel('Project name').fill(name);
  await assertNoOverflow(page);
  await viewportScreenshot(page, 'onboarding-project-hosted');
  await wizard.getByRole('button', { name: /Create project/ }).click();

  await expect(wizard.getByRole('heading', { name: "We're ready." })).toBeVisible();
  expect(recorded.projects).toEqual([{ name, repoProvider: 'artifacts', defaultBranch: 'main' }]);
  expect(recorded.profiles).toEqual([
    {
      projectId: 'project-1',
      body: expect.objectContaining({
        agentType: 'claude-code',
        runtime: 'cf-container',
        taskMode: 'conversation',
      }),
    },
  ]);
  await assertNoOverflow(page);
  await viewportScreenshot(page, 'onboarding-ready');

  await wizard.getByRole('button', { name: /Start your first chat/ }).click();
  await expect(page).toHaveURL(/\/projects\/project-1\/chat$/);
  await expect(page.locator('[data-testid="onboarding-wizard"]')).toHaveCount(0);
});

test('own-cloud path ends with a full-machine profile on a GitHub project', async ({ page }) => {
  const recorded = await setupMocks(page, { hasAgent: false, hasCloud: true, hasGitHub: true });
  const wizard = await begin(page);

  await wizard.getByRole('button', { name: /Claude Code/ }).click();
  await wizard.getByRole('button', { name: 'API key' }).click();
  await page.locator('#onboarding-api-key').fill('sk-test-key');
  await wizard.getByRole('button', { name: /Use this agent/ }).click();

  const select = wizard.getByLabel('Repository');
  await expect(select).toBeVisible();
  await select.selectOption(REPOSITORY.fullName);
  await assertNoOverflow(page);
  await viewportScreenshot(page, 'onboarding-project-github');
  await wizard.getByRole('button', { name: /Create project/ }).click();

  await expect(wizard.getByRole('heading', { name: "We're ready." })).toBeVisible();
  expect(recorded.profiles[0]?.body).toEqual(
    expect.objectContaining({ runtime: 'vm', taskMode: 'task', workspaceProfile: 'full' })
  );
});

test('dashboard empty state offers a new project, not a GitHub import', async ({ page }) => {
  await setupMocks(page, {});
  await page.addInitScript(() =>
    localStorage.setItem('sam-onboarding-wizard-dismissed-user-demo-1', 'true')
  );
  await page.goto('/dashboard');

  await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible({
    timeout: 5000,
  });
  await expect(page.getByRole('button', { name: 'New Project' }).first()).toBeVisible();
  await expect(page.getByText(/Import/)).toHaveCount(0);
  await assertNoOverflow(page);
  await screenshot(page, 'onboarding-dashboard-empty-projects');
});
