/**
 * Agent Context Page UI Audit
 * Covers: overview tab, memory tab, policies tab, actions tab, empty states, long text
 * Viewports: iPhone SE 375x667 (mobile), Desktop 1280x800
 */
import { type Page, type Route, test } from '@playwright/test';

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

const NORMAL_ACTIONS = [
  makeActivity({ id: 'a1', eventType: 'task.completed', actorType: 'agent' }),
  makeActivity({ id: 'a2', eventType: 'knowledge.created', actorType: 'system' }),
  makeActivity({ id: 'a3', eventType: 'error.reported', actorType: 'agent', payload: { summary: 'Build failed' } }),
];

async function setupMocks(page: Page, opts: {
  entities?: ReturnType<typeof makeEntity>[];
  policies?: ReturnType<typeof makePolicy>[];
  actions?: ReturnType<typeof makeActivity>[];
} = {}) {
  const entities = opts.entities ?? NORMAL_ENTITIES;
  const policies = opts.policies ?? NORMAL_POLICIES;
  const actions = opts.actions ?? NORMAL_ACTIONS;

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    const path = new URL(url).pathname;

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
    if (path.includes('/api/projects/proj-1/knowledge') && !path.includes('search')) {
      return route.fulfill({ json: { entities, total: entities.length } });
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
    await screenshot(page, 'agent-context-overview-mobile');
    await assertNoOverflow(page);
  });

  test('memory tab with normal data', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-1/agent-context');
    await page.click('button:has-text("Memory")');
    await screenshot(page, 'agent-context-memory-mobile');
    await assertNoOverflow(page);
  });

  test('policies tab with normal data', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-1/agent-context');
    await page.click('button:has-text("Policies")');
    await screenshot(page, 'agent-context-policies-mobile');
    await assertNoOverflow(page);
  });

  test('actions tab with normal data', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-1/agent-context');
    await page.click('button:has-text("Agent actions")');
    await screenshot(page, 'agent-context-actions-mobile');
    await assertNoOverflow(page);
  });

  test('empty state', async ({ page }) => {
    await setupMocks(page, { entities: [], policies: [], actions: [] });
    await page.goto('/projects/proj-1/agent-context');
    await page.click('button:has-text("Memory")');
    await screenshot(page, 'agent-context-empty-mobile');
    await assertNoOverflow(page);
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

  test('policies tab', async ({ page }) => {
    await setupMocks(page);
    await page.goto('/projects/proj-1/agent-context');
    await page.click('button:has-text("Policies")');
    await screenshot(page, 'agent-context-policies-desktop');
    await assertNoOverflow(page);
  });
});
