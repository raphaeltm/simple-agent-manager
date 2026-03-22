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
  /** Statements collected by db.batch() */
  let batchedStatements: any[];

  function buildMockDB() {
    operations = [];
    batchedStatements = [];

    // Each select().from().where() chain resolves to the next selectResults entry.
    // delete/update chains return query builder objects (collected by batch()).
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
        const tableName = args[0]?.[Symbol.for('drizzle:Name')] ?? 'unknown';
        operations.push(`delete:${tableName}`);
        const deleteChain: any = { _op: `delete:${tableName}` };
        deleteChain.where = vi.fn(() => deleteChain);
        // Support both batch and direct await
        deleteChain.then = (resolve: any) => Promise.resolve().then(resolve);
        return deleteChain;
      }),
      update: vi.fn((...args: any[]) => {
        const tableName = args[0]?.[Symbol.for('drizzle:Name')] ?? 'unknown';
        operations.push(`update:${tableName}`);
        const updateChain: any = { _op: `update:${tableName}` };
        updateChain.set = vi.fn(() => {
          const setChain: any = { _op: `update:${tableName}` };
          setChain.where = vi.fn(() => setChain);
          setChain.then = (resolve: any) => Promise.resolve().then(resolve);
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
      batch: vi.fn((stmts: any[]) => {
        batchedStatements = stmts;
        return Promise.resolve(stmts.map(() => undefined));
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

    const response = await app.request('/api/projects/proj-1', {
      method: 'DELETE',
    }, env);

    expect(response.status).toBe(200);
    const body = await response.json<{ success: boolean }>();
    expect(body.success).toBe(true);

    // All mutations should go through batch
    expect(batchedStatements.length).toBeGreaterThan(0);
  });

  it('deletes child records before the project when tasks exist', async () => {
    // select: tasks for project → 2 task IDs
    selectResults.push([{ id: 'task-1' }, { id: 'task-2' }]);

    const response = await app.request('/api/projects/proj-1', {
      method: 'DELETE',
    }, env);

    expect(response.status).toBe(200);

    // With tasks: taskStatusEvents(1) + taskDependencies(2) + tasks(1) +
    // runtimeEnvVars(1) + runtimeFiles(1) + agentProfiles(1) + update:workspaces(1) + projects(1) = 9
    // (9 statements because update is also in batch now)
    const deleteOps = operations.filter((o) => o.startsWith('delete:'));
    expect(deleteOps.length).toBe(8);
  });

  it('skips task grandchild cleanup when no tasks exist', async () => {
    // select: tasks for project → empty
    selectResults.push([]);

    const response = await app.request('/api/projects/proj-1', {
      method: 'DELETE',
    }, env);

    expect(response.status).toBe(200);

    // Without tasks: tasks(1) + runtimeEnvVars(1) + runtimeFiles(1) + agentProfiles(1) + projects(1) = 5
    const deleteOps = operations.filter((o) => o.startsWith('delete:'));
    expect(deleteOps.length).toBe(5);
  });

  it('nullifies workspace project_id in the batch', async () => {
    selectResults.push([]);

    const response = await app.request('/api/projects/proj-1', {
      method: 'DELETE',
    }, env);

    expect(response.status).toBe(200);

    // Verify update operation exists (workspace nullification)
    const updateOps = operations.filter((o) => o.startsWith('update:'));
    expect(updateOps.length).toBeGreaterThanOrEqual(1);

    // Update should come before the last delete (project delete) — use index-based tracking
    const deleteIndices = operations
      .map((op, i) => (op.startsWith('delete:') ? i : -1))
      .filter((i) => i >= 0);
    const lastDeleteIndex = deleteIndices[deleteIndices.length - 1];
    const updateIndices = operations
      .map((op, i) => (op.startsWith('update:') ? i : -1))
      .filter((i) => i >= 0);
    expect(updateIndices[0]).toBeLessThan(lastDeleteIndex);
  });

  it('executes all mutations via db.batch()', async () => {
    selectResults.push([{ id: 'task-1' }]);

    const response = await app.request('/api/projects/proj-1', {
      method: 'DELETE',
    }, env);

    expect(response.status).toBe(200);

    // All mutations should be collected and passed to batch
    // With 1 task: 3 grandchild + 4 child + 1 update + 1 project = 9
    expect(batchedStatements.length).toBe(9);
  });

  it('calls requireOwnedProject for authorization', async () => {
    selectResults.push([]);

    await app.request('/api/projects/proj-1', { method: 'DELETE' }, env);

    expect(mocks.requireOwnedProject).toHaveBeenCalledTimes(1);
  });

  it('returns error when requireOwnedProject rejects (not owner)', async () => {
    mocks.requireOwnedProject.mockRejectedValueOnce(
      Object.assign(new Error('Project not found'), {
        statusCode: 404,
        error: 'NOT_FOUND',
        message: 'Project not found',
      })
    );

    const response = await app.request('/api/projects/proj-1', {
      method: 'DELETE',
    }, env);

    expect(response.status).toBe(404);
    const body = await response.json<{ error: string }>();
    expect(body.error).toBe('NOT_FOUND');

    // No delete operations should have been attempted
    const deleteOps = operations.filter((o) => o.startsWith('delete:'));
    expect(deleteOps.length).toBe(0);
  });

  it('performs 3 task_dependencies deletes with tasks (including cross-project)', async () => {
    // Tasks exist → should trigger 3 dependency-related deletes:
    // 1. taskStatusEvents for taskIds
    // 2. taskDependencies where taskId IN taskIds
    // 3. taskDependencies where dependsOnTaskId IN taskIds (cross-project)
    selectResults.push([{ id: 'task-1' }]);

    const response = await app.request('/api/projects/proj-1', {
      method: 'DELETE',
    }, env);

    expect(response.status).toBe(200);

    // With 1 task: taskStatusEvents(1) + taskDependencies(2) + tasks(1) +
    // runtimeEnvVars(1) + runtimeFiles(1) + agentProfiles(1) + projects(1) = 8
    const deleteOps = operations.filter((o) => o.startsWith('delete:'));
    expect(deleteOps.length).toBe(8);
  });
});
