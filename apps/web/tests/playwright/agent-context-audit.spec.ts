/**
 * Agent Context Page UI Audit
 * Covers: overview tab, memory tab, policies tab, actions tab, empty states, long text
 * Viewports: iPhone SE 375x667 (mobile), Desktop 1280x800
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'test@example.com',
  name: 'Test User',
  sessionId: 'session-1',
  userId: 'user-1',
});

const MOCK_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  repository: 'testuser/test-repo',
  defaultBranch: 'main',
  userId: 'user-1',
  githubInstallationId: 'inst-1',
  defaultVmSize: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function makeEntity(overrides: Partial<{ id: string; name: string; entityType: string; description: string | null; observationCount: number }> = {}) {
  return {
    id: overrides.id ?? 'entity-1',
    projectId: 'proj-1',
    name: overrides.name ?? 'CodeStyle',
    entityType: overrides.entityType ?? 'preference',
    description: overrides.description ?? 'Prefers concise code.',
    observationCount: overrides.observationCount ?? 3,
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
  };
}

function makeObservation(overrides: Partial<{ id: string; entityId: string; content: string; confidence: number; sourceType: string }> = {}) {
  return {
    id: overrides.id ?? 'obs-1',
    entityId: overrides.entityId ?? 'e1',
    content: overrides.content ?? 'Prefers focused implementation notes with direct evidence.',
    confidence: overrides.confidence ?? 0.92,
    sourceType: overrides.sourceType ?? 'explicit',
    sourceSessionId: null,
    createdAt: Date.now() - 86400000,
    lastConfirmedAt: Date.now(),
    supersededBy: null,
    isActive: true,
  };
}

function makePolicy(overrides: Partial<{ id: string; category: string; title: string; content: string; active: boolean; confidence: number; source: string }> = {}) {
  return {
    id: overrides.id ?? 'pol-1',
    category: overrides.category ?? 'rule',
    title: overrides.title ?? 'Always run tests',
    content: overrides.content ?? 'Before merging any PR, run the full test suite.',
    active: overrides.active ?? true,
    confidence: overrides.confidence ?? 0.9,
    source: overrides.source ?? 'explicit',
    sourceSessionId: null,
    createdAt: Date.now() - 86400000,
    updatedAt: Date.now(),
  };
}

function makeActivity(overrides: Partial<{ id: string; eventType: string; actorType: string; payload: Record<string, unknown> | null }> = {}) {
  return {
    id: overrides.id ?? 'act-1',
    eventType: overrides.eventType ?? 'task.completed',
    actorType: overrides.actorType ?? 'agent',
    actorId: 'agent-1',
    workspaceId: null,
    sessionId: null,
    taskId: null,
    payload: overrides.payload ?? { summary: 'Task completed successfully' },
    createdAt: Date.now(),
  };
}

const NORMAL_ENTITIES = [
  makeEntity({ id: 'e1', name: 'CodeStyle', entityType: 'preference', observationCount: 5 }),
  makeEntity({ id: 'e2', name: 'ProjectArchitecture', entityType: 'context', observationCount: 8 }),
  makeEntity({ id: 'e3', name: 'DeployWorkflow', entityType: 'workflow', observationCount: 3 }),
];

const LONG_TEXT_ENTITIES = [
  makeEntity({ id: 'e-long', name: 'A'.repeat(200), entityType: 'custom', description: 'B'.repeat(500), observationCount: 99 }),
];

const MANY_ENTITIES = Array.from({ length: 30 }, (_, i) =>
  makeEntity({ id: `e${i}`, name: `Entity${i}`, entityType: i % 2 === 0 ? 'preference' : 'context', observationCount: i }),
);

const NORMAL_POLICIES = [
  makePolicy({ id: 'p1', category: 'rule', title: 'Always run tests' }),
  makePolicy({ id: 'p2', category: 'constraint', title: 'No hardcoded URLs', active: true, confidence: 0.95 }),
  makePolicy({ id: 'p3', category: 'preference', title: 'Prefer concise code', active: false, confidence: 0.7 }),
];

const NORMAL_OBSERVATIONS = [
  makeObservation({ id: 'o1', entityId: 'e1' }),
  makeObservation({ id: 'o2', entityId: 'e1', content: 'A'.repeat(240), confidence: 0.81, sourceType: 'behavioral' }),
];

const NORMAL_ACTIONS = [
  makeActivity({ id: 'a1', eventType: 'task.completed', actorType: 'agent' }),
  makeActivity({ id: 'a2', eventType: 'knowledge.created', actorType: 'system' }),
  makeActivity({ id: 'a3', eventType: 'error.reported', actorType: 'agent', payload: { summary: 'Build failed' } }),
];

type CapturedRequest = { method: string; path: string; body: unknown };

async function setupMocks(page: Page, opts: {
  entities?: ReturnType<typeof makeEntity>[];
  policies?: ReturnType<typeof makePolicy>[];
  actions?: ReturnType<typeof makeActivity>[];
  observations?: ReturnType<typeof makeObservation>[];
  requests?: CapturedRequest[];
} = {}) {
  const entities = opts.entities ?? NORMAL_ENTITIES;
  const policies = opts.policies ?? NORMAL_POLICIES;
  const actions = opts.actions ?? NORMAL_ACTIONS;
  const observations = opts.observations ?? NORMAL_OBSERVATIONS;

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    const path = new URL(url).pathname;
    const method = route.request().method();
    if (opts.requests && (method === 'PATCH' || method === 'DELETE')) {
      opts.requests.push({ method, path, body: route.request().postDataJSON() ?? null });
    }

    // Auth — catch all auth endpoints
    if (path.includes('/api/auth/')) {
      return route.fulfill({ json: MOCK_USER });
    }

    // Dashboard
    if (path === '/api/dashboard/active-tasks') {
      return route.fulfill({ json: { tasks: [] } });
    }

    // GitHub installations
    if (path === '/api/github/installations') {
      return route.fulfill({ json: [] });
    }

    // Notifications
    if (path.startsWith('/api/notifications')) {
      return route.fulfill({ json: { notifications: [], unreadCount: 0, count: 0 } });
    }

    // Agents
    if (path === '/api/agents') {
      return route.fulfill({ json: [] });
    }

    // Credentials
    if (path.startsWith('/api/credentials')) {
      return route.fulfill({ json: { credentials: [] } });
    }

    // Project-scoped routes
    if (path === '/api/projects/proj-1/knowledge/e1') {
      return route.fulfill({ json: { entity: { ...entities[0], observations, relations: [] }, observations, relations: [] } });
    }
    if (path.includes('/api/projects/proj-1/knowledge/observations/')) {
      return route.fulfill({ json: method === 'DELETE' ? { removed: true } : { updated: true } });
    }
    if (path.includes('/api/projects/proj-1/knowledge/') && method === 'PATCH') {
      return route.fulfill({ json: { updated: true } });
    }
    if (path.includes('/api/projects/proj-1/knowledge/') && method === 'DELETE') {
      return route.fulfill({ json: { deleted: true } });
    }
    if (path.includes('/api/projects/proj-1/knowledge') && !path.includes('search')) {
      return route.fulfill({ json: { entities, total: entities.length } });
    }
    if (path.includes('/api/projects/proj-1/policies/') && method === 'PATCH') {
      return route.fulfill({ json: { updated: true, policyId: path.split('/').pop() } });
    }
    if (path.includes('/api/projects/proj-1/policies/') && method === 'DELETE') {
      return route.fulfill({ json: { removed: true, policyId: path.split('/').pop() } });
    }
    if (path.includes('/api/projects/proj-1/policies')) {
      return route.fulfill({ json: { policies, total: policies.length } });
    }
    if (path.includes('/api/projects/proj-1/activity')) {
      return route.fulfill({ json: { events: actions, hasMore: false } });
    }
    if (path.includes('/api/projects/proj-1/sessions')) {
      return route.fulfill({ json: { sessions: [], total: 0 } });
    }
    if (path.includes('/api/projects/proj-1/runtime-config')) {
      return route.fulfill({ json: { envVars: [], files: [] } });
    }
    if (path.includes('/api/projects/proj-1')) {
      return route.fulfill({ json: MOCK_PROJECT });
    }
    if (path.startsWith('/api/projects')) {
      return route.fulfill({ json: { projects: [MOCK_PROJECT], total: 1 } });
    }

    // Workspaces
    if (path.startsWith('/api/workspaces')) {
      return route.fulfill({ json: [] });
    }

    return route.fulfill({ json: {} });
  });
}

test.describe('Agent Context — Mobile', () => {
  test('overview tab renders', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-1/agent-context');
    await expect(page.getByText('Memory entities')).toBeVisible();
    await expect(page.getByText('Active policies')).toBeVisible();
    await screenshot(page, 'agent-context-overview-mobile');
    await assertNoOverflow(page);
  });

  test('memory tab expands and exposes management controls', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-1/agent-context');
    await page.click('button:has-text("Memory")');
    await page.getByRole('button', { name: /CodeStyle/ }).click();
    await expect(page.getByText('Prefers focused implementation notes')).toBeVisible();
    await page.getByRole('button', { name: 'Edit memory entity' }).first().click();
    await expect(page.getByLabel('Name')).toBeVisible();
    await screenshot(page, 'agent-context-memory-expanded-edit-mobile');
    await assertNoOverflow(page);
  });

  test('memory delete confirmation uses blurred dialog', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-1/agent-context');
    await page.click('button:has-text("Memory")');
    await page.getByRole('button', { name: 'Delete memory entity' }).first().click();
    await expect(page.getByRole('alertdialog', { name: 'Delete entity' })).toBeVisible();
    await screenshot(page, 'agent-context-memory-delete-dialog-mobile');
    await assertNoOverflow(page);
  });

  test('policies tab edits and confirms deletes', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-1/agent-context');
    await page.click('button:has-text("Policies")');
    await expect(page.getByText('Always run tests')).toBeVisible();
    await page.getByRole('button', { name: 'Edit policy' }).first().click();
    await expect(page.getByLabel('Title')).toBeVisible();
    await screenshot(page, 'agent-context-policy-edit-mobile');
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Delete policy' }).first().click();
    await expect(page.getByRole('alertdialog', { name: 'Delete policy' })).toBeVisible();
    await screenshot(page, 'agent-context-policy-delete-dialog-mobile');
    await assertNoOverflow(page);
  });


  test('management actions submit mutation requests', async ({ page }) => {
    const requests: CapturedRequest[] = [];
    await setupMocks(page, { requests });
    await page.goto('/projects/proj-1/agent-context');

    await page.click('button:has-text("Memory")');
    await page.getByRole('button', { name: 'Edit memory entity' }).first().click();
    await page.getByLabel('Name').fill('Updated Memory');
    await page.getByLabel('Description').fill('Updated memory description');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => requests.some((request) => request.method === 'PATCH' && request.path === '/api/projects/proj-1/knowledge/e1')).toBe(true);

    await page.getByRole('button', { name: /CodeStyle/ }).click();
    await page.getByRole('button', { name: 'Edit observation' }).first().click();
    await page.getByRole('textbox', { name: 'Observation' }).fill('Updated observation content');
    await page.getByRole('spinbutton', { name: 'Confidence' }).fill('77');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => requests.some((request) => request.method === 'PATCH' && request.path === '/api/projects/proj-1/knowledge/observations/o1')).toBe(true);

    await page.getByRole('button', { name: 'Delete observation' }).first().click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => requests.some((request) => request.method === 'DELETE' && request.path.includes('/api/projects/proj-1/knowledge/observations/'))).toBe(true);

    await page.click('button:has-text("Policies")');
    await page.getByRole('button', { name: 'Edit policy' }).first().click();
    await page.getByLabel('Title').fill('Updated policy');
    await page.getByLabel('Content').fill('Updated policy content');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => requests.some((request) => request.method === 'PATCH' && request.path === '/api/projects/proj-1/policies/p1')).toBe(true);

    await page.getByRole('button', { name: 'Delete policy' }).first().click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect.poll(() => requests.some((request) => request.method === 'DELETE' && request.path === '/api/projects/proj-1/policies/p1')).toBe(true);

    expect(requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'PATCH',
        path: '/api/projects/proj-1/knowledge/e1',
        body: expect.objectContaining({ name: 'Updated Memory', description: 'Updated memory description' }),
      }),
      expect.objectContaining({
        method: 'PATCH',
        path: '/api/projects/proj-1/knowledge/observations/o1',
        body: expect.objectContaining({ content: 'Updated observation content', confidence: 0.77 }),
      }),
      expect.objectContaining({
        method: 'PATCH',
        path: '/api/projects/proj-1/policies/p1',
        body: expect.objectContaining({ title: 'Updated policy', content: 'Updated policy content' }),
      }),
    ]));
    await assertNoOverflow(page);
  });

  test('actions tab with normal data', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-1/agent-context');
    await page.click('button:has-text("Agent actions")');
    await expect(page.getByText('task.completed')).toBeVisible();
    await expect(page.getByText('Build failed')).toBeVisible();
    await screenshot(page, 'agent-context-actions-mobile');
    await assertNoOverflow(page);
  });

  test('empty state', async ({ page }) => {
    await setupMocks(page, { entities: [], policies: [], actions: [] });
    await page.goto('/projects/proj-1/agent-context');
    await page.click('button:has-text("Memory")');
    await expect(page.getByText('No data yet.')).toBeVisible();
    await screenshot(page, 'agent-context-empty-mobile');
    await assertNoOverflow(page);
  });

  test('/knowledge redirects to /agent-context', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-1/knowledge');
    await page.waitForURL('**/projects/proj-1/agent-context');
    await expect(page.getByText('Memory entities')).toBeVisible();
  });

  test('long text wraps correctly', async ({ page }) => {
    await setupMocks(page, { entities: LONG_TEXT_ENTITIES });
    await page.goto('/projects/proj-1/agent-context');
    await page.click('button:has-text("Memory")');
    await screenshot(page, 'agent-context-long-text-mobile');
    await assertNoOverflow(page);
  });
});

test.describe('Agent Context — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('overview tab renders', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-1/agent-context');
    await screenshot(page, 'agent-context-overview-desktop');
    await assertNoOverflow(page);
  });

  test('memory tab with many items', async ({ page }) => {
    await setupMocks(page, { entities: MANY_ENTITIES });
    await page.goto('/projects/proj-1/agent-context');
    await page.click('button:has-text("Memory")');
    await screenshot(page, 'agent-context-many-items-desktop');
    await assertNoOverflow(page);
  });

  test('memory expanded state', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-1/agent-context');
    await page.click('button:has-text("Memory")');
    await page.getByRole('button', { name: /CodeStyle/ }).click();
    await expect(page.getByText('Prefers focused implementation notes')).toBeVisible();
    await screenshot(page, 'agent-context-memory-expanded-desktop');
    await assertNoOverflow(page);
  });

  test('policies tab', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-1/agent-context');
    await page.click('button:has-text("Policies")');
    await screenshot(page, 'agent-context-policies-desktop');
    await assertNoOverflow(page);
  });
});
