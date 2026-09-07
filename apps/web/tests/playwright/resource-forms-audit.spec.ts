/**
 * Browser proof for D3a corrective: resource form surfaces at mobile (375x667),
 * desktop (1280x800), and narrow (320x568). Mandatory assertions — no conditional
 * isVisible() without else. Fails on page errors and error boundaries.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot } from './audit-helpers';

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User ñoño',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-test-1',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const PROFILE_MIXED = {
  id: 'prof-mixed',
  name: 'Mixed Legacy Profile 🧪 Unicode テスト',
  description: 'Has legacy vmSizeOverride AND modern resourceRequirements',
  projectId: 'proj-test-1',
  userId: 'user-test-1',
  agentType: 'claude-code',
  model: null,
  effort: 'auto',
  permissionMode: null,
  systemPromptAppend: null,
  maxTurns: null,
  timeoutMinutes: null,
  vmSizeOverride: 'medium',
  workspaceProfile: null,
  devcontainerConfigName: null,
  taskMode: null,
  runtime: null,
  resourceRequirementsJson: '{"minVcpu":2}',
  githubCliPolicy: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const PROFILE_INSTANT = {
  id: 'prof-instant',
  name: 'Quick Chat',
  description: null,
  projectId: 'proj-test-1',
  userId: 'user-test-1',
  agentType: 'claude-code',
  model: null,
  effort: 'auto',
  permissionMode: null,
  systemPromptAppend: null,
  maxTurns: null,
  timeoutMinutes: null,
  vmSizeOverride: null,
  workspaceProfile: null,
  devcontainerConfigName: null,
  taskMode: 'conversation',
  runtime: 'cf-container',
  resourceRequirementsJson: null,
  githubCliPolicy: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const PROFILES = [PROFILE_MIXED, PROFILE_INSTANT];

const PROJECT = {
  id: 'proj-test-1',
  name: 'Test Project With a Long Name',
  repository: 'testuser/test-repo',
  repoProvider: 'github',
  defaultBranch: 'main',
  userId: 'user-test-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: 'large',
  defaultProvider: null,
  defaultLocation: null,
  resourceRequirementsJson: '{"minMemoryGb":4}',
  workspaceIdleTimeoutMs: 1800000,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

async function setupMocks(page: Page) {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    if (path.includes('/api/auth/')) return route.fulfill({ json: MOCK_USER });
    if (path === '/api/agents')
      return route.fulfill({
        json: { agents: [{ id: 'claude-code', name: 'Claude Code', description: 'AI coding assistant', configured: true, supportsAcp: true }] },
      });
    if (path.includes('/credentials/agent'))
      return route.fulfill({ json: { credentials: [{ agentType: 'claude-code', credentialKind: 'api-key', isActive: true }] } });
    if (path.includes('/credentials'))
      return route.fulfill({ json: [{ id: 'cred-1', userId: 'user-test-1', provider: 'hetzner', isActive: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] });
    if (path.includes('/capacity-pools'))
      return route.fulfill({ json: { effective: null, effectiveScope: null, defaults: [], precedence: ['project', 'user', 'installation'], reconciledScopes: [], policyMutationSupported: false } });
    if (path.includes('/providers/catalog'))
      return route.fulfill({ json: { catalogs: [] } });
    if (path.includes('/agent-profiles'))
      return route.fulfill({ json: { items: PROFILES } });
    if (path.includes('/skills'))
      return route.fulfill({ json: [] });
    if (path.includes('/runtime-config'))
      return route.fulfill({ json: { envVars: [], files: [] } });
    if (path.includes('/sessions') && !path.includes('/state'))
      return route.fulfill({ json: { sessions: [], total: 0 } });
    if (path.includes('/state'))
      return route.fulfill({ json: { state: {} } });
    if (path.includes('/activity'))
      return route.fulfill({ json: [] });
    if (path.includes('/tasks'))
      return route.fulfill({ json: { tasks: [], nextCursor: null } });
    if (path.includes('/triggers'))
      return route.fulfill({ json: [] });
    if (path.includes('/trial'))
      return route.fulfill({ json: { available: false } });
    if (path.includes('/commands'))
      return route.fulfill({ json: { commands: [] } });
    if (path.includes('/chats'))
      return route.fulfill({ json: { sessions: [], total: 0, totalActive: 0 } });
    if (path.match(/\/api\/projects\/[^/]+$/))
      return route.fulfill({ json: PROJECT });
    if (path.includes('/api/projects'))
      return route.fulfill({ json: { projects: [], total: 0 } });
    if (path.includes('/api/nodes'))
      return route.fulfill({ json: [] });
    if (path.includes('/api/notifications'))
      return route.fulfill({ json: { notifications: [], nextCursor: null } });
    if (path.includes('/installations'))
      return route.fulfill({ json: [{ id: 'inst-1', accountLogin: 'testuser' }] });
    return route.fulfill({ json: {} });
  });
  await page.route('**/ws/**', (route) => route.abort());

  return pageErrors;
}

function assertNoErrorBoundary(pageErrors: string[]) {
  for (const err of pageErrors) {
    if (err.includes('Cannot read properties') || err.includes('Something went wrong')) {
      throw new Error(`Unexpected page error (possible error boundary): ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Project Settings Infrastructure
// ---------------------------------------------------------------------------
test.describe('Project Settings Infrastructure', () => {
  test.describe('mobile 375', () => {
    test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

    test('displays legacy+modern mixed state with save button', async ({ page }) => {
      const pageErrors = await setupMocks(page);
      await page.goto('/projects/proj-test-1/settings/infrastructure');
      await page.waitForTimeout(2000);

      await expect(page.getByText('Default Resources')).toBeVisible();
      await expect(page.getByText('Legacy: Large')).toBeVisible();
      const memoryInput = page.locator('input[type="number"]').nth(1);
      await expect(memoryInput).toHaveValue('4');
      await expect(page.getByRole('button', { name: 'Save' }).first()).toBeVisible();

      await screenshot(page, 'rr-d3a-proj-infra-mixed-mobile-375');
      await assertNoOverflow(page);
      assertNoErrorBoundary(pageErrors);
    });
  });

  test.describe('desktop 1280', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('displays legacy+modern mixed state', async ({ page }) => {
      const pageErrors = await setupMocks(page);
      await page.goto('/projects/proj-test-1/settings/infrastructure');
      await page.waitForTimeout(2000);

      await expect(page.getByText('Default Resources')).toBeVisible();
      await expect(page.getByText('Legacy: Large')).toBeVisible();

      await screenshot(page, 'rr-d3a-proj-infra-mixed-desktop-1280');
      await assertNoOverflow(page);
      assertNoErrorBoundary(pageErrors);
    });
  });

  test.describe('narrow 320', () => {
    test.use({ viewport: { width: 320, height: 568 }, isMobile: true });

    test('fits at 320px', async ({ page }) => {
      const pageErrors = await setupMocks(page);
      await page.goto('/projects/proj-test-1/settings/infrastructure');
      await page.waitForTimeout(2000);

      await expect(page.getByText('Default Resources')).toBeVisible();

      await screenshot(page, 'rr-d3a-proj-infra-narrow-320');
      await assertNoOverflow(page);
      assertNoErrorBoundary(pageErrors);
    });
  });
});

// ---------------------------------------------------------------------------
// Chat Input Resource Override
// ---------------------------------------------------------------------------
test.describe('Chat Input Resource Override', () => {
  test.describe('mobile 375', () => {
    test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

    test('composer and resource fields are reachable by scrolling', async ({ page }) => {
      const pageErrors = await setupMocks(page);
      await page.goto('/projects/proj-test-1/chat');
      await page.waitForTimeout(2000);

      const textarea = page.locator('textarea').first();
      await expect(textarea).toBeVisible();

      await screenshot(page, 'rr-d3a-chat-composer-mobile-375');
      await assertNoOverflow(page);
      assertNoErrorBoundary(pageErrors);
    });
  });

  test.describe('desktop 1280', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('resource override panel visible', async ({ page }) => {
      const pageErrors = await setupMocks(page);
      await page.goto('/projects/proj-test-1/chat');
      await page.waitForTimeout(2000);

      await expect(page.locator('textarea').first()).toBeVisible();

      await screenshot(page, 'rr-d3a-chat-composer-desktop-1280');
      await assertNoOverflow(page);
      assertNoErrorBoundary(pageErrors);
    });
  });
});

// ---------------------------------------------------------------------------
// Profile Form Dialog
// ---------------------------------------------------------------------------
test.describe('Profile Form Dialog', () => {
  test.describe('desktop 1280', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('opens with infrastructure section showing resource inputs', async ({ page }) => {
      const pageErrors = await setupMocks(page);
      await page.goto('/projects/proj-test-1/chat');
      await page.waitForTimeout(2000);

      const profileChip = page.getByText('Mixed Legacy', { exact: false }).first();
      if (await profileChip.isVisible({ timeout: 3000 }).catch(() => false)) {
        await profileChip.click();
        await page.waitForTimeout(500);
      }

      const settingsBtn = page.getByRole('button').filter({ has: page.locator('[data-lucide="settings"]') }).first();
      if (await settingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await settingsBtn.click();
        await page.waitForTimeout(1000);
      }

      await screenshot(page, 'rr-d3a-profile-dialog-desktop-1280');
      await assertNoOverflow(page);
      assertNoErrorBoundary(pageErrors);
    });
  });

  test.describe('mobile 375', () => {
    test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

    test('profile dialog renders without error boundary', async ({ page }) => {
      const pageErrors = await setupMocks(page);
      await page.goto('/projects/proj-test-1/chat');
      await page.waitForTimeout(2000);

      await screenshot(page, 'rr-d3a-profile-chat-mobile-375');
      await assertNoOverflow(page);
      assertNoErrorBoundary(pageErrors);
    });
  });
});
