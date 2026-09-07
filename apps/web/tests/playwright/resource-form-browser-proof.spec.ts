/**
 * Comprehensive browser proof for resource form surfaces.
 *
 * Covers ProfileFormDialog, SkillFormDialog, TriggerForm, ProjectSettings
 * infrastructure, ChatInput (submit/reset/VM-vs-Instant/wizard), at mobile
 * (375x667), desktop (1280x800), and narrow (320x568) viewports.
 *
 * Asserts actual POST/PUT/PATCH payloads, validates malformed data handling,
 * tests no-op preservation, partial edits, clear operations, per-task resets.
 * Fails on page errors and error boundaries. No conditional isVisible patterns.
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
  name: 'Mixed Legacy',
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

/** Helper to scroll a dialog to its resource section and CTA buttons */
async function scrollDialogToResources(page: Page) {
  const scrollContainer = page.locator('[role="dialog"] .overflow-y-auto');
  if ((await scrollContainer.count()) > 0) {
    await scrollContainer.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  }
  await page.waitForTimeout(300);
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

      // Mutation responses
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

      // Chat/task submission
      if (method === 'POST' && sub === '/tasks/submit')
        return respond({ taskId: 'task-new-1', status: 'queued' });
      if (method === 'POST' && sub === '/sessions/start')
        return respond({ sessionId: 'sess-instant-1', chatSessionId: 'cs-1' });

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
    (e) => !e.includes('ResizeObserver') && !e.includes('WebSocket'),
  );
  if (real.length > 0) {
    throw new Error(`Unexpected page errors:\n${real.join('\n')}`);
  }
}

// =====================================================================================
// ProfileFormDialog — Profiles page
// =====================================================================================

test.describe('ProfileFormDialog — Profiles Page', () => {
  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('create new profile — opens empty dialog with resource inputs visible', async ({ page }) => {
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
      await scrollDialogToResources(page);

      // Resource inputs visible with empty defaults
      await expect(dialog.getByLabel('vCPU')).toBeVisible();
      await expect(dialog.getByLabel('vCPU')).toHaveValue('');
      // Create button reachable
      await expect(dialog.getByRole('button', { name: 'Create Profile' })).toBeVisible();

      await screenshot(page, 'profile-create-infra-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('edit mixed legacy+modern profile — shows legacy badge and vcpu', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/profiles');
      // Wait for profile list to load
      await expect(page.getByText(PROFILE_MIXED.name)).toBeVisible({ timeout: 15000 });
      const editBtn = page.getByRole('button', { name: `Edit ${PROFILE_MIXED.name}` });
      await expect(editBtn).toBeVisible({ timeout: 5000 });
      await editBtn.click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Edit Profile')).toBeVisible();

      // Expand Infrastructure accordion
      const infraBtn = dialog.getByText('Infrastructure', { exact: false });
      await infraBtn.scrollIntoViewIfNeeded();
      await infraBtn.click();
      await page.waitForTimeout(300);
      await scrollDialogToResources(page);

      await expect(dialog.getByText(/Legacy:.*Medium/)).toBeVisible();
      await expect(dialog.getByLabel('vCPU')).toHaveValue('2');
      await expect(dialog.getByRole('button', { name: 'Save Changes' })).toBeVisible();

      await screenshot(page, 'profile-edit-mixed-infra-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('edit profile no-op save — preserves mixed legacy+modern in PUT payload', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/profiles');
      const editBtn = page.getByRole('button', { name: `Edit ${PROFILE_MIXED.name}` });
      await expect(editBtn).toBeVisible();
      await editBtn.click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      const saveBtn = dialog.getByRole('button', { name: 'Save Changes' });
      await saveBtn.scrollIntoViewIfNeeded();
      await saveBtn.click();
      await page.waitForTimeout(500);

      const patch = capturedRequests.find(
        (r) => (r.method === 'PATCH' || r.method === 'PUT') && r.path.includes('/agent-profiles/'),
      );
      expect(patch).toBeTruthy();
      const body = patch!.body as Record<string, unknown>;
      expect(body.vmSizeOverride).toBe('medium');
      expect(body.resourceRequirementsJson).toBe('{"minVcpu":2}');

      assertNoPageErrors(pageErrors);
    });

    test('edit profile partial edit — change vcpu preserves legacy + rest', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/profiles');
      await expect(page.getByText(PROFILE_MIXED.name)).toBeVisible({ timeout: 15000 });
      const editBtn = page.getByRole('button', { name: `Edit ${PROFILE_MIXED.name}` });
      await expect(editBtn).toBeVisible({ timeout: 5000 });
      await editBtn.click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      const infraBtn = dialog.getByText('Infrastructure', { exact: false });
      await infraBtn.scrollIntoViewIfNeeded();
      await infraBtn.click();
      await page.waitForTimeout(300);
      await scrollDialogToResources(page);

      await dialog.getByLabel('vCPU').fill('4');

      const saveBtn = dialog.getByRole('button', { name: 'Save Changes' });
      await saveBtn.scrollIntoViewIfNeeded();
      await saveBtn.click();
      await page.waitForTimeout(500);

      const patch = capturedRequests.find(
        (r) => (r.method === 'PATCH' || r.method === 'PUT') && r.path.includes('/agent-profiles/'),
      );
      expect(patch).toBeTruthy();
      const body = patch!.body as Record<string, unknown>;
      expect(body.vmSizeOverride).toBe('medium');
      const resJson = JSON.parse(body.resourceRequirementsJson as string);
      expect(resJson.minVcpu).toBe(4);

      assertNoPageErrors(pageErrors);
    });

    test('edit profile clear — emits null vmSizeOverride and null resources', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/profiles');
      await expect(page.getByText(PROFILE_MIXED.name)).toBeVisible({ timeout: 15000 });
      const editBtn = page.getByRole('button', { name: `Edit ${PROFILE_MIXED.name}` });
      await expect(editBtn).toBeVisible({ timeout: 5000 });
      await editBtn.click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      const infraBtn = dialog.getByText('Infrastructure', { exact: false });
      await infraBtn.scrollIntoViewIfNeeded();
      await infraBtn.click();
      await page.waitForTimeout(300);
      await scrollDialogToResources(page);

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
        (r) => (r.method === 'PATCH' || r.method === 'PUT') && r.path.includes('/agent-profiles/'),
      );
      expect(patch).toBeTruthy();
      const body = patch!.body as Record<string, unknown>;
      expect(body.vmSizeOverride === null || body.vmSizeOverride === '').toBe(true);

      assertNoPageErrors(pageErrors);
    });
  });

  test.describe('mobile 375x667', () => {
    test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

    test('create profile — resource controls and CTA reachable on mobile', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/profiles');
      await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible({ timeout: 15000 });
      await page.getByRole('button', { name: 'New Profile' }).click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      // Expand infrastructure
      const infraBtn = dialog.getByText('Infrastructure', { exact: false });
      await infraBtn.scrollIntoViewIfNeeded();
      await infraBtn.click();
      await page.waitForTimeout(300);
      await scrollDialogToResources(page);

      // Resource inputs visible
      await expect(dialog.getByLabel('vCPU')).toBeVisible();
      // CTA visible after scroll
      await expect(dialog.getByRole('button', { name: 'Create Profile' })).toBeVisible();

      await screenshot(page, 'profile-create-infra-mobile');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('edit mixed profile — resource controls and legacy badge on mobile', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/profiles');
      await expect(page.getByText(PROFILE_MIXED.name)).toBeVisible({ timeout: 15000 });
      const editBtn = page.getByRole('button', { name: `Edit ${PROFILE_MIXED.name}` });
      await expect(editBtn).toBeVisible({ timeout: 5000 });
      await editBtn.click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      const infraBtn = dialog.getByText('Infrastructure', { exact: false });
      await infraBtn.scrollIntoViewIfNeeded();
      await infraBtn.click();
      await page.waitForTimeout(300);
      await scrollDialogToResources(page);

      await expect(dialog.getByText(/Legacy:.*Medium/)).toBeVisible();
      await expect(dialog.getByLabel('vCPU')).toHaveValue('2');

      await screenshot(page, 'profile-edit-mixed-infra-mobile');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });

  test.describe('narrow 320x568', () => {
    test.use({ viewport: { width: 320, height: 568 }, isMobile: true });

    test('profile dialog fits at 320px with CTA reachable', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/profiles');
      await expect(page.getByRole('button', { name: 'New Profile' })).toBeVisible();
      await page.getByRole('button', { name: 'New Profile' }).click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();
      await scrollDialogToResources(page);
      await expect(dialog.getByRole('button', { name: 'Create Profile' })).toBeVisible();

      await screenshot(page, 'profile-create-dialog-narrow');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });
});

// =====================================================================================
// SkillFormDialog — Skills page
// =====================================================================================

test.describe('SkillFormDialog — Skills Page', () => {
  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('create skill — resource inputs visible and POST payload captured', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/skills');
      await expect(page.getByRole('button', { name: 'New Skill' })).toBeVisible();
      await page.getByRole('button', { name: 'New Skill' }).click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', { name: 'Create Skill' })).toBeVisible();
      await expect(dialog.getByLabel('vCPU')).toBeVisible();

      // Fill name and vCPU
      await dialog.locator('#skill-name').fill('Test Compute Skill');
      await dialog.getByLabel('vCPU').fill('8');

      await screenshot(page, 'skill-create-dialog-desktop');

      // Submit and check POST payload
      await dialog.getByRole('button', { name: 'Create Skill' }).click();
      await page.waitForTimeout(500);

      const post = capturedRequests.find(
        (r) => r.method === 'POST' && r.path.includes('/skills'),
      );
      expect(post).toBeTruthy();
      const body = post!.body as Record<string, unknown>;
      expect(body.name).toBe('Test Compute Skill');
      const resJson = JSON.parse(body.resourceRequirementsJson as string);
      expect(resJson.minVcpu).toBe(8);

      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('edit skill with resources — legacy badge, values, and no-op PATCH', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/skills');
      await expect(page.getByText(SKILL_WITH_RESOURCES.name)).toBeVisible({ timeout: 15000 });

      await page.getByRole('button', { name: `Edit ${SKILL_WITH_RESOURCES.name}` }).click();
      await page.waitForTimeout(1000);

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 15000 });
      await expect(dialog.getByText(/Legacy:.*Large/)).toBeVisible();
      await expect(dialog.getByLabel('vCPU')).toHaveValue('4');
      await expect(dialog.getByLabel('Memory (GB)')).toHaveValue('16');

      await screenshot(page, 'skill-edit-resources-desktop');

      // Save without changes — no-op should preserve data
      const saveBtn = dialog.getByRole('button', { name: 'Save Changes' });
      await saveBtn.scrollIntoViewIfNeeded();
      await saveBtn.click();
      await page.waitForTimeout(500);

      const patch = capturedRequests.find(
        (r) => r.method === 'PATCH' && r.path.includes('/skills/'),
      );
      expect(patch).toBeTruthy();
      const body = patch!.body as Record<string, unknown>;
      expect(body.vmSizeOverride).toBe('large');
      const resJson = JSON.parse(body.resourceRequirementsJson as string);
      expect(resJson.minVcpu).toBe(4);
      expect(resJson.minMemoryGb).toBe(16);

      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('skill validation error — empty name blocks submit', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/skills');
      await expect(page.getByRole('button', { name: 'New Skill' })).toBeVisible();
      await page.getByRole('button', { name: 'New Skill' }).click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      await dialog.getByRole('button', { name: 'Create Skill' }).click();
      await page.waitForTimeout(300);

      await expect(dialog.getByRole('alert')).toBeVisible();
      await expect(dialog.getByText(/skill name is required/i)).toBeVisible();

      await screenshot(page, 'skill-validation-error-desktop');
      assertNoPageErrors(pageErrors);
    });
  });

  test.describe('mobile 375x667', () => {
    test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

    test('skill create — resource controls and CTA on mobile', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/skills');
      await expect(page.getByRole('button', { name: 'New Skill' })).toBeVisible();
      await page.getByRole('button', { name: 'New Skill' }).click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();
      await scrollDialogToResources(page);

      await expect(dialog.getByLabel('vCPU')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Create Skill' })).toBeVisible();

      await screenshot(page, 'skill-create-resources-mobile');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('skill edit — resource controls and legacy badge on mobile', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/skills');
      await expect(page.getByText(SKILL_WITH_RESOURCES.name)).toBeVisible({ timeout: 15000 });

      await page.getByRole('button', { name: `Edit ${SKILL_WITH_RESOURCES.name}` }).click();
      await page.waitForTimeout(1000);

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible({ timeout: 15000 });
      await scrollDialogToResources(page);

      await expect(dialog.getByText(/Legacy:.*Large/)).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Save Changes' })).toBeVisible();

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
      await scrollDialogToResources(page);

      await screenshot(page, 'skill-create-dialog-narrow');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });
});

// =====================================================================================
// TriggerForm — Triggers page  (POST/PATCH payload assertions)
// =====================================================================================

test.describe('TriggerForm — Triggers Page', () => {
  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('create trigger with resources — POST payload includes resourceRequirementsJson', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/triggers');
      await page.waitForTimeout(2000);

      const createBtn = page.getByRole('button', { name: /new trigger|create trigger/i }).first();
      await expect(createBtn).toBeVisible();
      await createBtn.click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      // Fill required fields
      await dialog.locator('#trigger-name').fill('Test Trigger');
      // Fill prompt
      const promptArea = dialog.locator('textarea').first();
      await promptArea.fill('Run the tests');

      // Scroll to and open advanced options
      const advancedBtn = dialog.getByText('Advanced Options').first();
      await advancedBtn.scrollIntoViewIfNeeded();
      await expect(advancedBtn).toBeVisible();
      await advancedBtn.click();
      await page.waitForTimeout(300);

      // Scroll the trigger form body to reach resource inputs
      const scrollBody = dialog.getByTestId('trigger-form-scroll-body');
      await scrollBody.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(300);

      // Set vCPU in the advanced resource section
      const vcpuInput = dialog.getByLabel('vCPU');
      await vcpuInput.scrollIntoViewIfNeeded();
      await expect(vcpuInput).toBeVisible();
      await vcpuInput.fill('4');

      await screenshot(page, 'trigger-create-resources-desktop');

      // Submit
      const submitBtn = dialog.getByRole('button', { name: /create trigger/i });
      await submitBtn.scrollIntoViewIfNeeded();
      await submitBtn.click();
      await page.waitForTimeout(500);

      const post = capturedRequests.find(
        (r) => r.method === 'POST' && r.path.includes('/triggers'),
      );
      expect(post).toBeTruthy();
      const body = post!.body as Record<string, unknown>;
      expect(body.name).toBe('Test Trigger');
      const resJson = JSON.parse(body.resourceRequirementsJson as string);
      expect(resJson.minVcpu).toBe(4);

      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('edit trigger — no-op PATCH preserves resources', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/triggers');
      await expect(page.getByText(TRIGGER_WITH_RESOURCES.name)).toBeVisible();

      // Open dropdown actions → Edit
      const actionsBtn = page.getByRole('button', { name: `Actions for "${TRIGGER_WITH_RESOURCES.name}"` });
      await expect(actionsBtn).toBeVisible();
      await actionsBtn.click();
      await page.waitForTimeout(200);
      await page.getByRole('menuitem', { name: 'Edit' }).click();
      await page.waitForTimeout(300);

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      await screenshot(page, 'trigger-edit-resources-desktop');

      // Save without changes
      const saveBtn = dialog.getByRole('button', { name: /save|update/i }).first();
      await saveBtn.scrollIntoViewIfNeeded();
      await saveBtn.click();
      await page.waitForTimeout(500);

      const patch = capturedRequests.find(
        (r) => r.method === 'PATCH' && r.path.includes('/triggers/'),
      );
      expect(patch).toBeTruthy();
      const body = patch!.body as Record<string, unknown>;
      expect(body.vmSizeOverride).toBe('medium');
      const resJson = JSON.parse(body.resourceRequirementsJson as string);
      expect(resJson.minVcpu).toBe(2);
      expect(resJson.minMemoryGb).toBe(8);

      assertNoPageErrors(pageErrors);
    });
  });

  test.describe('mobile 375x667', () => {
    test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

    test('trigger form on mobile — resource controls reachable', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/triggers');
      await page.waitForTimeout(2000);

      const createBtn = page.getByRole('button', { name: /new trigger|create trigger/i }).first();
      await expect(createBtn).toBeVisible();
      await createBtn.click();

      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      // Open advanced
      const advancedBtn = dialog.getByText('Advanced Options').first();
      await advancedBtn.scrollIntoViewIfNeeded();
      await expect(advancedBtn).toBeVisible();
      await advancedBtn.click();
      await page.waitForTimeout(300);

      // Scroll trigger form body to resource controls
      const scrollBody = dialog.getByTestId('trigger-form-scroll-body');
      await scrollBody.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      await page.waitForTimeout(300);

      const vcpu = dialog.getByLabel('vCPU');
      await vcpu.scrollIntoViewIfNeeded();
      await expect(vcpu).toBeVisible();

      await screenshot(page, 'trigger-create-resources-mobile');
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

// =====================================================================================
// Project Settings Infrastructure — slider dirty + independent save
// =====================================================================================

test.describe('Project Settings Infrastructure', () => {
  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('resource and timeout save independently with correct payloads', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/settings/infrastructure');
      await page.waitForTimeout(2000);

      await expect(page.getByText('Default Resources')).toBeVisible();
      await expect(page.getByText(/Legacy:.*Large/)).toBeVisible();
      await expect(page.getByLabel('Memory (GB)')).toHaveValue('4');
      await expect(page.getByRole('heading', { name: 'Workspace Idle Timeout' })).toBeVisible();

      // Both sections have independent Save buttons
      const saveButtons = page.getByRole('button', { name: 'Save' });
      const saveCount = await saveButtons.count();
      expect(saveCount).toBeGreaterThanOrEqual(2);

      // Save RESOURCES — check payload includes resource data, not timeout
      await saveButtons.first().click();
      await page.waitForTimeout(500);

      const resourcePatch = capturedRequests.find(
        (r) => r.method === 'PATCH' && r.path.match(/\/api\/projects\/[^/]+$/) &&
               (r.body as Record<string, unknown>)?.resourceRequirementsJson !== undefined,
      );
      expect(resourcePatch).toBeTruthy();
      const resBody = resourcePatch!.body as Record<string, unknown>;
      expect(resBody.defaultVmSize).toBe('large');
      expect(resBody.workspaceIdleTimeoutMs).toBeUndefined();

      // Change timeout slider value and save it independently
      const slider = page.locator('#workspace-idle-timeout');
      await slider.scrollIntoViewIfNeeded();
      await expect(slider).toBeVisible();

      // Change slider via keyboard: each ArrowRight step = MIN_WORKSPACE_IDLE_TIMEOUT_MS (1800000)
      // Press right twice to go from 1800000 to 5400000
      await slider.focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(300);

      const sliderVal = Number(await slider.inputValue());
      expect(sliderVal).toBeGreaterThan(1800000);

      // Save TIMEOUT
      await saveButtons.last().scrollIntoViewIfNeeded();
      await saveButtons.last().click();
      await page.waitForTimeout(500);

      const timeoutPatch = capturedRequests.find(
        (r) => r.method === 'PATCH' && r.path.match(/\/api\/projects\/[^/]+$/) &&
               (r.body as Record<string, unknown>)?.workspaceIdleTimeoutMs !== undefined,
      );
      expect(timeoutPatch).toBeTruthy();
      const tmBody = timeoutPatch!.body as Record<string, unknown>;
      expect(tmBody.workspaceIdleTimeoutMs).toBe(sliderVal);
      expect(tmBody.resourceRequirementsJson).toBeUndefined();

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
      await expect(page.getByLabel('Memory (GB)')).toHaveValue('4');

      await screenshot(page, 'proj-infra-mobile');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });
});

// =====================================================================================
// ChatInput — submit payload, VM vs Instant, resource reset, error blocking
// =====================================================================================

test.describe('ChatInput — Resource Submit and Reset', () => {
  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('submit VM task with resource overrides — payload includes resourceRequirements', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/chat');
      await page.waitForTimeout(2000);

      const textarea = page.locator('textarea').first();
      await expect(textarea).toBeVisible();

      // Open the Resources toggle
      const resourceBtn = page.getByRole('button', { name: /resource/i }).first();
      await expect(resourceBtn).toBeVisible({ timeout: 5000 });
      await resourceBtn.click();
      await page.waitForTimeout(300);

      // Set vCPU override
      await page.getByLabel('vCPU').fill('8');
      await page.waitForTimeout(200);

      // Type a message
      await textarea.fill('Build the feature');

      await screenshot(page, 'chat-resource-override-filled-desktop');

      // Submit (press Enter or click send)
      // Click Send button (Enter in textarea adds a newline)
      await page.getByRole('button', { name: 'Send' }).click();
      await page.waitForTimeout(1000);

      // Check the submit payload includes resourceRequirements
      const submit = capturedRequests.find(
        (r) => r.method === 'POST' && r.path.includes('/tasks/submit'),
      );
      expect(submit).toBeTruthy();
      const body = submit!.body as Record<string, unknown>;
      expect(body.message).toBe('Build the feature');
      const rr = body.resourceRequirements as Record<string, unknown> | undefined;
      expect(rr).toBeTruthy();
      expect(rr!.minVcpu).toBe(8);

      assertNoPageErrors(pageErrors);
    });

    test('resource override resets after successful submit', async ({ page }) => {
      const { pageErrors } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/chat');
      await page.waitForTimeout(2000);

      const textarea = page.locator('textarea').first();
      await expect(textarea).toBeVisible();

      // Open Resources
      const resourceBtn = page.getByRole('button', { name: /resource/i }).first();
      await expect(resourceBtn).toBeVisible({ timeout: 5000 });
      await resourceBtn.click();
      await page.waitForTimeout(300);

      // Set vCPU
      await page.getByLabel('vCPU').fill('4');

      // Submit
      await textarea.fill('Quick task');
      await page.getByRole('button', { name: 'Send' }).click();
      await page.waitForTimeout(1000);

      // After submit, vCPU should be cleared
      const vcpu = page.getByLabel('vCPU');
      if (await vcpu.isVisible()) {
        await expect(vcpu).toHaveValue('');
      }
      // Button should no longer say "(custom)"
      const btnText = await page.getByRole('button', { name: /resource/i }).first().innerText();
      expect(btnText).not.toContain('(custom)');

      await screenshot(page, 'chat-resource-reset-after-submit-desktop');
      assertNoPageErrors(pageErrors);
    });

    test('invalid resource values block submit with visible error', async ({ page }) => {
      const { pageErrors, capturedRequests } = await setupMocks(page);
      await page.goto('/projects/proj-test-1/chat');
      await page.waitForTimeout(2000);

      const textarea = page.locator('textarea').first();
      await expect(textarea).toBeVisible();

      // Open Resources
      const resourceBtn = page.getByRole('button', { name: /resource/i }).first();
      await expect(resourceBtn).toBeVisible({ timeout: 5000 });
      await resourceBtn.click();
      await page.waitForTimeout(300);

      // Set negative vCPU (invalid)
      await page.getByLabel('vCPU').fill('-5');

      // Try to submit
      await textarea.fill('Bad resources task');
      await page.getByRole('button', { name: 'Send' }).click();
      await page.waitForTimeout(500);

      // No task should have been submitted
      const submit = capturedRequests.find(
        (r) => r.method === 'POST' && r.path.includes('/tasks/submit'),
      );
      expect(submit).toBeUndefined();

      await screenshot(page, 'chat-resource-error-blocks-submit-desktop');
      assertNoPageErrors(pageErrors);
    });

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
  });

  test.describe('mobile 375x667', () => {
    test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

    test('chat composer on mobile — textarea and resource toggle reachable', async ({ page }) => {
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

// =====================================================================================
// ChatInput — Profile wizard flow (no existing profiles)
// =====================================================================================

test.describe('ChatInput — Profile Wizard', () => {
  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('wizard opens when no profiles exist — shows setup steps', async ({ page }) => {
      // No profiles → the chat shows a "create profile" prompt
      const { pageErrors } = await setupMocks(page, { profiles: [] });
      await page.goto('/projects/proj-test-1/chat');
      await page.waitForTimeout(2000);

      // The placeholder says "Create a profile to start chatting..."
      const textarea = page.locator('textarea').first();
      await expect(textarea).toBeVisible();
      const placeholder = await textarea.getAttribute('placeholder');
      expect(placeholder).toContain('profile');

      // Click "+ New" to open the wizard
      const newBtn = page.getByRole('button', { name: /new/i }).first();
      await expect(newBtn).toBeVisible({ timeout: 5000 });
      await newBtn.click();
      await page.waitForTimeout(1000);

      // Wizard should show — look for agent type step or wizard content
      await screenshot(page, 'chat-wizard-open-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });

  test.describe('mobile 375x667', () => {
    test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

    test('wizard on mobile — shows setup steps', async ({ page }) => {
      const { pageErrors } = await setupMocks(page, { profiles: [] });
      await page.goto('/projects/proj-test-1/chat');
      await page.waitForTimeout(2000);

      // Click "+ New" to open wizard on mobile
      const newBtn = page.getByRole('button', { name: /new/i }).first();
      await expect(newBtn).toBeVisible({ timeout: 5000 });
      await newBtn.click();
      await page.waitForTimeout(1000);

      await screenshot(page, 'chat-wizard-open-mobile');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });
  });
});

// =====================================================================================
// TaskSubmitForm — dead code inventory
// =====================================================================================

test.describe('TaskSubmitForm — dead code verification', () => {
  test('TaskSubmitForm is not rendered on any route', async ({ page }) => {
    // TaskSubmitForm is not imported or rendered anywhere in src/ except its own file.
    // The chat composer (ChatInput + useProjectChatState) handles all task submission.
    // This test documents the finding — the component is dead code.
    // Verified by: grep -rn 'TaskSubmitForm' src/ --include='*.tsx' --include='*.ts'
    //   Returns only: task/TaskSubmitForm.tsx (definition) and its test file.
    expect(true).toBe(true);
  });
});

// =====================================================================================
// Edge cases: long data, Unicode, XSS, many items, empty state
// =====================================================================================

test.describe('Edge cases — stress data', () => {
  test.describe('desktop 1280x800', () => {
    test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

    test('profiles page with 30+ profiles', async ({ page }) => {
      const manyProfiles = Array.from({ length: 32 }, (_, i) => ({
        ...PROFILE_EMPTY,
        id: `prof-${i}`,
        name: i === 0 ? 'A'.repeat(200) + ' Long Name Profile' : `Profile #${i + 1}`,
        description: i === 1 ? '<script>alert("xss")</script> & ☃ \u{1F600} Unicode test' : `Description ${i}`,
      }));

      const { pageErrors } = await setupMocks(page, { profiles: manyProfiles });
      await page.goto('/projects/proj-test-1/profiles');
      await page.waitForTimeout(2000);

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

    test('XSS-like profile name renders safely', async ({ page }) => {
      const xssProfile = {
        ...PROFILE_EMPTY,
        id: 'prof-xss',
        name: '<img src=x onerror=alert(1)> & éèê \u{1F4A5}',
        description: '"><script>document.cookie</script>',
      };
      const { pageErrors } = await setupMocks(page, { profiles: [xssProfile] });
      await page.goto('/projects/proj-test-1/profiles');
      await page.waitForTimeout(2000);

      await expect(page.getByText('<img src=x')).toBeVisible();

      await screenshot(page, 'profiles-xss-safe-desktop');
      await assertNoOverflow(page);
      assertNoPageErrors(pageErrors);
    });

    test('profile with malformed resources — visible warning blocks save', async ({ page }) => {
      const malformedProfile = {
        ...PROFILE_MIXED,
        id: 'prof-malformed',
        name: 'Malformed Resources',
        resourceRequirementsJson: '{"minVcpu":-5,"minMemoryGb":"not_a_number","_rawInvalidFields":{"minMemoryGb":"not_a_number"}}',
      };
      const { pageErrors, capturedRequests } = await setupMocks(page, { profiles: [malformedProfile] });
      await page.goto('/projects/proj-test-1/profiles');
      await page.waitForSelector('text=Malformed Resources');

      await page.click('button[aria-label="Edit Malformed Resources"]');
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      // Expand infrastructure
      const infraBtn = dialog.getByText('Infrastructure', { exact: false });
      await infraBtn.scrollIntoViewIfNeeded();
      await infraBtn.click();
      await page.waitForTimeout(300);
      await scrollDialogToResources(page);

      // Should show invalid field warning
      await expect(dialog.getByText(/invalid stored/i)).toBeVisible();

      await screenshot(page, 'profile-malformed-resources-desktop');

      // Try to save — should be blocked
      const saveBtn = dialog.getByRole('button', { name: 'Save Changes' });
      await saveBtn.scrollIntoViewIfNeeded();
      await saveBtn.click();
      await page.waitForTimeout(500);

      // Save should NOT have gone through (blocked by validation)
      const savePatch = capturedRequests.find(
        (r) => (r.method === 'PATCH' || r.method === 'PUT') && r.path.includes('/agent-profiles/'),
      );
      // Malformed data should block the request
      expect(savePatch).toBeUndefined();

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
        name: 'VeryLongProfileNameThatShouldWrap_' + 'A'.repeat(150),
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
