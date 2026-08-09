import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { AuthContext } from '../../../src/middleware/auth';
import { AppError } from '../../../src/middleware/error';
import { crudRoutes } from '../../../src/routes/projects/crud';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../../../src/lib/logger', () => ({
  log: mocks.log,
  createModuleLogger: () => mocks.log,
}));

const OWNER_A = 'user-a';
const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';

describe('DELETE /api/projects/:id library cleanup — real SQL vertical slice', () => {
  let sqlite: Database.Database;
  let objects: Set<string>;
  let deletedObjects: string[];
  let waitUntilPromises: Promise<unknown>[];
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  function authContext(): AuthContext {
    return {
      user: {
        id: OWNER_A,
        email: 'owner-a@example.test',
        name: 'Project A owner',
        avatarUrl: null,
        role: 'user',
        status: 'active',
      },
      session: {
        id: 'session-owner-a',
        expiresAt: new Date('2026-08-10T00:00:00.000Z'),
      },
    };
  }

  function addProject(projectId: string, userId: string): void {
    sqlite
      .prepare(
        `INSERT INTO projects (id, user_id, name, repo_provider)
         VALUES (?, ?, ?, 'github')`
      )
      .run(projectId, userId, `Project ${projectId}`);
    sqlite
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, status)
         VALUES (?, ?, 'owner', 'active')`
      )
      .run(projectId, userId);
  }

  function addFile(projectId: string, fileId: string): void {
    sqlite
      .prepare('INSERT INTO project_files (id, project_id, r2_key) VALUES (?, ?, ?)')
      .run(fileId, projectId, `library/${projectId}/${fileId}`);
    sqlite
      .prepare('INSERT INTO project_file_tags (file_id, tag) VALUES (?, ?)')
      .run(fileId, `tag-${fileId}`);
  }

  function ids(table: 'projects' | 'project_files' | 'project_file_tags', column = 'id'): string[] {
    return sqlite
      .prepare(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`)
      .all()
      .map((row) => (row as { id: string }).id);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    objects = new Set([
      'library/project-a/a-file-1',
      'library/project-a/a-file-2',
      'library/project-b/b-file-1',
    ]);
    deletedObjects = [];
    waitUntilPromises = [];

    env = {
      DATABASE: createSqliteD1(sqlite),
      R2: {
        list: vi.fn(async ({ prefix }: { prefix: string }) => ({
          objects: [...objects].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
          truncated: false,
        })),
        delete: vi.fn(async (keys: string[]) => {
          for (const key of keys) {
            objects.delete(key);
            deletedObjects.push(key);
          }
        }),
      } as unknown as R2Bucket,
    } as Env;

    app = new Hono<{ Bindings: Env }>();
    app.use('*', async (c, next) => {
      c.set('auth', authContext());
      await next();
    });
    app.onError((err, c) =>
      err instanceof AppError
        ? c.json(err.toJSON(), err.statusCode as never)
        : c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500)
    );
    app.route('/api/projects', crudRoutes);
  });

  afterEach(() => sqlite.close());

  it('deletes project A rows and R2 keys through the route while project B is untouched', async () => {
    addProject(PROJECT_A, OWNER_A);
    addProject(PROJECT_B, 'user-b');
    addFile(PROJECT_A, 'a-file-1');
    addFile(PROJECT_A, 'a-file-2');
    addFile(PROJECT_B, 'b-file-1');

    const executionContext = {
      waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const response = await app.fetch(
      new Request(`https://api.test/api/projects/${PROJECT_A}`, { method: 'DELETE' }),
      env,
      executionContext
    );
    await Promise.all(waitUntilPromises);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });

    // Owner-path control: the authorized project's route really deletes its project,
    // file/tag rows, and objects, so the tenant-isolation assertions are discriminating.
    expect(ids('projects')).toEqual([PROJECT_B]);
    expect(ids('project_files')).toEqual(['b-file-1']);
    expect(ids('project_file_tags', 'file_id')).toEqual(['b-file-1']);
    expect(deletedObjects).toEqual(['library/project-a/a-file-1', 'library/project-a/a-file-2']);

    // Attack case: the same request cannot remove another project's rows or object.
    expect([...objects]).toEqual(['library/project-b/b-file-1']);
    expect(env.R2.list).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'library/project-a/' })
    );
  });

  it('returns after registering waitUntil without waiting for R2 cleanup', async () => {
    addProject(PROJECT_A, OWNER_A);
    let resolveList: ((value: R2Objects) => void) | undefined;
    env.R2.list = vi.fn(
      () =>
        new Promise<R2Objects>((resolve) => {
          resolveList = resolve;
        })
    );
    const executionContext = {
      waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const responsePromise = app.fetch(
      new Request(`https://api.test/api/projects/${PROJECT_A}`, { method: 'DELETE' }),
      env,
      executionContext
    );
    const outcome = await Promise.race([
      responsePromise.then(() => 'response'),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 250)),
    ]);

    expect(outcome).toBe('response');
    expect(waitUntilPromises).toHaveLength(1);
    expect(resolveList).toBeDefined();
    resolveList?.({ objects: [], truncated: false });
    await Promise.all(waitUntilPromises);
    expect((await responsePromise).status).toBe(200);
  });

  it('logs structured project context when background R2 cleanup fails', async () => {
    addProject(PROJECT_A, OWNER_A);
    env.R2.list = vi.fn().mockRejectedValue(new Error('R2 unavailable'));
    const executionContext = {
      waitUntil: (promise: Promise<unknown>) => waitUntilPromises.push(promise),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const response = await app.fetch(
      new Request(`https://api.test/api/projects/${PROJECT_A}`, { method: 'DELETE' }),
      env,
      executionContext
    );
    await Promise.all(waitUntilPromises);

    expect(response.status).toBe(200);
    expect(mocks.log.warn).toHaveBeenCalledWith('project_delete.library_cleanup_failed', {
      projectId: PROJECT_A,
      prefix: 'library/project-a/',
      error: 'R2 unavailable',
    });
  });
});
