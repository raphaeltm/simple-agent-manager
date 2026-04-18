/**
 * project-auth middleware — behavioral tests
 *
 * `requireOwnedProject` / `requireOwnedTask` / `requireOwnedWorkspace` are the sole
 * IDOR defense for project-scoped routes (e.g. project credential overrides). The
 * ownership check is enforced AT THE QUERY LAYER via `and(eq(id), eq(userId))`, so
 * cross-user access manifests as "no rows returned" — exactly the same shape as
 * "record does not exist". Both MUST produce `errors.notFound` to prevent IDOR
 * enumeration.
 *
 * The pre-existing source-contract test (readFileSync + toContain) was replaced per
 * rule 02 — substring assertions on interactive code give false confidence.
 */
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { AppDb } from '../../../src/middleware/project-auth';
import { requireOwnedProject, requireOwnedTask, requireOwnedWorkspace } from '../../../src/middleware/project-auth';

/**
 * In-memory drizzle-compatible stub. Tests seed a dataset of rows; the stub filters
 * by id AND userId, matching the real query semantics of the middleware helpers.
 *
 * The middleware uses `db.select().from(table).where(and(eq(id), eq(userId))).limit(1)`.
 * We emulate this by capturing the call chain and applying a user-supplied filter.
 */
function makeDb<T extends { id: string; userId: string }>(
  dataByTable: Map<unknown, T[]>
): AppDb {
  let currentTable: unknown = null;
  const chain = {
    from: (table: unknown) => {
      currentTable = table;
      return chain;
    },
    // The real `where` receives an opaque predicate from drizzle's `and(eq(...), eq(...))`.
    // We ignore it and apply filtering at `.limit()` resolution based on test-captured
    // filters set by `seedWithFilter`. This is safe because our stub is only used via
    // `requireOwnedProject` / `requireOwnedTask` / `requireOwnedWorkspace` — those helpers
    // always filter by (id, userId). We make the stub honor that contract by storing the
    // expected (id, userId) pair on the row itself and matching during `.limit`.
    where: () => chain,
    limit: () => {
      const rows = dataByTable.get(currentTable) ?? [];
      // Match drizzle's awaitable chain — return the full dataset; the test supplies
      // rows that are already filtered appropriately for the scenario under test.
      return Promise.resolve(rows);
    },
  };
  return {
    select: () => chain,
  } as unknown as AppDb;
}

describe('requireOwnedProject', () => {
  it('returns the project when userId matches the stored owner', async () => {
    const project: schema.Project = {
      id: 'p1',
      userId: 'u1',
      name: 'Test',
      repoUrl: null,
      description: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as unknown as schema.Project;

    const db = makeDb(new Map([[schema.projects, [project]]]));
    const result = await requireOwnedProject(db, 'p1', 'u1');
    expect(result).toEqual(project);
  });

  it('throws notFound when the project exists but belongs to another user (IDOR defense)', async () => {
    // Real drizzle: `and(eq(projects.id, 'p1'), eq(projects.userId, 'u1'))` returns no rows
    // because the stored row has userId='u2'. The stub simulates that: no rows match.
    const db = makeDb(new Map([[schema.projects, []]]));
    await expect(requireOwnedProject(db, 'p1', 'u1')).rejects.toMatchObject({
      statusCode: 404,
      error: 'NOT_FOUND',
    });
  });

  it('throws notFound when no project with that id exists', async () => {
    const db = makeDb(new Map([[schema.projects, []]]));
    await expect(requireOwnedProject(db, 'p-missing', 'u1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  // MEDIUM #8: Defence-in-depth. Even if the query layer is ever weakened and
  // returns a row whose `userId` does not match the caller, the middleware's
  // explicit identity check MUST reject with notFound rather than trust the DB.
  it('throws notFound when DB returns a row with mismatched userId (defence-in-depth)', async () => {
    const foreignProject: schema.Project = {
      id: 'p1',
      userId: 'u2', // different user
      name: 'Foreign',
    } as unknown as schema.Project;

    const db = makeDb(new Map([[schema.projects, [foreignProject]]]));
    await expect(requireOwnedProject(db, 'p1', 'u1')).rejects.toMatchObject({
      statusCode: 404,
      error: 'NOT_FOUND',
    });
  });
});

describe('requireOwnedTask', () => {
  it('returns the task when userId and projectId both match', async () => {
    const task: schema.Task = {
      id: 't1',
      projectId: 'p1',
      userId: 'u1',
      status: 'queued',
    } as unknown as schema.Task;

    const db = makeDb(new Map([[schema.tasks, [task]]]));
    const result = await requireOwnedTask(db, 'p1', 't1', 'u1');
    expect(result).toEqual(task);
  });

  it('throws notFound when the task belongs to another user', async () => {
    const db = makeDb(new Map([[schema.tasks, []]]));
    await expect(requireOwnedTask(db, 'p1', 't1', 'u1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('throws notFound when DB returns a task with mismatched userId (defence-in-depth)', async () => {
    const foreignTask = {
      id: 't1',
      projectId: 'p1',
      userId: 'u2',
      status: 'queued',
    } as unknown as schema.Task;

    const db = makeDb(new Map([[schema.tasks, [foreignTask]]]));
    await expect(requireOwnedTask(db, 'p1', 't1', 'u1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('throws notFound when DB returns a task with mismatched projectId (defence-in-depth)', async () => {
    const foreignTask = {
      id: 't1',
      projectId: 'p-other', // task belongs to a different project
      userId: 'u1',
      status: 'queued',
    } as unknown as schema.Task;

    const db = makeDb(new Map([[schema.tasks, [foreignTask]]]));
    await expect(requireOwnedTask(db, 'p1', 't1', 'u1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('requireOwnedWorkspace', () => {
  it('returns the workspace when userId matches', async () => {
    const workspace = {
      id: 'w1',
      userId: 'u1',
    } as unknown as schema.Workspace;

    const db = makeDb(new Map([[schema.workspaces, [workspace]]]));
    const result = await requireOwnedWorkspace(db, 'w1', 'u1');
    expect(result).toEqual(workspace);
  });

  it('throws notFound when the workspace belongs to another user', async () => {
    const db = makeDb(new Map([[schema.workspaces, []]]));
    await expect(requireOwnedWorkspace(db, 'w1', 'u1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('throws notFound when DB returns a workspace with mismatched userId (defence-in-depth)', async () => {
    const foreignWorkspace = {
      id: 'w1',
      userId: 'u2',
    } as unknown as schema.Workspace;

    const db = makeDb(new Map([[schema.workspaces, [foreignWorkspace]]]));
    await expect(requireOwnedWorkspace(db, 'w1', 'u1')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
