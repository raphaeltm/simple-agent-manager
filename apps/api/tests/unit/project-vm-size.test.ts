/**
 * Behavioral tests for project default VM size — API route handlers.
 *
 * Replaces source-contract tests that read route files as strings.
 * These tests invoke real Hono route handlers with mocked bindings
 * and verify request validation, response shape, and business logic.
 */
import { DEFAULT_VM_SIZE } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/index';
import { crudRoutes } from '../../src/routes/projects/crud';

// ---------------------------------------------------------------------------
// Module mocks — vi.mock factories are hoisted, so no external refs allowed
// ---------------------------------------------------------------------------

vi.mock('drizzle-orm/d1');

vi.mock('../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: any, next: any) => next()),
  requireApproved: () => vi.fn((_c: any, next: any) => next()),
  getUserId: () => 'user-123',
}));

vi.mock('../../src/middleware/project-auth', () => ({
  requireOwnedProject: vi.fn().mockResolvedValue({
    id: 'proj-1',
    userId: 'user-123',
    name: 'Test Project',
    normalizedName: 'test-project',
    description: null,
    repository: 'user/repo',
    installationId: 'inst-1',
    defaultBranch: 'main',
    defaultVmSize: null,
    defaultAgentType: null,
    defaultWorkspaceProfile: null,
    defaultProvider: null,
    defaultLocation: null,
    workspaceIdleTimeoutMs: null,
    nodeIdleTimeoutMs: null,
    taskExecutionTimeoutMs: null,
    maxConcurrentTasks: null,
    maxDispatchDepth: null,
    maxSubTasksPerTask: null,
    warmNodeTimeoutMs: null,
    maxWorkspacesPerNode: null,
    nodeCpuThresholdPercent: null,
    nodeMemoryThresholdPercent: null,
  }),
}));

vi.mock('../../src/routes/projects/_helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/routes/projects/_helpers')>();
  return {
    ...actual,
    requireOwnedInstallation: vi.fn().mockResolvedValue({ installationId: 'inst-1' }),
    assertRepositoryAccess: vi.fn().mockResolvedValue(undefined),
    buildProjectRuntimeConfigResponse: vi.fn().mockResolvedValue({
      runtimeEnvVars: [],
      runtimeFiles: [],
    }),
  };
});

vi.mock('../../src/services/encryption', () => ({
  encrypt: vi.fn().mockResolvedValue('encrypted'),
}));

vi.mock('../../src/services/limits', () => ({
  getRuntimeLimits: vi.fn().mockReturnValue({
    MAX_PROJECTS_PER_USER: 50,
    MAX_NODES_PER_USER: 10,
    MAX_WORKSPACES_PER_NODE: 5,
    MAX_TASKS_PER_PROJECT: 100,
  }),
}));

vi.mock('../../src/services/project-data', () => ({
  getProjectCounts: vi.fn().mockResolvedValue({
    taskCounts: {},
    sessionCount: 0,
    activityCount: 0,
    agentProfileCount: 0,
    ideaCount: 0,
  }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    const appError = err as { statusCode?: number; error?: string; message?: string };
    if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
      return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/projects', crudRoutes);
  return app;
}

/** Default project row returned by mock DB queries. */
const projectRow = {
  id: 'proj-1',
  userId: 'user-123',
  name: 'Test Project',
  normalizedName: 'test-project',
  description: null,
  repository: 'user/repo',
  installationId: 'inst-1',
  defaultBranch: 'main',
  defaultVmSize: null,
  defaultAgentType: null,
  defaultWorkspaceProfile: null,
  defaultProvider: null,
  defaultLocation: null,
  workspaceIdleTimeoutMs: null,
  nodeIdleTimeoutMs: null,
  taskExecutionTimeoutMs: null,
  maxConcurrentTasks: null,
  maxDispatchDepth: null,
  maxSubTasksPerTask: null,
  warmNodeTimeoutMs: null,
  maxWorkspacesPerNode: null,
  nodeCpuThresholdPercent: null,
  nodeMemoryThresholdPercent: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function buildMockDB(options: {
  /** Results for duplicate-name check (should be [] for no duplicate). */
  duplicateCheckResult?: any[];
} = {}) {
  const updateSet = vi.fn().mockReturnThis();
  const updateWhere = vi.fn().mockResolvedValue(undefined);

  // The PATCH handler calls limit() twice:
  // 1. duplicate name check -> should return duplicateCheckResult (default [])
  // 2. re-fetch updated project -> should return [projectRow]
  let limitCallCount = 0;
  const limitFn = vi.fn().mockImplementation(() => {
    limitCallCount++;
    if (limitCallCount === 1) {
      return Promise.resolve(options.duplicateCheckResult ?? []);
    }
    return Promise.resolve([projectRow]);
  });

  const mockDB = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    limit: limitFn,
    update: vi.fn().mockReturnValue({
      set: updateSet.mockReturnValue({ where: updateWhere }),
    }),
  };
  (drizzle as any).mockReturnValue(mockDB);
  return { mockDB, updateSet, updateWhere };
}

const mockEnv = {
  DATABASE: {} as D1Database,
  PROJECT_DATA: {
    idFromName: vi.fn().mockReturnValue({ toString: () => 'do-id' }),
    get: vi.fn(),
  },
  ENCRYPTION_KEY: 'test-key',
} as unknown as Env;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PATCH /projects/:id — defaultVmSize validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts valid defaultVmSize values (small, medium, large)', async () => {
    for (const size of ['small', 'medium', 'large']) {
      vi.clearAllMocks();
      buildMockDB();
      const app = buildApp();
      const res = await app.request('/projects/proj-1', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultVmSize: size }),
      }, mockEnv);

      expect(res.status).toBe(200);
    }
  });

  it('rejects invalid defaultVmSize values', async () => {
    buildMockDB();
    const app = buildApp();
    const res = await app.request('/projects/proj-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultVmSize: 'xlarge' }),
    }, mockEnv);

    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    // Valibot validator catches this before the route handler with its own error format
    expect(body.message).toContain('defaultVmSize');
  });

  it('accepts null defaultVmSize to clear to system default', async () => {
    buildMockDB();
    const app = buildApp();
    const res = await app.request('/projects/proj-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultVmSize: null }),
    }, mockEnv);

    expect(res.status).toBe(200);
  });
});

describe('Shared DEFAULT_VM_SIZE constant', () => {
  it('DEFAULT_VM_SIZE is defined and is a valid VM size', () => {
    expect(DEFAULT_VM_SIZE).toBeDefined();
    expect(['small', 'medium', 'large']).toContain(DEFAULT_VM_SIZE);
  });
});
