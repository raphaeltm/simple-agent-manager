/**
 * Vertical slice: HTTP request -> GET .../comments/:threadId/context -> capability check ->
 * ProjectData service boundary -> REAL durable-object SQLite (better-sqlite3, real
 * migrations) for two projects -> JSON response. Settings resolve through the real admin
 * settings store.
 *
 * The only stubs are system boundaries: membership (D1), the signed-in user, and the
 * ProjectData RPC hop, which delegates straight into the real DO modules against each
 * project's own SQLite, keyed exactly as `idFromName(projectId)` would be.
 */
import type Database from 'better-sqlite3';
import BetterSqlite from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { createAdminSettingsEnv } from '../helpers/admin-settings-env';
import { createSqlStorage } from '../unit/durable-objects/sql-storage-test-utils';

const PROJECT_A = 'project-a';
const PROJECT_B = 'project-b';
const VIEWER = 'user-1';

const harness = vi.hoisted(() => ({
  storages: new Map<string, SqlStorage>(),
  capabilityError: null as Error | null,
}));

vi.mock('drizzle-orm/d1', () => ({ drizzle: vi.fn(() => ({})) }));
vi.mock('../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
  getAuth: () => ({ user: { id: 'user-1', name: 'Ada', email: 'ada@example.com' } }),
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
  const comments = await vi.importActual<
    typeof import('../../src/durable-objects/project-data/comments')
  >('../../src/durable-objects/project-data/comments');
  const context = await vi.importActual<
    typeof import('../../src/durable-objects/project-data/message-context')
  >('../../src/durable-objects/project-data/message-context');
  const access = await vi.importActual<
    typeof import('../../src/durable-objects/project-data/session-access')
  >('../../src/durable-objects/project-data/session-access');
  const reads = await vi.importActual<
    typeof import('../../src/durable-objects/project-data/session-reads')
  >('../../src/durable-objects/project-data/session-reads');

  const sqlFor = (projectId: string): SqlStorage => {
    const storage = harness.storages.get(projectId);
    if (!storage) throw new Error(`no durable object storage seeded for ${projectId}`);
    return storage;
  };

  return {
    ...contracts,
    // Same composition as ProjectData.getSessionAccess.
    getSessionAccess: async (_env: Env, projectId: string, sessionId: string, userId: string) => {
      const sql = sqlFor(projectId);
      const resolved = access.resolveSessionAccess(sql, sessionId, userId);
      return {
        session: resolved.found ? reads.getSession(sql, sessionId) : null,
        access: resolved,
      };
    },
    getCommentThread: async (_env: Env, projectId: string, sessionId: string, threadId: string) =>
      comments.getCommentThread(sqlFor(projectId), sessionId, threadId),
    getMessageContextWindow: async (
      env: Env,
      projectId: string,
      sessionId: string,
      request: Parameters<typeof context.readSourceMessageContext>[3]
    ) =>
      context.readSourceMessageContext(
        sqlFor(projectId),
        env as never,
        { projectId, sessionId, ownerName: projectId, generation: 1, migrationId: null },
        request
      ),
  };
});

import { runMigrations } from '../../src/durable-objects/migrations';
import * as comments from '../../src/durable-objects/project-data/comments';
import { chatCommentRoutes } from '../../src/routes/chat-comments';

const HUMAN = { kind: 'human' as const, id: 'user-2', name: 'Grace' };

let databases: Database.Database[] = [];
let settings: ReturnType<typeof createAdminSettingsEnv>;

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as never);
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects/:projectId/sessions', chatCommentRoutes);
  return app;
}

function getContext(projectId: string, sessionId: string, threadId: string) {
  return createApp().request(
    `https://api.test/api/projects/${projectId}/sessions/${sessionId}/comments/${threadId}/context`,
    { method: 'GET' },
    settings.env
  );
}

function sqlOf(projectId: string): SqlStorage {
  const sql = harness.storages.get(projectId);
  if (!sql) throw new Error(`missing ${projectId}`);
  return sql;
}

function seedSession(projectId: string, sessionId: string, ownerUserId: string): void {
  sqlOf(projectId).exec(
    `INSERT INTO chat_sessions (id, topic, started_at, created_by_user_id) VALUES (?, ?, ?, ?)`,
    sessionId,
    `Topic of ${sessionId}`,
    1,
    ownerUserId
  );
}

function seedRows(projectId: string, sessionId: string, rows: Array<[string, string, string]>) {
  rows.forEach(([id, role, content], index) => {
    sqlOf(projectId).exec(
      `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      id,
      sessionId,
      role,
      content,
      1_000 + index,
      index + 1
    );
  });
}

function thread(projectId: string, sessionId: string, messageId: string, quote: string): string {
  return comments.createCommentThread(sqlOf(projectId), {} as never, {
    sessionId,
    messageId,
    quote,
    body: `About "${quote}"`,
    actor: HUMAN,
  }).thread.id;
}

interface ContextBody {
  thread: { id: string; sessionId: string; anchor: { messageId: string } };
  session: { id: string; topic: string | null };
  viewerAccess: string;
  anchor: { messageId: string; found: boolean };
  messages: Array<{ id: string; role: string; content: string; createdAt: number }>;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
}

describe('GET comment context — vertical slice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.storages.clear();
    harness.capabilityError = null;
    databases = [];
    settings = createAdminSettingsEnv();
    for (const projectId of [PROJECT_A, PROJECT_B]) {
      const db = new BetterSqlite(':memory:');
      databases.push(db);
      const sql = createSqlStorage(db);
      runMigrations(sql);
      harness.storages.set(projectId, sql);
    }
  });

  afterEach(() => {
    for (const db of databases) db.close();
    settings.sqlite.close();
  });

  /**
   * A user question, a streamed agent reply in four chunks, then two more turns. Message ids
   * are unique across a project's object, so a second session's rows carry `idPrefix`.
   */
  function seedConversation(
    projectId: string,
    sessionId: string,
    owner = VIEWER,
    idPrefix = ''
  ): void {
    seedSession(projectId, sessionId, owner);
    seedRows(projectId, sessionId, [
      [`${idPrefix}u1`, 'user', 'Why does the webhook retry?'],
      [`${idPrefix}a1`, 'assistant', 'It retries because '],
      [`${idPrefix}a2`, 'assistant', 'the handler returns 500 '],
      [`${idPrefix}a3`, 'assistant', 'when the ledger write happens before '],
      [`${idPrefix}a4`, 'assistant', 'the idempotency check.'],
      [`${idPrefix}u2`, 'user', 'Fix it.'],
      [`${idPrefix}a5`, 'assistant', 'Done.'],
    ]);
  }

  it('returns the thread, the viewer access and the whole anchored reply, landing data included', async () => {
    seedConversation(PROJECT_A, 'session-1');
    // Anchored to a later chunk of the reply: the chat could not resolve this before.
    const threadId = thread(PROJECT_A, 'session-1', 'a3', 'the ledger write happens before');

    const res = await getContext(PROJECT_A, 'session-1', threadId);

    expect(res.status).toBe(200);
    const body = (await res.json()) as ContextBody;
    expect(body.thread).toMatchObject({ id: threadId, sessionId: 'session-1' });
    expect(body.session).toEqual({ id: 'session-1', topic: 'Topic of session-1' });
    expect(body.viewerAccess).toBe('owner');
    expect(body.anchor).toEqual({ messageId: 'a3', found: true });
    // Default setting: six messages each side, so this short chat comes back whole.
    expect(body.messages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'a2',
      'a3',
      'a4',
      'u2',
      'a5',
    ]);
    expect(body).toMatchObject({ hasMoreBefore: false, hasMoreAfter: false });
    expect(body.messages.map((message) => message.content).join('')).toContain(
      'the ledger write happens before'
    );
  });

  it('applies the admin-configured context size', async () => {
    seedConversation(PROJECT_A, 'session-1');
    const threadId = thread(PROJECT_A, 'session-1', 'a1', 'It retries');
    settings.sqlite
      .prepare(
        `INSERT OR REPLACE INTO platform_settings (key, value, updated_at, updated_by)
         VALUES ('collaboration.commentContextMessages', '1', '2026-10-23T00:00:00Z', NULL)`
      )
      .run();

    const body = (await (await getContext(PROJECT_A, 'session-1', threadId)).json()) as ContextBody;

    // The reply (a1–a4) plus one message each side.
    expect(body.messages.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'a2',
      'a3',
      'a4',
      'u2',
    ]);
    expect(body).toMatchObject({ hasMoreBefore: false, hasMoreAfter: true });
  });

  it('reports a reader viewer, who cannot send to the agent', async () => {
    seedConversation(PROJECT_A, 'session-1', 'someone-else');
    const threadId = thread(PROJECT_A, 'session-1', 'u1', 'webhook');

    const body = (await (await getContext(PROJECT_A, 'session-1', threadId)).json()) as ContextBody;

    expect(body.viewerAccess).toBe('reader');
  });

  it('answers a thread whose message is gone with the thread and no messages', async () => {
    seedConversation(PROJECT_A, 'session-1');
    const threadId = thread(PROJECT_A, 'session-1', 'a5', 'Done');
    // Deleting a message cascades to its threads, so remove the row behind the foreign key's
    // back: the reader must still answer for a thread whose row cannot be read.
    sqlOf(PROJECT_A).exec('PRAGMA foreign_keys = OFF');
    sqlOf(PROJECT_A).exec(`DELETE FROM chat_messages WHERE id = 'a5'`);

    const res = await getContext(PROJECT_A, 'session-1', threadId);

    expect(res.status).toBe(200);
    const body = (await res.json()) as ContextBody;
    expect(body.thread.id).toBe(threadId);
    expect(body.anchor).toEqual({ messageId: 'a5', found: false });
    expect(body.messages).toEqual([]);
  });

  it('refuses a thread of another session in the same project, and serves the owning session', async () => {
    seedConversation(PROJECT_A, 'session-1');
    seedConversation(PROJECT_A, 'session-2', VIEWER, 's2-');
    const threadId = thread(PROJECT_A, 'session-1', 'a2', 'returns 500');

    // Attack: session-1's thread addressed through session-2.
    const attack = await getContext(PROJECT_A, 'session-2', threadId);
    expect(attack.status).toBe(404);
    const attackBody = JSON.stringify(await attack.json());
    expect(attackBody).not.toContain('returns 500');

    // Owner control: the same thread through its own session.
    expect((await getContext(PROJECT_A, 'session-1', threadId)).status).toBe(200);
  });

  it('refuses a thread id from another project, and serves it in its own project', async () => {
    seedConversation(PROJECT_A, 'session-1');
    seedConversation(PROJECT_B, 'session-1');
    const threadId = thread(PROJECT_A, 'session-1', 'a2', 'returns 500');

    // Attack: project A's thread id addressed through project B (same session id).
    const attack = await getContext(PROJECT_B, 'session-1', threadId);
    expect(attack.status).toBe(404);

    // Owner control.
    expect((await getContext(PROJECT_A, 'session-1', threadId)).status).toBe(200);
  });

  it('returns 404 for an unknown session and stops at the capability check', async () => {
    seedConversation(PROJECT_A, 'session-1');
    const threadId = thread(PROJECT_A, 'session-1', 'a2', 'returns 500');

    expect((await getContext(PROJECT_A, 'missing-session', threadId)).status).toBe(404);

    harness.capabilityError = new AppError(403, 'FORBIDDEN', 'Project capability is required');
    expect((await getContext(PROJECT_A, 'session-1', threadId)).status).toBe(403);
  });
});
