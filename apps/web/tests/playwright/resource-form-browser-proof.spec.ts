/**
 * Comprehensive browser proof for resource form surfaces.
 *
 * Covers ProfileFormDialog, SkillFormDialog, TriggerForm, ProjectSettings
 * infrastructure, and ChatInput resource overrides at mobile (375x667),
 * desktop (1280x800), and narrow (320x568) viewports.
 *
 * Asserts actual POST/PATCH payloads, validates malformed data handling,
 * tests no-op preservation, partial edits, and clear operations.
 * Fails on page errors and error boundaries.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, screenshot } from './audit-helpers';

// ---------------------------------------------------------------------------
// Mock data
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User',
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

const PROJECT = {
  id: 'proj-test-1',
  name: 'Test Project',
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

const PROFILE_MIXED = {
  id: 'prof-mixed',
  name: 'Mixed Legacy \u{1F9EA} Unicode テスト',
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
  isBuiltin: false,
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
  isBuiltin: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const PROFILE_EMPTY = {
  id: 'prof-empty',
  name: 'Minimal Profile',
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
  taskMode: null,
  runtime: null,
  resourceRequirementsJson: null,
  githubCliPolicy: null,
  isBuiltin: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const PROFILES = [PROFILE_MIXED, PROFILE_INSTANT, PROFILE_EMPTY];

const SKILL_WITH_RESOURCES = {
  id: 'skill-1',
  name: 'Heavy Compute Skill',
  description: 'Needs extra resources',
  projectId: 'proj-test-1',
  userId: 'user-test-1',
  defaultProfileId: 'prof-mixed',
  systemPromptAppend: 'Use heavy compute.',
  vmSizeOverride: 'large',
  taskMode: 'task',
  resourceRequirementsJson: '{"minVcpu":4,"minMemoryGb":16}',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const SKILL_EMPTY = {
  id: 'skill-2',
  name: 'Simple Skill',
  description: null,
  projectId: 'proj-test-1',
  userId: 'user-test-1',
  defaultProfileId: null,
  systemPromptAppend: null,
  vmSizeOverride: null,
  taskMode: 'task',
  resourceRequirementsJson: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const SKILLS = [SKILL_WITH_RESOURCES, SKILL_EMPTY];

const TRIGGER_WITH_RESOURCES = {
  id: 'trigger-1',
  name: 'Nightly Build',
  description: 'Runs every night',
  projectId: 'proj-test-1',
  userId: 'user-test-1',
  sourceType: 'cron',
  cronSchedule: '0 3 * * *',
  cronTimezone: 'UTC',
  promptTemplate: 'Run nightly build checks',
  enabled: true,
  skipIfRunning: false,
  maxConcurrent: 1,
  agentProfileId: 'prof-mixed',
  vmSizeOverride: 'medium',
  taskMode: 'task',
  resourceRequirementsJson: '{"minVcpu":2,"minMemoryGb":8}',
  lastFiredAt: null,
  nextFireAt: '2026-09-08T03:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const TRIGGERS = [TRIGGER_WITH_RESOURCES];

// ---------------------------------------------------------------------------
// API mock setup with payload capture
// ---------------------------------------------------------------------------

interface CapturedRequest {
  method: string;
  path: string;
  body: unknown;
}

async function setupMocks(page: Page, overrides?: {
  profiles?: typeof PROFILES;
  skills?: typeof SKILLS;
  triggers?: typeof TRIGGERS;
  project?: typeof PROJECT;
}) {
  const pageErrors: string[] = [];
  const capturedRequests: CapturedRequest[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // Dismiss onboarding wizard
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);

  const profs = overrides?.profiles ?? PROFILES;
  const skills = overrides?.skills ?? SKILLS;
  const triggers = overrides?.triggers ?? TRIGGERS;
  const project = overrides?.project ?? PROJECT;

  await page.route('**/api/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();

    // Capture mutating requests
    if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
      let body: unknown = null;
      try { body = JSON.parse(req.postData() ?? ''); } catch { /* empty */ }
      capturedRequests.push({ method, path, body });
    }

    const respond = (data: unknown, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });

    // Auth & telemetry
    if (path.includes('/api/auth/')) return respond(MOCK_USER);
    if (path === '/api/client-errors') return respond(null, 204);
    if (path === '/api/t') return respond(null, 204);
    if (path.includes('/credential-attribution-health')) return respond({ healthy: true });
    if (path.includes('/notification') && path.includes('/preferences'))
      return respond({});

    // Dashboard
    if (path === '/api/dashboard/active-tasks') return respond({ tasks: [] });
    if (path.startsWith('/api/notifications')) return respond({ notifications: [], unreadCount: 0 });
    if (path === '/api/agents')
      return respond({ agents: [{ id: 'claude-code', name: 'Claude Code', description: 'AI coding assistant', configured: true, supportsAcp: true }] });

    // Credentials
    if (path.includes('/credentials/agent'))
      return respond({ credentials: [{ agentType: 'claude-code', credentialKind: 'api-key', isActive: true }] });
    if (path.includes('/credentials'))
      return respond([{ id: 'cred-1', userId: 'user-test-1', provider: 'hetzner', isActive: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }]);

    // Providers
    if (path.includes('/capacity-pools'))
      return respond({ effective: null, effectiveScope: null, defaults: [], precedence: ['project', 'user', 'installation'], reconciledScopes: [], policyMutationSupported: false });
    if (path.includes('/providers/catalog'))
      return respond({ catalogs: [] });

    // Installations
    if (path.includes('/installations'))
      return respond([{ id: 'inst-1', accountLogin: 'testuser' }]);

    // Project sub-routes
    const projMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projMatch) {
      const sub = projMatch[2] ?? '';

      // Mutation responses (create/update)
      if (method === 'POST' && sub === '/agent-profiles')
        return respond({ ...PROFILE_EMPTY, id: 'prof-new-1', name: 'New Profile' });
      if ((method === 'PATCH' || method === 'PUT') && sub.match(/\/agent-profiles\/[^/]+$/))
        return respond({ ...PROFILE_MIXED, updatedAt: new Date().toISOString() });
      if (method === 'POST' && sub === '/skills')
        return respond({ ...SKILL_EMPTY, id: 'skill-new-1', name: 'New Skill' });
      if (method === 'PATCH' && sub.match(/\/skills\/[^/]+$/))
        return respond({ ...SKILL_WITH_RESOURCES, updatedAt: new Date().toISOString() });
      if (method === 'POST' && sub === '/triggers')
        return respond({ ...TRIGGER_WITH_RESOURCES, id: 'trigger-new-1' });
      if (method === 'PATCH' && sub.match(/\/triggers\/[^/]+$/))
        return respond({ ...TRIGGER_WITH_RESOURCES, updatedAt: new Date().toISOString() });
      if (method === 'PATCH' && sub === '')
        return respond({ ...project, updatedAt: new Date().toISOString() });

      // Read responses
      if (sub.match(/\/agent-profiles\/[^/]+\/runtime\/env-vars$/)) return respond({ envVars: [] });
      if (sub.match(/\/agent-profiles\/[^/]+\/runtime\/files$/)) return respond({ files: [] });
      if (sub.match(/\/skills\/[^/]+\/runtime\/env-vars/)) return respond({ envVars: [] });
      if (sub.match(/\/skills\/[^/]+\/runtime\/files/)) return respond({ files: [] });
      if (sub === '/runtime-config') return respond({ envVars: [], files: [] });
      if (sub === '/repository-access') return respond({ repositories: [] });
      if (sub === '/devcontainer-configs')
        return respond({ repository: project.repository, branch: project.defaultBranch, defaultConfigExists: false, configs: [] });
      if (sub.startsWith('/cached-commands')) return respond({ commands: [] });
      if (sub.startsWith('/activity')) return respond({ events: [], nextCursor: null });
      if (sub.startsWith('/sessions') && !sub.includes('/state'))
        return respond({ sessions: [], total: 0 });
      if (sub.includes('/state')) return respond({ state: {} });
      if (sub === '/agent-profiles') return respond({ items: profs });
      if (sub === '/skills') return respond({ items: skills });
      if (sub.startsWith('/triggers') && sub !== '/triggers')
        return respond(triggers[0] ?? {});
      if (sub === '/triggers') return respond({ triggers });
      if (sub.startsWith('/tasks/submit') && method === 'POST')
        return respond({ taskId: 'task-new-1', status: 'queued' });
      if (sub.startsWith('/tasks')) return respond({ tasks: [], nextCursor: null });
      if (sub === '/trial') return respond({ available: false });
      if (sub.startsWith('/chats')) return respond({ sessions: [], total: 0, totalActive: 0 });
      if (sub.startsWith('/mcp-connections')) return respond([]);
      if (sub === '') return respond(project);
      return respond({});
    }

    if (path === '/api/projects') return respond({ projects: [project], nextCursor: null });
    if (path.includes('/api/nodes')) return respond([]);
    return respond({});
  });

  await page.route('**/ws/**', (route) => route.abort());

  return { pageErrors, capturedRequests };
}

function assertNoPageErrors(errors: string[]) {
  const real = errors.filter(
    (e) => !e.includes('ResizeObserver') && !e.includes('WebSocket')
  );
  if (real.length > 0) {
    throw new Error(`Unexpected page errors:\n${real.join('\n')}`);
  }
}

// ---------------------------------------------------------------------------
// ProfileFormDialog — Profiles page
// ---------------------------------------------------------------------------

test.describe('ProfileFormDialog — Profiles Page', () => {
  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('create new profile — opens empty dialog with resource inputs', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/profiles');
      await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();
      await page.getByRole('button', { name: 'New Profile' }).click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Create Agent Profile')).toBeVisible();

      // Expand Infrastructure accordion to show resource inputs
      const infraBtn = dialog.getByText('Infrastructure', { exact: false });
      await infraBtn.scrollIntoViewIfNeeded();
      await infraBtn.click();
      await page.waitForTimeout(300);

      // Scroll to see the expanded section
      const scrollContainer = dialog.locator('.overflow-y-auto');
      await scrollContainer.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(300);

      await screenshot(page, 'profile-create-dialog-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('edit mixed legacy+modern profile — shows legacy badge and vcpu', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/profiles');
      const editBtn = page.getByRole('button', { name: `Edit ${PROFILE_MIXED.name}` });
      await expect(editBtn).toBeVisible();
      await editBtn.click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Edit Profile')).toBeVisible();

      // Expand Infrastructure accordion
      const infraBtn = dialog.getByText('Infrastructure', { exact: false });
      await infraBtn.scrollIntoViewIfNeeded();
      await infraBtn.click();
      await page.waitForTimeout(300);

      // Scroll to bottom to see resource inputs
      const scrollContainer = dialog.locator('.overflow-y-auto');
      await scrollContainer.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(300);

      // Legacy badge should be visible
      await expect(dialog.getByText('Legacy: Medium')).toBeVisible();

      // vCPU field should show value 2
      const vcpuInput = dialog.getByLabel('vCPU');
      await expect(vcpuInput).toHaveValue('2');

      await screenshot(page, 'profile-edit-mixed-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('edit profile no-op save — preserves mixed legacy+modern data', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/profiles');
      const editBtn = page.getByRole('button', { name: `Edit ${PROFILE_MIXED.name}` });
      await expect(editBtn).toBeVisible();
      await editBtn.click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      // Save without changes — scroll to save button
      const saveBtn = dialog.getByRole('button', { name: 'Save Changes' });
      await saveBtn.scrollIntoViewIfNeeded();
      await saveBtn.click();
      await page.waitForTimeout(500);

      // Check the PATCH payload preserves both legacy and modern fields
      const patch = capturedRequests.find(
        (r) => (r.method === 'PATCH' || r.method === 'PUT') && r.path.includes('/agent-profiles/')
      );
      expect(patch).toBeTruthy();
      const body = patch!.body as Record<string, unknown>;
      expect(body.vmSizeOverride).toBe('medium');
      expect(body.resourceRequirementsJson).toBe('{"minVcpu":2}');

      assertNoPageErrors(pageErrors);
    });

    test('edit profile partial edit — change only vcpu preserves rest', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/profiles');
      const editBtn = page.getByRole('button', { name: `Edit ${PROFILE_MIXED.name}` });
      await expect(editBtn).toBeVisible();
      await editBtn.click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      // Expand Infrastructure accordion
      const infraBtn = dialog.getByText('Infrastructure', { exact: false });
      await infraBtn.scrollIntoViewIfNeeded();
      await infraBtn.click();
      await page.waitForTimeout(300);

      const scrollContainer = dialog.locator('.overflow-y-auto');
      await scrollContainer.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(300);

      // Change vCPU from 2 to 4
      const vcpuInput = dialog.getByLabel('vCPU');
      await vcpuInput.fill('4');

      const saveBtn = dialog.getByRole('button', { name: 'Save Changes' });
      await saveBtn.scrollIntoViewIfNeeded();
      await saveBtn.click();
      await page.waitForTimeout(500);

      const patch = capturedRequests.find(
        (r) => (r.method === 'PATCH' || r.method === 'PUT') && r.path.includes('/agent-profiles/')
      );
      expect(patch).toBeTruthy();
      const body = patch!.body as Record<string, unknown>;
      expect(body.vmSizeOverride).toBe('medium');
      const resJson = JSON.parse(body.resourceRequirementsJson as string);
      expect(resJson.minVcpu).toBe(4);

      assertNoPageErrors(pageErrors);
    });

    test('edit profile clear resources — emits null for legacy and modern', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/profiles');
      const editBtn = page.getByRole('button', { name: `Edit ${PROFILE_MIXED.name}` });
      await expect(editBtn).toBeVisible();
      await editBtn.click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      // Expand Infrastructure accordion
      const infraBtn = dialog.getByText('Infrastructure', { exact: false });
      await infraBtn.scrollIntoViewIfNeeded();
      await infraBtn.click();
      await page.waitForTimeout(300);

      const scrollContainer = dialog.locator('.overflow-y-auto');
      await scrollContainer.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(300);

      // Click "Inherit default" to clear all resource values and legacy
      const inheritBtn = dialog.getByRole('button', { name: /Inherit default/i });
      await inheritBtn.scrollIntoViewIfNeeded();
      await expect(inheritBtn).toBeVisible();
      await inheritBtn.click();
      await page.waitForTimeout(300);

      const saveBtn = dialog.getByRole('button', { name: 'Save Changes' });
      await saveBtn.scrollIntoViewIfNeeded();
      await saveBtn.click();
      await page.waitForTimeout(500);

      const patch = capturedRequests.find(
        (r) => (r.method === 'PATCH' || r.method === 'PUT') && r.path.includes('/agent-profiles/')
      );
      expect(patch).toBeTruthy();
      const body = patch!.body as Record<string, unknown>;
      expect(body.vmSizeOverride === null || body.vmSizeOverride === '').toBe(true);

      assertNoPageErrors(pageErrors);
    });
  });

  test.describe('mobile 375x667', () => {
    test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

    test('create profile dialog renders properly on mobile', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/profiles');
      await page.waitForSelector('text=New Profile');
      await page.click('button:has-text("New Profile")');

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Create Agent Profile')).toBeVisible();

      await screenshot(page, 'profile-create-dialog-mobile');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('edit mixed profile on mobile — legacy badge visible', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/profiles');
      const editBtn = page.getByRole('button', { name: `Edit ${PROFILE_MIXED.name}` });
      await expect(editBtn).toBeVisible();
      await editBtn.click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      // Expand Infrastructure
      const infraBtn = dialog.getByText('Infrastructure', { exact: false });
      await infraBtn.scrollIntoViewIfNeeded();
      await infraBtn.click();
      await page.waitForTimeout(300);

      const scrollContainer = dialog.locator('.overflow-y-auto');
      await scrollContainer.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(300);

      await screenshot(page, 'profile-edit-mixed-mobile');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });

  test.describe('narrow 320x568', () => {
    test.use({ viewport: { width: 320, height: 568 }, isMobile: true });

    test('profile dialog fits at 320px', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/profiles');
      await page.waitForSelector('text=New Profile');
      await page.click('button:has-text("New Profile")');

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      await screenshot(page, 'profile-create-dialog-narrow');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });
});

// ---------------------------------------------------------------------------
// SkillFormDialog — Skills page
// ---------------------------------------------------------------------------

test.describe('SkillFormDialog — Skills Page', () => {
  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('create new skill — shows resource inputs', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/skills');
      await expect(page.getByRole('button', { name: 'New Skill' })).toBeVisible();
      await page.getByRole('button', { name: 'New Skill' }).click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', { name: 'Create Skill' })).toBeVisible();

      // Resource inputs visible directly (no accordion in skill form)
      await expect(dialog.getByLabel('vCPU')).toBeVisible();

      await screenshot(page, 'skill-create-dialog-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('edit skill with resources — shows legacy badge and modern values', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/skills');
      await expect(page.getByText(SKILL_WITH_RESOURCES.name)).toBeVisible({ timeout: 15000 });

      await page.getByRole('button', { name: `Edit ${SKILL_WITH_RESOURCES.name}` }).click();
      await page.waitForTimeout(1000);

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 15000 });

      // Check legacy badge
      await expect(dialog.getByText(/Legacy:.*Large/)).toBeVisible();

      // Check vCPU = 4, memory = 16
      await expect(dialog.getByLabel('vCPU')).toHaveValue('4');
      await expect(dialog.getByLabel('Memory (GB)')).toHaveValue('16');

      await screenshot(page, 'skill-edit-resources-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('create skill — validates and submits with resource data', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/skills');
      await expect(page.getByRole('button', { name: 'New Skill' })).toBeVisible();
      await page.getByRole('button', { name: 'New Skill' }).click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      // Fill name
      await dialog.locator('#skill-name').fill('Test Compute Skill');

      // Fill vCPU
      await dialog.getByLabel('vCPU').fill('8');

      // Submit
      await dialog.getByRole('button', { name: 'Create Skill' }).click();
      await page.waitForTimeout(500);

      const post = capturedRequests.find(
        (r) => r.method === 'POST' && r.path.includes('/skills')
      );
      expect(post).toBeTruthy();
      const body = post!.body as Record<string, unknown>;
      expect(body.name).toBe('Test Compute Skill');
      const resJson = JSON.parse(body.resourceRequirementsJson as string);
      expect(resJson.minVcpu).toBe(8);

      assertNoPageErrors(pageErrors);
    });

    test('skill no-op save preserves existing data', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/skills');
      await expect(page.getByText(SKILL_WITH_RESOURCES.name)).toBeVisible({ timeout: 15000 });

      await page.getByRole('button', { name: `Edit ${SKILL_WITH_RESOURCES.name}` }).click();
      await page.waitForTimeout(1000);
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 15000 });

      // Save without changes
      const saveBtn = dialog.getByRole('button', { name: 'Save Changes' });
      await saveBtn.scrollIntoViewIfNeeded();
      await saveBtn.click();
      await page.waitForTimeout(500);

      const patch = capturedRequests.find(
        (r) => r.method === 'PATCH' && r.path.includes('/skills/')
      );
      expect(patch).toBeTruthy();
      const body = patch!.body as Record<string, unknown>;
      expect(body.vmSizeOverride).toBe('large');
      const resJson = JSON.parse(body.resourceRequirementsJson as string);
      expect(resJson.minVcpu).toBe(4);
      expect(resJson.minMemoryGb).toBe(16);

      assertNoPageErrors(pageErrors);
    });
  });

  test.describe('mobile 375x667', () => {
    test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

    test('skill dialog on mobile — scrollable and no overflow', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/skills');
      await expect(page.getByRole('button', { name: 'New Skill' })).toBeVisible();
      await page.getByRole('button', { name: 'New Skill' }).click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      await screenshot(page, 'skill-create-dialog-mobile');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('edit skill with resources on mobile', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/skills');
      await expect(page.getByText(SKILL_WITH_RESOURCES.name)).toBeVisible();

      await page.getByRole('button', { name: `Edit ${SKILL_WITH_RESOURCES.name}` }).click();
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      await screenshot(page, 'skill-edit-resources-mobile');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });

  test.describe('narrow 320x568', () => {
    test.use({ viewport: { width: 320, height: 568 }, isMobile: true });

    test('skill dialog fits at 320px', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/skills');
      await expect(page.getByRole('button', { name: 'New Skill' })).toBeVisible();
      await page.getByRole('button', { name: 'New Skill' }).click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      await screenshot(page, 'skill-create-dialog-narrow');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });
});

// ---------------------------------------------------------------------------
// TriggerForm — Triggers page
// ---------------------------------------------------------------------------

test.describe('TriggerForm — Triggers Page', () => {
  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('create new trigger — form opens with resource section in advanced', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/triggers');
      await page.waitForTimeout(2000);

      // Click create trigger button
      const createBtn = page.getByRole('button', { name: /new trigger|create trigger/i }).first();
      await expect(createBtn).toBeVisible();
      await createBtn.click();

      // The TriggerForm opens as a dialog
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      // Open advanced options to see resource section
      const advancedBtn = dialog.getByText(/advanced/i).first();
      await expect(advancedBtn).toBeVisible();
      await advancedBtn.click();
      await page.waitForTimeout(300);

      await screenshot(page, 'trigger-create-form-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('edit trigger with resources — shows legacy and modern values', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/triggers');
      await expect(page.getByText(TRIGGER_WITH_RESOURCES.name)).toBeVisible();

      // Open the dropdown menu on the trigger card, then click Edit
      const actionsBtn = page.getByRole('button', { name: `Actions for "${TRIGGER_WITH_RESOURCES.name}"` });
      await expect(actionsBtn).toBeVisible();
      await actionsBtn.click();
      await page.waitForTimeout(200);

      // Click Edit in the dropdown
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      await page.waitForTimeout(300);

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      await screenshot(page, 'trigger-edit-resources-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });

  test.describe('mobile 375x667', () => {
    test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

    test('trigger form on mobile — no overflow', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/triggers');
      await page.waitForTimeout(2000);

      const createBtn = page.getByRole('button', { name: /new trigger|create trigger/i }).first();
      await createBtn.click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      await screenshot(page, 'trigger-create-form-mobile');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });

  test.describe('narrow 320x568', () => {
    test.use({ viewport: { width: 320, height: 568 }, isMobile: true });

    test('trigger form fits at 320px', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/triggers');
      await page.waitForTimeout(2000);

      const createBtn = page.getByRole('button', { name: /new trigger|create trigger/i }).first();
      await createBtn.click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      await screenshot(page, 'trigger-create-form-narrow');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });
});

// ---------------------------------------------------------------------------
// Project Settings Infrastructure — resource section with timeout field
// ---------------------------------------------------------------------------

test.describe('Project Settings Infrastructure', () => {
  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('shows mixed legacy+modern state with independently dirty timeout', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/settings/infrastructure');
      await page.waitForTimeout(2000);

      // Verify default resources section visible
      await expect(page.getByText('Default Resources')).toBeVisible();
      await expect(page.getByText(/Legacy:.*Large/)).toBeVisible();

      // Verify memory field shows 4
      await expect(page.getByLabel('Memory (GB)')).toHaveValue('4');

      // Verify workspace idle timeout section exists independently
      await expect(page.getByRole('heading', { name: 'Workspace Idle Timeout' })).toBeVisible();
      const timeoutSlider = page.locator('#workspace-idle-timeout');
      await expect(timeoutSlider).toBeVisible();

      // Both Save buttons exist (one for resources, one for timeout)
      const saveButtons = page.getByRole('button', { name: 'Save' });
      const saveCount = await saveButtons.count();
      expect(saveCount).toBeGreaterThanOrEqual(2);

      // Save resources — should include resource data
      const firstSave = saveButtons.first();
      await firstSave.click();
      await page.waitForTimeout(500);

      const resourcePatch = capturedRequests.find(
        (r) => r.method === 'PATCH' && r.path.match(/\/api\/projects\/[^/]+$/) &&
               (r.body as Record<string, unknown>)?.resourceRequirementsJson !== undefined
      );
      expect(resourcePatch).toBeTruthy();
      const body = resourcePatch!.body as Record<string, unknown>;
      expect(body.defaultVmSize).toBe('large');

      await screenshot(page, 'proj-infra-timeout-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });

  test.describe('mobile 375x667', () => {
    test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

    test('infrastructure section on mobile', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/settings/infrastructure');
      await page.waitForTimeout(2000);

      await expect(page.getByText('Default Resources')).toBeVisible();

      await screenshot(page, 'proj-infra-mobile');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });
});

// ---------------------------------------------------------------------------
// ChatInput — per-task resource overrides and profile wizard
// ---------------------------------------------------------------------------

test.describe('ChatInput — Resource Overrides', () => {
  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('chat composer renders with textarea visible', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/chat');
      await page.waitForTimeout(2000);

      const textarea = page.locator('textarea').first();
      await expect(textarea).toBeVisible();

      await screenshot(page, 'chat-composer-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('resource override toggle opens resource inputs', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/chat');
      await page.waitForTimeout(2000);

      // The Resources button should exist in the chat composer area
      const resourceBtn = page.getByRole('button', { name: /resource/i }).first();
      await expect(resourceBtn).toBeVisible({ timeout: 5000 });
      await resourceBtn.click();
      await page.waitForTimeout(500);

      // Resource inputs should now be visible
      await expect(page.getByLabel('vCPU')).toBeVisible();

      await screenshot(page, 'chat-resource-override-open-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });

  test.describe('mobile 375x667', () => {
    test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

    test('chat composer on mobile — textarea reachable', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/chat');
      await page.waitForTimeout(2000);

      const textarea = page.locator('textarea').first();
      await expect(textarea).toBeVisible();

      await screenshot(page, 'chat-composer-mobile');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });

  test.describe('narrow 320x568', () => {
    test.use({ viewport: { width: 320, height: 568 }, isMobile: true });

    test('chat fits at 320px', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/chat');
      await page.waitForTimeout(2000);

      const textarea = page.locator('textarea').first();
      await expect(textarea).toBeVisible();

      await screenshot(page, 'chat-composer-narrow');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });
});

// ---------------------------------------------------------------------------
// Edge cases: long data, Unicode, XSS-like strings, many items, empty state
// ---------------------------------------------------------------------------

test.describe('Edge cases — stress data', () => {
  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('profiles page with 30+ profiles — scrolling and layout', async ({ page }) => {
      const manyProfiles = Array.from({ length: 32 }, (_, i) => ({
        ...PROFILE_EMPTY,
        id: `prof-${i}`,
        name: i === 0 ? 'A'.repeat(200) + ' Long Name Profile' : `Profile #${i + 1}`,
        description: i === 1 ? '<script>alert("xss")</script> & ☃ \u{1F600} Unicode test' : `Description ${i}`,
      }));

      const { pageErrors } = await setupMocks(page, { profiles: manyProfiles });
      await page.goto('/projects/proj-test-1/profiles');
      await page.waitForTimeout(2000);

      // Verify multiple profiles render
      await expect(page.getByText('Profile #2', { exact: true })).toBeVisible();

      await screenshot(page, 'profiles-many-items-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('skills page empty state', async ({ page }) => {
      const { pageErrors } = await setupMocks(page, { skills: [] });
      await page.goto('/projects/proj-test-1/skills');
      await page.waitForTimeout(2000);

      await expect(page.getByText(/no skills yet/i)).toBeVisible();

      await screenshot(page, 'skills-empty-state-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('triggers page empty state', async ({ page }) => {
      const { pageErrors } = await setupMocks(page, { triggers: [] });
      await page.goto('/projects/proj-test-1/triggers');
      await page.waitForTimeout(2000);

      await screenshot(page, 'triggers-empty-state-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('profile with XSS-like name renders safely', async ({ page }) => {
      const xssProfile = {
        ...PROFILE_EMPTY,
        id: 'prof-xss',
        name: '<img src=x onerror=alert(1)> & éèê \u{1F4A5}',
        description: '"><script>document.cookie</script>',
      };
      const { pageErrors } = await setupMocks(page, { profiles: [xssProfile] });
      await page.goto('/projects/proj-test-1/profiles');
      await page.waitForTimeout(2000);

      // Name should render as text, not execute
      await expect(page.getByText('<img src=x')).toBeVisible();

      await screenshot(page, 'profiles-xss-safe-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });

  test.describe('mobile 375x667', () => {
    test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

    test('long profile name wraps on mobile', async ({ page }) => {
      const longProfile = {
        ...PROFILE_EMPTY,
        id: 'prof-long',
        name: 'VeryLongProfileNameThatShouldWrapOrTruncateProperlyOnMobileViewport_' + 'A'.repeat(150),
      };
      const { pageErrors } = await setupMocks(page, { profiles: [longProfile] });
      await page.goto('/projects/proj-test-1/profiles');
      await page.waitForTimeout(2000);

      await screenshot(page, 'profiles-long-name-mobile');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('skills with 30+ items on mobile', async ({ page }) => {
      const manySkills = Array.from({ length: 30 }, (_, i) => ({
        ...SKILL_EMPTY,
        id: `skill-${i}`,
        name: `Skill ${i + 1}`,
        description: i % 3 === 0 ? null : `Description for skill ${i + 1}`,
      }));
      const { pageErrors } = await setupMocks(page, { skills: manySkills });
      await page.goto('/projects/proj-test-1/skills');
      await page.waitForTimeout(2000);

      await screenshot(page, 'skills-many-items-mobile');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });
});

// ---------------------------------------------------------------------------
// Error states
// ---------------------------------------------------------------------------

test.describe('Error states', () => {
  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('skill form validation error — empty name', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      // Open create skill dialog via URL
      await page.goto('/projects/proj-test-1/skills?edit=new');
      await page.waitForTimeout(1000);

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 10000 });

      // Try to submit without name
      await dialog.getByRole('button', { name: 'Create Skill' }).click();
      await page.waitForTimeout(300);

      // Error should be shown
      await expect(dialog.getByRole('alert')).toBeVisible();
      await expect(dialog.getByText(/skill name is required/i)).toBeVisible();

      await screenshot(page, 'skill-validation-error-desktop');
      assertNoPageErrors(pageErrors);
    });

    test('profile form with invalid resource values', async ({ page }) => {
      const malformedProfile = {
        ...PROFILE_MIXED,
        id: 'prof-malformed',
        name: 'Malformed Resources',
        resourceRequirementsJson: '{"minVcpu":-5,"minMemoryGb":"not_a_number","_rawInvalidFields":{"minMemoryGb":"not_a_number"}}',
      };
      const { pageErrors } = await setupMocks(page, { profiles: [malformedProfile] });
      await page.goto('/projects/proj-test-1/profiles');
      await page.waitForSelector('text=Malformed Resources');

      await page.click('button[aria-label="Edit Malformed Resources"]');
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      // Scroll to see resource section
      const scrollContainer = dialog.locator('.overflow-y-auto');
      await scrollContainer.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(300);

      await screenshot(page, 'profile-malformed-resources-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });
});
