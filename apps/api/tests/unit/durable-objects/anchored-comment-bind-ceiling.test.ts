/**
 * Durable Object SQLite rejects a statement with more than 100 bound parameters
 * (mirrored by `D1_MAX_BOUND_PARAMETERS`); better-sqlite3 allows 32,766, so a fixture of any size passes
 * there unless the test observes the statement shape (.claude/rules/69, harness ceiling).
 *
 * Comment list limits go up to 500 threads and the project inbox up to 300, so every
 * id-list read must batch. These drive more threads than one batch through the real list,
 * inbox and session-topic reads, and assert both that every row came back and that no
 * statement bound more than the ceiling.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import * as comments from '@simple-agent-manager/project-data/internal/do/comments';
import { runMigrations } from '@simple-agent-manager/project-data/internal/do/migrations';
import { listProjectCommentInbox } from '@simple-agent-manager/project-data/internal/do/project-comment-inbox';
import type { Env } from '@simple-agent-manager/project-data/internal/do/types';
import { createSqlStorage } from './sql-storage-test-utils';

/**
 * Cloudflare's documented per-statement limit, written out rather than read from
 * `D1_MAX_BOUND_PARAMETERS`: if that constant were ever raised past the runtime's real
 * limit, production batching would follow it and only an independent literal would notice.
 */
const RUNTIME_BIND_CEILING = 100;
// Two full batches and a remainder, so an off-by-one cannot land on a clean boundary.
const THREADS = RUNTIME_BIND_CEILING * 2 + 1;
// Replies on threads in the first batch, the second batch and the remainder.
const REPLY_THREAD_INDEXES = [0, RUNTIME_BIND_CEILING + 5, THREADS - 1];
const ACTOR = { kind: 'human' as const, id: 'user-1', name: 'Ada' };

describe('comment reads stay under the bound-parameter ceiling', () => {
  let sql: SqlStorage;
  let maxBinds: number;
  const env = {
    COMMENT_LIST_LIMIT_MAX: '500',
    PROJECT_COMMENT_LIST_MAX: '300',
  } as Env;

  beforeEach(() => {
    const db = new Database(':memory:');
    const real = createSqlStorage(db);
    runMigrations(real);
    maxBinds = 0;
    sql = {
      ...real,
      exec(statement: string, ...params: unknown[]) {
        maxBinds = Math.max(maxBinds, params.length);
        return real.exec(statement, ...(params as never[]));
      },
    } as SqlStorage;

    for (let i = 0; i < THREADS; i++) {
      // One session per thread, so the inbox's session-topic read also crosses the ceiling.
      const sessionId = `session-${i}`;
      real.exec(
        'INSERT INTO chat_sessions (id, topic, started_at) VALUES (?, ?, 1)',
        sessionId,
        `Topic ${i}`
      );
      real.exec(
        `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence)
         VALUES (?, ?, 'assistant', 'hi', NULL, 1, 1)`,
        `message-${i}`,
        sessionId
      );
      comments.createCommentThread(real, env, {
        sessionId,
        messageId: `message-${i}`,
        body: `Comment ${i}`,
        actor: ACTOR,
      });
    }
    // All threads in one session as well, for the per-session list.
    for (let i = 0; i < THREADS; i++) {
      const { thread } = comments.createCommentThread(real, env, {
        sessionId: 'session-0',
        messageId: 'message-0',
        body: `Same session ${i}`,
        actor: ACTOR,
      });
      if (REPLY_THREAD_INDEXES.includes(i)) {
        comments.createCommentReply(real, env, {
          sessionId: 'session-0',
          threadId: thread.id,
          body: `Reply on ${i}`,
          actor: ACTOR,
        });
      }
    }
  });

  it('lists more threads than one batch in a session', () => {
    const listed = comments.listCommentThreads(sql, env, { sessionId: 'session-0', limit: 500 });
    expect(listed.threads).toHaveLength(THREADS + 1);
    const replies = listed.threads.flatMap((thread) =>
      thread.replies.map((reply) => [thread.body, reply.body])
    );
    expect(replies).toEqual(
      REPLY_THREAD_INDEXES.map((i) => [`Same session ${i}`, `Reply on ${i}`])
    );
    expect(maxBinds).toBeLessThanOrEqual(RUNTIME_BIND_CEILING);
  });

  it('hydrates an inbox page with more threads and sessions than one batch', () => {
    // Rank the one-thread-per-session threads first, so the page spans 201 sessions.
    sql.exec(
      "UPDATE anchored_comment_threads SET updated_at = 9000000000000 WHERE body LIKE 'Comment %'"
    );
    const inbox = listProjectCommentInbox(sql, env, { limit: 300 });
    expect(inbox.messageThreads).toHaveLength(300);
    expect(inbox.sessions.length).toBeGreaterThan(RUNTIME_BIND_CEILING);
    expect(maxBinds).toBeLessThanOrEqual(RUNTIME_BIND_CEILING);
  });
});
