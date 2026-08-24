/**
 * Vertical slice: HTTP request -> route -> validation -> ProjectData service
 * boundary -> REAL durable-object SQLite (better-sqlite3, real migrations) and
 * back out as a JSON response.
 *
 * The only stubs are the two genuine system boundaries:
 *   - D1 `project_files` (the file->project binding), seeded with realistic rows
 *     for two projects so cross-project access is actually exercised;
 *   - the ProjectData RPC hop, which here delegates straight into the real
 *     library-file-comments module instead of a Durable Object stub.
 *
 * Nothing in between is mocked, so a break anywhere along the path — schema,
 * error mapping, fileId threading, SQL scoping — fails this test.
 * See .claude/rules/35-vertical-slice-testing.md.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { createSqlStorage } from '../unit/durable-objects/sql-storage-test-utils';

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';
const FILE_A = 'file-in-project-a';
const FILE_A2 = 'other-file-in-project-a';
const FILE_B = 'file-in-project-b';

/** Seeded D1 `project_files` rows. */
const PROJECT_FILES = [
  { id: FILE_A, projectId: PROJECT_A },
  { id: FILE_A2, projectId: PROJECT_A },
  { id: FILE_B, projectId: PROJECT_B },
];

const harness = vi.hoisted(() => ({
  /** Per-project durable object storage, keyed exactly as idFromName(projectId) would be. */
  storages: new Map<string, SqlStorage>(),
  env: {} as Record<string, string>,
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
  getAuth: () => ({
    user: {
      id: 'user-1',
      email: 'ada@example.com',
      name: 'Ada',
      avatarUrl: null,
      role: 'user',
      status: 'active',
    },
    session: { id: 'session-1', expiresAt: new Date('2030-01-01T00:00:00Z') },
  }),
}));
vi.mock('../../src/middleware/project-auth', () => ({
  requireProjectAccess: vi.fn(),
  // Membership is orthogonal to what this slice proves; the caller is a member of
  // both projects so the ONLY thing that can reject a cross-project request is
  // the file->project binding itself.
  requireProjectCapability: vi.fn().mockResolvedValue({ id: 'authorized-project' }),
}));

// The service layer's only job here is the RPC hop. Replace it with a direct call
// into the real DO module against that project's real SQLite.
vi.mock('../../src/services/project-data', async () => {
  const contracts = await vi.importActual<
    typeof import('../../src/durable-objects/project-data/comment-contracts')
  >('../../src/durable-objects/project-data/comment-contracts');
  const fileComments = await vi.importActual<
    typeof import('../../src/durable-objects/project-data/library-file-comments')
  >('../../src/durable-objects/project-data/library-file-comments');

  const sqlFor = (projectId: string): SqlStorage => {
    const storage = harness.storages.get(projectId);
    if (!storage) throw new Error(`no durable object storage seeded for ${projectId}`);
    return storage;
  };
  // Cloudflare RPC reconstructs a thrown error on the caller side as a PLAIN
  // Error carrying only `name` and `message`. The subclass identity and any
  // class fields — including the `code` these errors define — do not survive.
  // Reproduce that, otherwise the route's error mapping gets tested against a
  // richer error than production ever sees and an `instanceof`/`code`-only
  // mapping would pass here while 500ing in production.
  const throughRpc = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      const serialized = new Error(err.message);
      serialized.name = err.name;
      throw serialized;
    }
  };

  return {
    ...contracts,
    listFileCommentThreads: async (_env: Env, projectId: string, input: unknown) =>
      throughRpc(() =>
        fileComments.listFileCommentThreads(sqlFor(projectId), harness.env as never, input as never)
      ),
    createFileCommentThread: async (_env: Env, projectId: string, input: unknown) =>
      throughRpc(() =>
        fileComments.createFileCommentThread(sqlFor(projectId), harness.env as never, input as never)
      ),
    createFileCommentReply: async (_env: Env, projectId: string, input: unknown) =>
      throughRpc(() =>
        fileComments.createFileCommentReply(sqlFor(projectId), harness.env as never, input as never)
      ),
    updateFileCommentThreadStatus: async (_env: Env, projectId: string, input: unknown) =>
      throughRpc(() =>
        fileComments.updateFileCommentThreadStatus(
          sqlFor(projectId),
          harness.env as never,
          input as never
        )
      ),
  };
});

import { runMigrations } from '../../src/durable-objects/migrations';
import { libraryCommentRoutes } from '../../src/routes/library-comments';

let databases: Database.Database[] = [];

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as never);
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects/:projectId/library', libraryCommentRoutes);
  return app;
}

function get(projectId: string, fileId: string, query = '') {
  return createApp().request(
    `https://api.test/api/projects/${projectId}/library/${fileId}/comments${query}`,
    { method: 'GET' },
    { DATABASE: {} } as Env
  );
}

function post(path: string, body: unknown) {
  return createApp().request(
    `https://api.test${path}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    { DATABASE: {} } as Env
  );
}

function commentsPath(projectId: string, fileId: string) {
  return `/api/projects/${projectId}/library/${fileId}/comments`;
}

describe('library file comments — vertical slice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.storages.clear();
    harness.env = {};
    databases = [];

    for (const projectId of [PROJECT_A, PROJECT_B]) {
      const db = new Database(':memory:');
      databases.push(db);
      const sql = createSqlStorage(db);
      runMigrations(sql);
      harness.storages.set(projectId, sql);
    }

    vi.mocked(drizzle).mockReturnValue({
      query: {
        projectFiles: {
          // Faithful enough to the drizzle contract to actually evaluate the
          // predicate: a binding check that ignored projectId would pass here
          // and then fail the cross-project tests below.
          findFirst: async ({
            where,
          }: {
            where: (
              columns: { projectId: string; id: string },
              ops: {
                and: (...parts: boolean[]) => boolean;
                eq: (column: string, value: string) => boolean;
              }
            ) => boolean;
          }) =>
            PROJECT_FILES.find((row) =>
              where(
                { projectId: row.projectId, id: row.id },
                {
                  and: (...parts: boolean[]) => parts.every(Boolean),
                  eq: (column: string, value: string) => column === value,
                }
              )
            ),
        },
      },
    } as never);
  });

  afterEach(() => {
    for (const db of databases) db.close();
  });

  it('carries a quoted comment from POST through real storage to a later GET', async () => {
    const created = await post(commentsPath(PROJECT_A, FILE_A), {
      body: 'This paragraph contradicts the section above.',
      quote: 'the quick brown fox',
      clientMutationId: 'client-1',
    });

    expect(created.status).toBe(201);
    const createdPayload = (await created.json()) as {
      thread: { id: string; anchor: { kind: string; fileId: string; quote: string } };
    };
    expect(createdPayload.thread.anchor).toEqual({
      kind: 'library_file',
      fileId: FILE_A,
      quote: 'the quick brown fox',
    });

    // A fresh request must read it back out of storage — not out of a mock.
    const listed = await get(PROJECT_A, FILE_A);
    expect(listed.status).toBe(200);
    const listedPayload = (await listed.json()) as {
      threads: Array<{ id: string; body: string; status: string; anchor: { quote: string } }>;
      hasMore: boolean;
    };
    expect(listedPayload.hasMore).toBe(false);
    expect(listedPayload.threads).toHaveLength(1);
    expect(listedPayload.threads[0]).toMatchObject({
      id: createdPayload.thread.id,
      body: 'This paragraph contradicts the section above.',
      status: 'open',
      anchor: { quote: 'the quick brown fox' },
    });
  });

  it('replays an identical clientMutationId as 200 without creating a second thread', async () => {
    const payload = { body: 'Duplicate submit', clientMutationId: 'client-dup' };

    const first = await post(commentsPath(PROJECT_A, FILE_A), payload);
    const second = await post(commentsPath(PROJECT_A, FILE_A), payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);

    const listed = (await (await get(PROJECT_A, FILE_A)).json()) as { threads: unknown[] };
    expect(listed.threads).toHaveLength(1);
  });

  it('runs a full reply / resolve / reopen lifecycle against real storage', async () => {
    const created = (await (
      await post(commentsPath(PROJECT_A, FILE_A), { body: 'Please clarify' })
    ).json()) as { thread: { id: string } };
    const threadId = created.thread.id;
    const base = `${commentsPath(PROJECT_A, FILE_A)}/${threadId}`;

    const replied = await post(`${base}/replies`, { body: 'Clarified below' });
    expect(replied.status).toBe(201);

    const resolved = await post(`${base}/resolve`, {});
    expect(resolved.status).toBe(200);
    expect(((await resolved.json()) as { thread: { status: string } }).thread.status).toBe(
      'resolved'
    );

    const reopened = await post(`${base}/reopen`, {});
    expect(reopened.status).toBe(200);
    expect(((await reopened.json()) as { thread: { status: string } }).thread.status).toBe('open');

    const listed = (await (await get(PROJECT_A, FILE_A)).json()) as {
      threads: Array<{ status: string; replies: Array<{ body: string }> }>;
    };
    expect(listed.threads[0].status).toBe('open');
    expect(listed.threads[0].replies.map((r) => r.body)).toEqual(['Clarified below']);
  });

  it('filters by status through the whole stack', async () => {
    const keepOpen = (await (
      await post(commentsPath(PROJECT_A, FILE_A), { body: 'Still open' })
    ).json()) as { thread: { id: string } };
    const toResolve = (await (
      await post(commentsPath(PROJECT_A, FILE_A), { body: 'Will be resolved' })
    ).json()) as { thread: { id: string } };

    await post(`${commentsPath(PROJECT_A, FILE_A)}/${toResolve.thread.id}/resolve`, {});

    const open = (await (await get(PROJECT_A, FILE_A, '?status=open')).json()) as {
      threads: Array<{ id: string }>;
    };
    expect(open.threads.map((t) => t.id)).toEqual([keepOpen.thread.id]);

    const resolved = (await (await get(PROJECT_A, FILE_A, '?status=resolved')).json()) as {
      threads: Array<{ id: string }>;
    };
    expect(resolved.threads.map((t) => t.id)).toEqual([toResolve.thread.id]);
  });

  describe('tenant and file isolation', () => {
    it('keeps comments on sibling files in the same project separate', async () => {
      await post(commentsPath(PROJECT_A, FILE_A), { body: 'About file A' });
      await post(commentsPath(PROJECT_A, FILE_A2), { body: 'About the other file' });

      const fileA = (await (await get(PROJECT_A, FILE_A)).json()) as {
        threads: Array<{ body: string }>;
      };
      const fileA2 = (await (await get(PROJECT_A, FILE_A2)).json()) as {
        threads: Array<{ body: string }>;
      };

      expect(fileA.threads.map((t) => t.body)).toEqual(['About file A']);
      expect(fileA2.threads.map((t) => t.body)).toEqual(['About the other file']);
    });

    it("404s when a project's own route names another project's file", async () => {
      // The caller is authorized for PROJECT_A and supplies a real fileId — it
      // just belongs to PROJECT_B. The binding check is the only thing standing
      // between that request and a thread attached to a foreign file.
      const response = await post(commentsPath(PROJECT_A, FILE_B), { body: 'Cross-project' });

      expect(response.status).toBe(404);

      // And nothing was written into either project's storage.
      for (const projectId of [PROJECT_A, PROJECT_B]) {
        const rows = harness.storages
          .get(projectId)!
          .exec('SELECT COUNT(*) AS c FROM library_file_comment_threads')
          .toArray()[0] as { c: number };
        expect(rows.c).toBe(0);
      }
    });

    it('404s when a thread id from one file is replayed against another file', async () => {
      const created = (await (
        await post(commentsPath(PROJECT_A, FILE_A), { body: 'Owned by file A' })
      ).json()) as { thread: { id: string } };

      const stolen = await post(
        `${commentsPath(PROJECT_A, FILE_A2)}/${created.thread.id}/resolve`,
        {}
      );
      expect(stolen.status).toBe(404);

      // Owner-path control: the same call on the correct file succeeds, so the
      // 404 above is the scoping guard and not a broken resolve endpoint.
      const owner = await post(
        `${commentsPath(PROJECT_A, FILE_A)}/${created.thread.id}/resolve`,
        {}
      );
      expect(owner.status).toBe(200);
    });

    it('does not leak one project’s threads into another project', async () => {
      await post(commentsPath(PROJECT_A, FILE_A), { body: 'Project A comment' });
      await post(commentsPath(PROJECT_B, FILE_B), { body: 'Project B comment' });

      const a = (await (await get(PROJECT_A, FILE_A)).json()) as {
        threads: Array<{ body: string }>;
      };
      const b = (await (await get(PROJECT_B, FILE_B)).json()) as {
        threads: Array<{ body: string }>;
      };

      expect(a.threads.map((t) => t.body)).toEqual(['Project A comment']);
      expect(b.threads.map((t) => t.body)).toEqual(['Project B comment']);
    });
  });

  it('surfaces a durable-object validation failure as 400 after the RPC hop strips the error class', async () => {
    const response = await post(commentsPath(PROJECT_A, FILE_A), { body: '   ' });

    expect(response.status).toBe(400);
  });

  it('enforces the configured per-file thread limit end to end', async () => {
    harness.env.COMMENT_THREADS_PER_SESSION_MAX = '1';

    expect((await post(commentsPath(PROJECT_A, FILE_A), { body: 'First' })).status).toBe(201);
    expect((await post(commentsPath(PROJECT_A, FILE_A), { body: 'Second' })).status).toBe(422);

    // The cap is per file, so a sibling file is unaffected.
    expect((await post(commentsPath(PROJECT_A, FILE_A2), { body: 'Elsewhere' })).status).toBe(201);
  });
});
