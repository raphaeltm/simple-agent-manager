import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  role: 'superadmin',
  sessionId: 'session-skills-1',
  userId: 'user-skills-1',
});

const MOCK_PROJECT = {
  id: 'proj-skills-1',
  name: 'Skills Audit Project',
  repository: 'testuser/skills-audit',
  defaultBranch: 'main',
  userId: 'user-skills-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-05-31T00:00:00Z',
  updatedAt: '2026-05-31T00:00:00Z',
};

const PROFILES = [
  {
    id: 'profile-codex',
    projectId: MOCK_PROJECT.id,
    userId: MOCK_USER.user.id,
    name: 'Codex Implementer',
    description: 'Focused implementation profile.',
    agentType: 'openai-codex',
    model: null,
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    vmSizeOverride: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    devcontainerConfigName: null,
    taskMode: 'conversation',
    isBuiltin: false,
    createdAt: '2026-05-31T00:00:00Z',
    updatedAt: '2026-05-31T00:00:00Z',
  },
];

interface SkillOverrides {
  id: string;
  name: string;
  description?: string | null;
  vmSizeOverride?: string | null;
  resourceRequirementsJson?: string | null;
  defaultProfileId?: string | null;
}

function makeSkill(overrides: SkillOverrides) {
  return {
    projectId: MOCK_PROJECT.id,
    userId: MOCK_USER.user.id,
    agentType: null,
    model: null,
    permissionMode: null,
    systemPromptAppend: null,
    maxTurns: null,
    timeoutMinutes: null,
    provider: null,
    vmLocation: null,
    workspaceProfile: null,
    devcontainerConfigName: null,
    taskMode: 'task',
    isBuiltin: false,
    vmSizeOverride: overrides.vmSizeOverride ?? null,
    defaultProfileId: overrides.defaultProfileId ?? null,
    resourceRequirementsJson: overrides.resourceRequirementsJson ?? null,
    description: overrides.description ?? null,
    createdAt: '2026-05-31T00:00:00Z',
    updatedAt: '2026-05-31T00:00:00Z',
    ...overrides,
  };
}

const NORMAL_SKILLS = [
  makeSkill({
    id: 'skill-implementation',
    name: 'Implementation Sweep',
    description: 'Repeatable task setup for implementation, validation, and draft PR preparation.',
    vmSizeOverride: 'large',
    defaultProfileId: 'profile-codex',
    resourceRequirementsJson: '{"minVcpu":4,"minMemoryGb":8,"minDiskGb":64}',
  }),
  makeSkill({
    id: 'skill-review',
    name: 'Security Review',
    description: 'Review credential handling and auth-sensitive changes.',
    resourceRequirementsJson: '{"minVcpu":2,"minMemoryGb":4}',
  }),
];

const LONG_TEXT_SKILLS = [
  makeSkill({
    id: 'skill-long',
    name: 'This Is An Extremely Long Skill Name That Should Wrap Or Truncate Without Creating Horizontal Overflow In The Project Skills List',
    description:
      'This skill description contains unicode 日本語, symbols <script>alert("xss")</script>, and a very long URL https://example.com/some/really/long/path/that/should/not/break/the/layout/on/mobile/screens.',
    vmSizeOverride: 'large',
    resourceRequirementsJson: '{"minVcpu":16,"minMemoryGb":64,"minDiskGb":512}',
  }),
];

const MANY_SKILLS = Array.from({ length: 30 }, (_, index) =>
  makeSkill({
    id: `skill-${index}`,
    name: `Skill ${index + 1}: ${['Implementation', 'Review', 'Docs', 'Migration', 'Release'][index % 5]}`,
    description: index % 2 === 0 ? `Repeatable work definition ${index + 1}` : null,
    vmSizeOverride: index % 3 === 0 ? 'medium' : null,
    resourceRequirementsJson: index % 4 === 0 ? '{"minVcpu":2,"minMemoryGb":4}' : null,
  }),
);

async function setupApiMocks(
  page: Page,
  options: {
    skills?: ReturnType<typeof makeSkill>[];
    skillsError?: boolean;
  } = {},
) {
  const { skills = NORMAL_SKILLS, skillsError = false } = options;

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/projects') return respond(200, { projects: [MOCK_PROJECT], nextCursor: null });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path === '/api/github/installations') return respond(200, []);
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/agents') return respond(200, { agents: [] });

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)(\/.*)?$/);
    if (projectMatch) {
      const subPath = projectMatch[2] || '';
      if (subPath === '/agent-profiles') return respond(200, { items: PROFILES });
      if (subPath === '/skills') {
        if (skillsError) return respond(500, { error: 'INTERNAL_ERROR', message: 'Server error' });
        return respond(200, { items: skills });
      }
      if (subPath.includes('/runtime/env-vars')) return respond(200, { envVars: [] });
      if (subPath.includes('/runtime/files')) return respond(200, { files: [] });
      return respond(200, MOCK_PROJECT);
    }

    return respond(200, {});
  });
}

async function openSkillsPage(page: Page, options?: Parameters<typeof setupApiMocks>[1]) {
  await setupApiMocks(page, options);
  await page.goto(`/projects/${MOCK_PROJECT.id}/skills`);
}

test.describe('Skills List audit', () => {
  test('normal data captures mobile and desktop layouts', async ({ page }, testInfo) => {
    await openSkillsPage(page, { skills: NORMAL_SKILLS });
    await expect(page.getByText('Implementation Sweep')).toBeVisible();
    await expect(page.getByText('4 vCPU')).toBeVisible();
    await screenshot(page, `skills-list-normal-${testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    await assertNoOverflow(page);
  });

  test('long text stays contained', async ({ page }, testInfo) => {
    await openSkillsPage(page, { skills: LONG_TEXT_SKILLS });
    await expect(page.getByText(/This Is An Extremely Long Skill Name/)).toBeVisible();
    await screenshot(page, `skills-list-long-text-${testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    await assertNoOverflow(page);
  });

  test('empty state and create dialog fit the viewport', async ({ page }, testInfo) => {
    await openSkillsPage(page, { skills: [] });
    await expect(page.getByText('No skills yet')).toBeVisible();
    await page.getByRole('button', { name: 'New Skill' }).click();
    await expect(page.getByRole('heading', { name: 'Create Skill' })).toBeVisible();
    await page.getByLabel('Name').fill('Audit Skill');
    await page.getByLabel('Min vCPUs').fill('2');
    await page.getByLabel('Min Memory (GB)').fill('4');
    await screenshot(page, `skills-create-dialog-${testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    await assertNoOverflow(page);
  });

  test('many skills and delete confirmation remain scannable', async ({ page }, testInfo) => {
    await openSkillsPage(page, { skills: MANY_SKILLS });
    await expect(page.getByText('Skill 1: Implementation')).toBeVisible();
    await page.getByRole('button', { name: 'Delete Skill 1: Implementation' }).click();
    await expect(page.getByText('Delete this skill?')).toBeVisible();
    await screenshot(page, `skills-list-many-delete-${testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    await assertNoOverflow(page);
  });

  test('error state is visible without overflow', async ({ page }, testInfo) => {
    await openSkillsPage(page, { skillsError: true });
    await expect(page.locator('.text-danger')).toBeVisible();
    await screenshot(page, `skills-list-error-${testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`);
    await assertNoOverflow(page);
  });

  test('exclusive node checkbox disables max co-tenants', async ({ page }) => {
    await openSkillsPage(page, { skills: [] });
    await page.getByRole('button', { name: 'New Skill' }).click();
    await expect(page.getByRole('heading', { name: 'Create Skill' })).toBeVisible();

    const maxCoTenants = page.getByLabel('Max Co-tenants');
    const exclusiveNode = page.getByLabel('Exclusive Node');

    // Initially enabled with "Default" placeholder
    await expect(maxCoTenants).toBeEnabled();
    await maxCoTenants.fill('3');
    expect(await maxCoTenants.inputValue()).toBe('3');

    // Check exclusive node — max co-tenants becomes disabled and cleared
    await exclusiveNode.check();
    await expect(maxCoTenants).toBeDisabled();

    // Uncheck exclusive node — max co-tenants re-enabled
    await exclusiveNode.uncheck();
    await expect(maxCoTenants).toBeEnabled();
  });

  test('edit dialog populates structured fields from existing skill JSON', async ({ page }) => {
    await setupApiMocks(page, { skills: NORMAL_SKILLS });
    // Navigate directly with ?edit= param to open the edit dialog
    await page.goto(`/projects/${MOCK_PROJECT.id}/skills?edit=skill-implementation`);
    await expect(page.getByRole('heading', { name: 'Edit Skill' })).toBeVisible();
    // Wait for the edit form to populate (skill data loaded from props)
    await expect(page.getByLabel('Name')).toHaveValue('Implementation Sweep');

    // Verify deserialized field values from {"minVcpu":4,"minMemoryGb":8,"minDiskGb":64}
    expect(await page.getByLabel('Min vCPUs').inputValue()).toBe('4');
    expect(await page.getByLabel('Min Memory (GB)').inputValue()).toBe('8');
    expect(await page.getByLabel('Min Disk (GB)').inputValue()).toBe('64');
    await expect(page.getByLabel('Exclusive Node')).not.toBeChecked();
  });

  test('submit serializes structured fields to JSON and omits empty fields', async ({ page }) => {
    let capturedPayload: Record<string, unknown> | null = null;

    await setupApiMocks(page, { skills: [] });
    // Intercept skill creation API call to capture the payload
    await page.route('**/api/projects/*/skills', async (route) => {
      if (route.request().method() === 'POST') {
        capturedPayload = route.request().postDataJSON() as Record<string, unknown>;
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'new-skill', ...capturedPayload }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    });

    await page.goto(`/projects/${MOCK_PROJECT.id}/skills`);
    await page.getByRole('button', { name: 'New Skill' }).click();
    await expect(page.getByRole('heading', { name: 'Create Skill' })).toBeVisible();

    // Fill only some resource fields (leave Min Disk and Max Co-tenants empty)
    await page.getByLabel('Name').fill('Test Skill');
    await page.getByLabel('Min vCPUs').fill('2');
    await page.getByLabel('Min Memory (GB)').fill('4');
    // Min Disk left empty, Exclusive Node unchecked, Max Co-tenants left empty

    await page.getByRole('button', { name: 'Create Skill' }).click();

    // Wait for the API call to be captured
    await expect.poll(() => capturedPayload).not.toBeNull();

    // Verify the serialized JSON: only filled fields present, empty fields omitted
    const resourceJson = capturedPayload!.resourceRequirementsJson as string;
    expect(resourceJson).toBeTruthy();
    const parsed = JSON.parse(resourceJson);
    expect(parsed).toEqual({ minVcpu: 2, minMemoryGb: 4 });
    // Verify no extra keys (minDiskGb, exclusiveNode, maxCoTenants should be absent)
    expect(parsed).not.toHaveProperty('minDiskGb');
    expect(parsed).not.toHaveProperty('exclusiveNode');
    expect(parsed).not.toHaveProperty('maxCoTenants');
  });

  test('submit with exclusive node omits maxCoTenants from JSON', async ({ page }) => {
    let capturedPayload: Record<string, unknown> | null = null;

    await setupApiMocks(page, { skills: [] });
    await page.route('**/api/projects/*/skills', async (route) => {
      if (route.request().method() === 'POST') {
        capturedPayload = route.request().postDataJSON() as Record<string, unknown>;
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'new-skill', ...capturedPayload }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    });

    await page.goto(`/projects/${MOCK_PROJECT.id}/skills`);
    await page.getByRole('button', { name: 'New Skill' }).click();

    await page.getByLabel('Name').fill('Exclusive Skill');
    await page.getByLabel('Min vCPUs').fill('8');
    await page.getByLabel('Exclusive Node').check();

    await page.getByRole('button', { name: 'Create Skill' }).click();
    await expect.poll(() => capturedPayload).not.toBeNull();

    const parsed = JSON.parse(capturedPayload!.resourceRequirementsJson as string);
    expect(parsed).toEqual({ minVcpu: 8, exclusiveNode: true });
    expect(parsed).not.toHaveProperty('maxCoTenants');
  });

  test('submit with all fields empty sends null resourceRequirementsJson', async ({ page }) => {
    let capturedPayload: Record<string, unknown> | null = null;

    await setupApiMocks(page, { skills: [] });
    await page.route('**/api/projects/*/skills', async (route) => {
      if (route.request().method() === 'POST') {
        capturedPayload = route.request().postDataJSON() as Record<string, unknown>;
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: 'new-skill', ...capturedPayload }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) });
    });

    await page.goto(`/projects/${MOCK_PROJECT.id}/skills`);
    await page.getByRole('button', { name: 'New Skill' }).click();
    await page.getByLabel('Name').fill('Empty Resources Skill');
    // Leave all resource fields empty

    await page.getByRole('button', { name: 'Create Skill' }).click();
    await expect.poll(() => capturedPayload).not.toBeNull();

    // When all resource fields are empty, resourceRequirementsJson should be null
    expect(capturedPayload!.resourceRequirementsJson).toBeNull();
  });
});
