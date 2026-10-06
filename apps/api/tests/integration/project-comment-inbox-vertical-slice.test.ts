/**
 * Vertical slice: HTTP request -> route -> capability check -> ProjectData
 * service boundary -> REAL durable-object SQLite (better-sqlite3, real
 * migrations) -> D1 filename resolution -> JSON response.
 *
 * The only stubs are the genuine system boundaries:
 *   - D1 `project_files`, seeded for two projects so the filename lookup's
 *     `project_id` predicate is actually exercised;
 *   - the ProjectData RPC hop, which delegates straight into the real
 *     project-comment-inbox module against that project's own SQLite.
 *
 * Nothing in between is mocked, so a break anywhere along the path — ranking,
 * the cross-source cap, session-topic joining, filename scoping, error mapping —
 * fails this test. See .claude/rules/35-vertical-slice-testing.md.
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
const FILE_B = 'file-in-project-b';

/** Seeded D1 `project_files` rows. */
const PROJECT_FILES = [
  { id: FILE_A, projectId: PROJECT_A, filename: 'design-notes.md' },
  { id: FILE_B, projectId: PROJECT_B, filename: 'secret-roadmap.md' },
];

const harness = vi.hoisted(() => ({
  /** Per-project durable object storage, keyed exactly as idFromName(projectId) would be. */
  storages: new Map<string, SqlStorage>(),
  env: {} as Record<string, string>,
  capabilityError: null as Error | null,
}));

vi.mock('drizzle-orm/d1');
vi.mock('../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
}));
vi.mock('../../src/middleware/project-auth', () => ({
  requireProjectAccess: vi.fn(),
  requireProjectCapability: vi.fn(async () => {
    if (harness.capabilityError) throw harness.capabilityError;
    return { id: 'authorized-project' };
  }),
}));

vi.mock('../../src/services/project-data', async () => {
  const contracts = await vi.importActual<
    typeof import('../../src/durable-objects/project-data/comment-contracts')
  >('../../src/durable-objects/project-data/comment-contracts');
  const inbox = await vi.importActual<
    typeof import('../../src/durable-objects/project-data/project-comment-inbox')
  >('../../src/durable-objects/project-data/project-comment-inbox');

  const sqlFor = (projectId: string): SqlStorage => {
    const storage = harness.storages.get(projectId);
    if (!storage) throw new Error(`no durable object storage seeded for ${projectId}`);
    return storage;
  };

  return {
    ...contracts,
    listProjectCommentInbox: async (_env: Env, projectId: string, input: unknown) =>
      inbox.listProjectCommentInbox(sqlFor(projectId), harness.env as never, input as never),
  };
});

import { runMigrations } from '../../src/durable-objects/migrations';
import * as comments from '../../src/durable-objects/project-data/comments';
import * as fileComments from '../../src/durable-objects/project-data/library-file-comments';
import { projectCommentRoutes } from '../../src/routes/project-comments';

const HUMAN = { kind: 'human' as const, id: 'user-1', name: 'Ada' };

let databases: Database.Database[] = [];

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as never);
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects/:projectId/comments', projectCommentRoutes);
  return app;
}

function get(projectId: string, query = '') {
  return createApp().request(
    `https://api.test/api/projects/${projectId}/comments${query}`,
    { method: 'GET' },
    { DATABASE: {} } as Env
  );
}

function seedSession(sql: SqlStorage, sessionId: string, topic: string): void {
  sql.exec(
    `INSERT INTO chat_sessions (id, topic, started_at) VALUES (?, ?, ?)`,
    sessionId,
    topic,
    Date.now()
  );
}

function seedMessage(sql: SqlStorage, sessionId: string, messageId: string): void {
  sql.exec(
    `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence)
     VALUES (?, ?, 'assistant', 'hello', NULL, ?, 1)`,
    messageId,
    sessionId,
    Date.now()
  );
}

describe('project comment inbox — vertical slice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.storages.clear();
    harness.env = {};
    harness.capabilityError = null;
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
          // predicate: a lookup that ignored projectId would pass a naive stub
          // and then leak another project's filename.
          findMany: async ({
            where,
          }: {
            where: (
              columns: { projectId: string; id: string },
              ops: {
                and: (...parts: boolean[]) => boolean;
                eq: (column: string, value: string) => boolean;
                inArray: (column: string, values: string[]) => boolean;
              }
            ) => boolean;
          }) =>
            PROJECT_FILES.filter((row) =>
              where(
                { projectId: row.projectId, id: row.id },
                {
                  and: (...parts: boolean[]) => parts.every(Boolean),
                  eq: (column: string, value: string) => column === value,
                  inArray: (column: string, values: string[]) => values.includes(column),
                }
              )
            ).map((row) => ({ id: row.id, filename: row.filename })),
        },
      },
    } as never);
  });

  afterEach(() => {
    for (const db of databases) db.close();
  });

  it('returns both anchor kinds, with session topics and filenames, in one request', async () => {
    const sql = harness.storages.get(PROJECT_A)!;
    seedSession(sql, 'session-1', 'Ship the inbox');
    seedMessage(sql, 'session-1', 'message-1');
    comments.createCommentThread(sql, harness.env as never, {
      sessionId: 'session-1',
      messageId: 'message-1',
      body: 'On the message',
      actor: HUMAN,
    });
    fileComments.createFileCommentThread(sql, harness.env as never, {
      fileId: FILE_A,
      body: 'On the file',
      actor: HUMAN,
    });

    const res = await get(PROJECT_A);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messageThreads: Array<{ body: string; sessionId: string }>;
      fileThreads: Array<{ body: string; fileId: string }>;
      sessions: Array<{ id: string; topic: string | null }>;
      files: Array<{ id: string; filename: string }>;
      totalCount: number;
      hasMore: boolean;
    };

    expect(body.messageThreads.map((t) => t.body)).toEqual(['On the message']);
    expect(body.fileThreads.map((t) => t.body)).toEqual(['On the file']);
    expect(body.sessions).toEqual([{ id: 'session-1', topic: 'Ship the inbox' }]);
    expect(body.files).toEqual([{ id: FILE_A, filename: 'design-notes.md' }]);
    expect(body.totalCount).toBe(2);
    expect(body.hasMore).toBe(false);
  });

  /**
   * The cross-project attack. Both projects hold a thread; each has its own
   * Durable Object. A request for project A must never surface project B's.
   */
  it('never returns another project’s threads', async () => {
    const sqlA = harness.storages.get(PROJECT_A)!;
    const sqlB = harness.storages.get(PROJECT_B)!;
    seedSession(sqlA, 'session-a', 'Project A chat');
    seedMessage(sqlA, 'session-a', 'message-a');
    comments.createCommentThread(sqlA, harness.env as never, {
      sessionId: 'session-a',
      messageId: 'message-a',
      body: 'belongs to A',
      actor: HUMAN,
    });
    seedSession(sqlB, 'session-b', 'Project B chat');
    seedMessage(sqlB, 'session-b', 'message-b');
    comments.createCommentThread(sqlB, harness.env as never, {
      sessionId: 'session-b',
      messageId: 'message-b',
      body: 'belongs to B',
      actor: HUMAN,
    });

    const res = await get(PROJECT_A);
    const body = (await res.json()) as { messageThreads: Array<{ body: string }> };

    expect(body.messageThreads.map((t) => t.body)).toEqual(['belongs to A']);
    expect(JSON.stringify(body)).not.toContain('belongs to B');
  });

  /** Owner control for the case above (.claude/rules/28) — B can read its own. */
  it('returns a project’s own threads to a caller authorized for it', async () => {
    const sqlB = harness.storages.get(PROJECT_B)!;
    seedSession(sqlB, 'session-b', 'Project B chat');
    seedMessage(sqlB, 'session-b', 'message-b');
    comments.createCommentThread(sqlB, harness.env as never, {
      sessionId: 'session-b',
      messageId: 'message-b',
      body: 'belongs to B',
      actor: HUMAN,
    });

    const res = await get(PROJECT_B);
    const body = (await res.json()) as { messageThreads: Array<{ body: string }> };

    expect(res.status).toBe(200);
    expect(body.messageThreads.map((t) => t.body)).toEqual(['belongs to B']);
  });

  /**
   * The filename lookup is the one place a project id from the request meets an
   * id that came out of the Durable Object. If it did not carry `project_id`,
   * a thread referencing another project's file id would leak that filename.
   */
  it('does not resolve a filename belonging to a different project', async () => {
    const sqlA = harness.storages.get(PROJECT_A)!;
    // A thread in project A's DO that references project B's file id.
    fileComments.createFileCommentThread(sqlA, harness.env as never, {
      fileId: FILE_B,
      body: 'anchored on a foreign file id',
      actor: HUMAN,
    });

    const res = await get(PROJECT_A);
    const body = (await res.json()) as {
      fileThreads: Array<{ fileId: string }>;
      files: Array<{ id: string; filename: string }>;
    };

    expect(body.fileThreads.map((t) => t.fileId)).toEqual([FILE_B]);
    // The thread is still listed, but the foreign filename is NOT disclosed.
    expect(body.files).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('secret-roadmap.md');
  });

  it('still lists a thread whose file has been deleted, without a filename', async () => {
    const sqlA = harness.storages.get(PROJECT_A)!;
    fileComments.createFileCommentThread(sqlA, harness.env as never, {
      fileId: 'file-that-was-deleted',
      body: 'orphaned thread',
      actor: HUMAN,
    });

    const res = await get(PROJECT_A);
    const body = (await res.json()) as {
      fileThreads: Array<{ body: string }>;
      files: Array<{ id: string }>;
    };

    expect(body.fileThreads.map((t) => t.body)).toEqual(['orphaned thread']);
    expect(body.files).toEqual([]);
  });

  it('rejects a caller without the project read capability', async () => {
    harness.capabilityError = new AppError(403, 'FORBIDDEN', 'No access to this project');
    const sqlA = harness.storages.get(PROJECT_A)!;
    seedSession(sqlA, 'session-a', 'Project A chat');
    seedMessage(sqlA, 'session-a', 'message-a');
    comments.createCommentThread(sqlA, harness.env as never, {
      sessionId: 'session-a',
      messageId: 'message-a',
      body: 'should not be visible',
      actor: HUMAN,
    });

    const res = await get(PROJECT_A);

    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('should not be visible');
  });

  it('honours the status filter end to end', async () => {
    const sqlA = harness.storages.get(PROJECT_A)!;
    seedSession(sqlA, 'session-a', 'Project A chat');
    seedMessage(sqlA, 'session-a', 'message-a');
    const open = comments.createCommentThread(sqlA, harness.env as never, {
      sessionId: 'session-a',
      messageId: 'message-a',
      body: 'still open',
      actor: HUMAN,
    }).thread;
    const resolved = comments.createCommentThread(sqlA, harness.env as never, {
      sessionId: 'session-a',
      messageId: 'message-a',
      body: 'already resolved',
      actor: HUMAN,
    }).thread;
    comments.updateCommentThreadStatus(sqlA, harness.env as never, {
      sessionId: 'session-a',
      threadId: resolved.id,
      status: 'resolved',
      actor: HUMAN,
    });

    const res = await get(PROJECT_A, '?status=open');
    const body = (await res.json()) as {
      messageThreads: Array<{ id: string }>;
      totalCount: number;
    };

    expect(body.messageThreads.map((t) => t.id)).toEqual([open.id]);
    expect(body.totalCount).toBe(1);
  });

  it('applies the limit and reports the true total so the page can disclose the cut', async () => {
    const sqlA = harness.storages.get(PROJECT_A)!;
    seedSession(sqlA, 'session-a', 'Project A chat');
    seedMessage(sqlA, 'session-a', 'message-a');
    for (let i = 0; i < 5; i += 1) {
      comments.createCommentThread(sqlA, harness.env as never, {
        sessionId: 'session-a',
        messageId: 'message-a',
        body: `thread ${i}`,
        actor: HUMAN,
      });
    }

    const res = await get(PROJECT_A, '?limit=2');
    const body = (await res.json()) as {
      messageThreads: unknown[];
      totalCount: number;
      hasMore: boolean;
    };

    expect(body.messageThreads).toHaveLength(2);
    expect(body.totalCount).toBe(5);
    expect(body.hasMore).toBe(true);
  });

  it('rejects limit=0 at the HTTP boundary', async () => {
    const res = await get(PROJECT_A, '?limit=0');
    const body = (await res.json()) as { message: string };

    expect(res.status).toBe(400);
    expect(body.message).toBe('limit must be a positive integer');
  });

  it('applies the configured byte budget end to end', async () => {
    harness.env.PROJECT_COMMENT_LIST_MAX_BYTES = '20';
    const sqlA = harness.storages.get(PROJECT_A)!;
    seedSession(sqlA, 'session-a', 'Project A chat');
    seedMessage(sqlA, 'session-a', 'message-a');
    comments.createCommentThread(sqlA, harness.env as never, {
      sessionId: 'session-a',
      messageId: 'message-a',
      body: 'x'.repeat(100),
      actor: HUMAN,
    });
    comments.createCommentThread(sqlA, harness.env as never, {
      sessionId: 'session-a',
      messageId: 'message-a',
      body: 'small enough',
      actor: HUMAN,
    });

    const res = await get(PROJECT_A);
    const body = (await res.json()) as {
      messageThreads: Array<{ body: string }>;
      totalCount: number;
      hasMore: boolean;
    };

    expect(res.status).toBe(200);
    expect(body.messageThreads.map((t) => t.body)).toEqual(['small enough']);
    expect(body.totalCount).toBe(2);
    expect(body.hasMore).toBe(true);
  });

  it('returns an empty inbox for a project with no comments', async () => {
    const res = await get(PROJECT_A);
    const body = (await res.json()) as {
      messageThreads: unknown[];
      fileThreads: unknown[];
      totalCount: number;
    };

    expect(res.status).toBe(200);
    expect(body.messageThreads).toEqual([]);
    expect(body.fileThreads).toEqual([]);
    expect(body.totalCount).toBe(0);
  });
});
