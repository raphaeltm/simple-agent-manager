/**
 * Browser proof for D3a: resource form surfaces at mobile (375x667),
 * desktop (1280x800), and narrow (320x568). Covers ResourceRequirementsInput,
 * ProfileFormDialog, ChatInput resource override, and ProjectSettings
 * infrastructure.
 */
import { type Page, type Route, test } from '@playwright/test';

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

const PROFILE_WITH_LEGACY_AND_MODERN = {
  id: 'prof-mixed',
  name: 'Mixed Legacy Profile 🧪 Unicode テスト',
  description: 'Has legacy vmSizeOverride AND modern resourceRequirements — the mixed state we must preserve',
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

const PROFILES = [
  PROFILE_WITH_LEGACY_AND_MODERN,
  {
    id: 'prof-plain',
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
  },
];

const MOCK_PROJECT_WITH_LEGACY = {
  id: 'proj-test-1',
  name: 'Test Project With a Really Long Name That Should Wrap Properly on Mobile Viewports',
  repository: 'testuser/test-repo-with-very-long-name-that-tests-overflow',
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

async function setupMocks(page: Page, options?: { project?: Record<string, unknown> }) {
  const project = options?.project ?? MOCK_PROJECT_WITH_LEGACY;
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
      return route.fulfill({ json: project });
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
}

// ---------------------------------------------------------------------------
// Mobile (375x667)
// ---------------------------------------------------------------------------
test.describe('Resource Forms — Mobile 375', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('project settings infra with legacy+modern mixed state', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/settings/infrastructure');
    await page.waitForTimeout(2500);
    await screenshot(page, 'rr-d3a-proj-settings-mixed-mobile');
    await assertNoOverflow(page);
  });

  test('chat input resource override toggle', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(2500);
    const resourceBtn = page.getByText('Resources', { exact: false }).first();
    if (await resourceBtn.isVisible()) {
      await resourceBtn.click();
      await page.waitForTimeout(500);
    }
    await screenshot(page, 'rr-d3a-chat-resource-override-mobile');
    await assertNoOverflow(page);
  });

  test('profile form dialog infrastructure section', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(2500);
    const editBtn = page.getByLabel(/Edit/);
    if (await editBtn.first().isVisible()) {
      await editBtn.first().click();
      await page.waitForTimeout(1000);
      const infraSection = page.getByText('Infrastructure');
      if (await infraSection.isVisible()) {
        await infraSection.click();
        await page.waitForTimeout(500);
      }
    }
    await screenshot(page, 'rr-d3a-profile-dialog-infra-mobile');
    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Desktop (1280x800)
// ---------------------------------------------------------------------------
test.describe('Resource Forms — Desktop 1280', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('project settings infra with legacy+modern mixed state', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/settings/infrastructure');
    await page.waitForTimeout(2500);
    await screenshot(page, 'rr-d3a-proj-settings-mixed-desktop');
    await assertNoOverflow(page);
  });

  test('chat input resource override toggle', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(2500);
    const resourceBtn = page.getByText('Resources', { exact: false }).first();
    if (await resourceBtn.isVisible()) {
      await resourceBtn.click();
      await page.waitForTimeout(500);
    }
    await screenshot(page, 'rr-d3a-chat-resource-override-desktop');
    await assertNoOverflow(page);
  });

  test('profile form dialog infrastructure section with mixed legacy', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(2500);
    const profileBtn = page.getByText(PROFILE_WITH_LEGACY_AND_MODERN.name.slice(0, 15), { exact: false }).first();
    if (await profileBtn.isVisible()) {
      await profileBtn.click();
      await page.waitForTimeout(300);
    }
    const editBtn = page.getByLabel(/Edit/);
    if (await editBtn.first().isVisible()) {
      await editBtn.first().click();
      await page.waitForTimeout(1000);
      const infraSection = page.getByText('Infrastructure');
      if (await infraSection.isVisible()) {
        await infraSection.click();
        await page.waitForTimeout(500);
      }
    }
    await screenshot(page, 'rr-d3a-profile-dialog-infra-mixed-desktop');
    await assertNoOverflow(page);
  });
});

// ---------------------------------------------------------------------------
// Narrow (320x568)
// ---------------------------------------------------------------------------
test.describe('Resource Forms — Narrow 320', () => {
  test.use({ viewport: { width: 320, height: 568 }, isMobile: true });

  test('project settings infra fits at 320px', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/settings/infrastructure');
    await page.waitForTimeout(2500);
    await screenshot(page, 'rr-d3a-proj-settings-narrow-320');
    await assertNoOverflow(page);
  });

  test('chat input with resource override at 320px', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-test-1/chat');
    await page.waitForTimeout(2500);
    const resourceBtn = page.getByText('Resources', { exact: false }).first();
    if (await resourceBtn.isVisible()) {
      await resourceBtn.click();
      await page.waitForTimeout(500);
    }
    await screenshot(page, 'rr-d3a-chat-resource-narrow-320');
    await assertNoOverflow(page);
  });
});
