import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../../../src/index';
import { projectsRoutes } from '../../../src/routes/projects';

const mocks = vi.hoisted(() => ({
  requireOwnedProject: vi.fn(),
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((c: any, next: any) => next()),
  requireApproved: () => vi.fn((c: any, next: any) => next()),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireOwnedProject: mocks.requireOwnedProject,
}));
vi.mock('../../../src/services/encryption', () => ({
  encrypt: vi.fn().mockResolvedValue({ ciphertext: 'enc', iv: 'iv' }),
}));

describe('DELETE /api/projects/:id', () => {
  let app: Hono<{ Bindings: Env }>;
  /** Track every top-level db operation */
  let operations: string[];
  let selectResults: any[][];

  function buildMockDB() {
    operations = [];

    // Each select().from().where() chain resolves to the next selectResults entry.
    // Each delete().where() chain resolves to undefined.
    // Each update().set().where() chain resolves to undefined.
    const mockDB: any = {
      select: vi.fn(() => {
        operations.push('select');
        const selectChain: any = {};
        selectChain.from = vi.fn(() => selectChain);
        selectChain.where = vi.fn(() => selectChain);
        selectChain.orderBy = vi.fn(() => selectChain);
        selectChain.groupBy = vi.fn(() => selectChain);
        selectChain.limit = vi.fn(() => {
          return Promise.resolve(selectResults.shift() ?? []);
        });
        // When awaited directly (without .limit()), resolve to data
        selectChain.then = (resolve: any, reject: any) => {
          return Promise.resolve(selectResults.shift() ?? []).then(resolve, reject);
        };
        return selectChain;
      }),
      delete: vi.fn((...args: any[]) => {
        // Track which table is being deleted from
        const tableName = args[0]?.[Symbol.for('drizzle:Name')] ?? 'unknown';
        operations.push(`delete:${tableName}`);
        const deleteChain: any = {};
        deleteChain.where = vi.fn(() => Promise.resolve());
        return deleteChain;
      }),
      update: vi.fn((...args: any[]) => {
        const tableName = args[0]?.[Symbol.for('drizzle:Name')] ?? 'unknown';
        operations.push(`update:${tableName}`);
        const updateChain: any = {};
        updateChain.set = vi.fn(() => {
          const setChain: any = {};
          setChain.where = vi.fn(() => Promise.resolve());
          return setChain;
        });
        return updateChain;
      }),
      insert: vi.fn(() => {
        operations.push('insert');
        const insertChain: any = {};
        insertChain.values = vi.fn(() => Promise.resolve());
        return insertChain;
      }),
    };

    return mockDB;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    selectResults = [];

    const mockDB = buildMockDB();
    (drizzle as any).mockReturnValue(mockDB);

    mocks.requireOwnedProject.mockResolvedValue({
      id: 'proj-1',
      userId: 'user-1',
      name: 'Test Project',
      installationId: 'inst-1',
      repository: 'acme/repo',
      defaultBranch: 'main',
    });

    app = new Hono<{ Bindings: Env }>();
    app.onError((err, c) => {
      const appError = err as { statusCode?: number; error?: string; message?: string };
      if (typeof appError.statusCode === 'number' && typeof appError.error === 'string') {
        return c.json({ error: appError.error, message: appError.message }, appError.statusCode);
      }
      return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
    });
    app.route('/api/projects', projectsRoutes);
  });

  const env = { DATABASE: {} as any } as Env;

  it('returns 200 and success when project is deleted', async () => {
    // select: tasks for project → no tasks
    selectResults.push([]);
    // select: verification → project is gone
    selectResults.push([]);

    const response = await app.request('/api/projects/proj-1', {
      method: 'DELETE',
    }, env);

    expect(response.status).toBe(200);
    const body = await response.json<{ success: boolean }>();
    expect(body.success).toBe(true);
  });

  it('deletes child records before the project when tasks exist', async () => {
    // select: tasks for project → 2 task IDs
    selectResults.push([{ id: 'task-1' }, { id: 'task-2' }]);
    // select: verification → project is gone
    selectResults.push([]);

    const response = await app.request('/api/projects/proj-1', {
      method: 'DELETE',
    }, env);

    expect(response.status).toBe(200);

    // Verify delete operations were called
    const deleteOps = operations.filter((o) => o.startsWith('delete:'));
    // With tasks: taskStatusEvents, taskDependencies (x2), tasks,
    // runtimeEnvVars, runtimeFiles, agentProfiles, projects = 8
    expect(deleteOps.length).toBe(8);
  });

  it('skips task grandchild cleanup when no tasks exist', async () => {
    // select: tasks for project → empty
    selectResults.push([]);
    // select: verification → project is gone
    selectResults.push([]);

    const response = await app.request('/api/projects/proj-1', {
      method: 'DELETE',
    }, env);

    expect(response.status).toBe(200);

    // Without tasks: tasks, runtimeEnvVars, runtimeFiles, agentProfiles, projects = 5
    const deleteOps = operations.filter((o) => o.startsWith('delete:'));
    expect(deleteOps.length).toBe(5);
  });

  it('nullifies workspace project_id before deleting project', async () => {
    selectResults.push([]);
    selectResults.push([]);

    const response = await app.request('/api/projects/proj-1', {
      method: 'DELETE',
    }, env);

    expect(response.status).toBe(200);

    // Verify update operation exists (workspace nullification)
    const updateOps = operations.filter((o) => o.startsWith('update:'));
    expect(updateOps.length).toBeGreaterThanOrEqual(1);

    // Update should come before the last delete (project delete)
    const lastDelete = operations.lastIndexOf(operations.filter((o) => o.startsWith('delete:')).pop()!);
    const firstUpdate = operations.indexOf(updateOps[0]);
    expect(firstUpdate).toBeLessThan(lastDelete);
  });

  it('returns 500 if project still exists after delete attempt', async () => {
    // select: tasks for project → no tasks
    selectResults.push([]);
    // select: verification → project STILL EXISTS
    selectResults.push([{ id: 'proj-1' }]);

    const response = await app.request('/api/projects/proj-1', {
      method: 'DELETE',
    }, env);

    expect(response.status).toBe(500);
    const body = await response.json<{ error: string; message: string }>();
    expect(body.error).toBe('INTERNAL_ERROR');
    expect(body.message).toContain('still exists');
  });

  it('calls requireOwnedProject for authorization', async () => {
    selectResults.push([]);
    selectResults.push([]);

    await app.request('/api/projects/proj-1', { method: 'DELETE' }, env);

    expect(mocks.requireOwnedProject).toHaveBeenCalledTimes(1);
  });
});
