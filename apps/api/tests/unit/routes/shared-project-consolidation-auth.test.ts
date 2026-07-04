import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { projectsRoutes } from '../../../src/routes/projects';

const mocks = vi.hoisted(() => ({
  currentDb: null as unknown,
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => mocks.currentDb,
}));

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'admin-user',
}));

function makeProject(overrides: Partial<schema.Project> = {}): schema.Project {
  return {
    id: 'proj-1',
    userId: 'owner-user',
    name: 'Shared project',
    normalizedName: 'shared-project',
    description: null,
    installationId: 'inst-1',
    repository: 'acme/shared',
    defaultBranch: 'main',
    repoProvider: 'github',
    githubRepoId: 123,
    githubRepoNodeId: 'repo-node-123',
    artifactsRepoId: null,
    defaultVmSize: null,
    defaultAgentType: null,
    defaultWorkspaceProfile: null,
    defaultDevcontainerConfigName: null,
    defaultProvider: null,
    defaultLocation: null,
    agentDefaults: null,
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
    status: 'active',
    activeSessionCount: 0,
    lastActivityAt: null,
    createdBy: 'owner-user',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  } as schema.Project;
}

function makeMember(overrides: Partial<schema.ProjectMember> = {}): schema.ProjectMember {
  return {
    projectId: 'proj-1',
    userId: 'admin-user',
    role: 'admin',
    status: 'active',
    invitedBy: 'owner-user',
    createdAt: '2026-07-04T00:00:00.000Z',
    updatedAt: '2026-07-04T00:00:00.000Z',
    ...overrides,
  };
}

function conditionReferences(condition: unknown, target: unknown): boolean {
  if (condition === target) return true;
  if (!condition || typeof condition !== 'object') return false;

  const maybeChunks = condition as { queryChunks?: unknown[] };
  if (Array.isArray(maybeChunks.queryChunks)) {
    return maybeChunks.queryChunks.some((chunk) => conditionReferences(chunk, target));
  }

  return Object.values(condition).some((value) => conditionReferences(value, target));
}

function createListDb(projects: schema.Project[]) {
  return {
    select: vi.fn(() => {
      let selectedTable: unknown;
      let whereCondition: unknown;
      const chain = {
        from: vi.fn((table: unknown) => {
          selectedTable = table;
          return chain;
        }),
        where: vi.fn((condition: unknown) => {
          whereCondition = condition;
          return chain;
        }),
        orderBy: vi.fn(() => chain),
        limit: vi.fn(async () => {
          if (
            selectedTable === schema.projects &&
            conditionReferences(whereCondition, schema.projectMembers)
          ) {
            return projects;
          }
          return [];
        }),
        groupBy: vi.fn(async () => []),
      };
      return chain;
    }),
  };
}

function createDeleteDb() {
  const deleteSpy = vi.fn();
  const batchSpy = vi.fn();
  return {
    db: {
      select: vi.fn(() => {
        let selectedTable: unknown;
        const chain = {
          from: vi.fn((table: unknown) => {
            selectedTable = table;
            return chain;
          }),
          where: vi.fn(() => chain),
          limit: vi.fn(async () => {
            if (selectedTable === schema.projects) return [makeProject()];
            if (selectedTable === schema.projectMembers) return [makeMember()];
            return [];
          }),
        };
        return chain;
      }),
      delete: deleteSpy,
      update: vi.fn(),
      batch: batchSpy,
    },
    deleteSpy,
    batchSpy,
  };
}

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as never);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects', projectsRoutes);
  return app;
}

describe('shared project authorization consolidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists active shared projects for an admin member', async () => {
    mocks.currentDb = createListDb([makeProject()]);

    const response = await createApp().request('/api/projects', {}, { DATABASE: {} } as Env);

    expect(response.status).toBe(200);
    const body = await response.json<{ projects: Array<{ id: string; name: string }> }>();
    expect(body.projects).toEqual([
      expect.objectContaining({
        id: 'proj-1',
        name: 'Shared project',
      }),
    ]);
  });

  it('does not list projects without active membership', async () => {
    mocks.currentDb = createListDb([]);

    const response = await createApp().request('/api/projects', {}, { DATABASE: {} } as Env);

    expect(response.status).toBe(200);
    const body = await response.json<{ projects: unknown[] }>();
    expect(body.projects).toEqual([]);
  });

  it('keeps project deletion owner-only for admin members', async () => {
    const { db, deleteSpy, batchSpy } = createDeleteDb();
    mocks.currentDb = db;

    const response = await createApp().request(
      '/api/projects/proj-1',
      { method: 'DELETE' },
      { DATABASE: {} } as Env
    );

    expect(response.status).toBe(403);
    const body = await response.json<{ error: string; message: string }>();
    expect(body.error).toBe('FORBIDDEN');
    expect(body.message).toContain('Project capability is required');
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(batchSpy).not.toHaveBeenCalled();
  });
});
