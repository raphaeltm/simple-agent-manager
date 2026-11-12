/**
 * Every comment entry point keeps its anchor scope (.claude/rules/63, rule 28 pattern 5).
 *
 * Real SQLite, real migrations. Each attack addresses a real thread id through the wrong
 * scope and asserts it is refused AND nothing changed; each has an owner control beside it
 * proving the same call succeeds through the right scope.
 *
 * Proven discriminating (recorded in the PR): with `ANCHOR_SCOPE_PREDICATE` changed to drop
 * the `scope_key = ?` conjunct, every cross-session and cross-file case goes red while the
 * owner controls stay green; with the `anchor_kind = ?` conjunct dropped instead, the
 * cross-kind cases (a file id equal to a session id) go red.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import * as comments from '@simple-agent-manager/project-data/internal/do/comments';
import * as fileComments from '@simple-agent-manager/project-data/internal/do/library-file-comments';
import { runMigrations } from '@simple-agent-manager/project-data/internal/do/migrations';
import type { Env } from '@simple-agent-manager/project-data/internal/do/types';
import { createSqlStorage } from './sql-storage-test-utils';

const ALICE = { kind: 'human' as const, id: 'user-alice', name: 'Alice' };
const MALLORY = { kind: 'human' as const, id: 'user-mallory', name: 'Mallory' };

describe('anchored comment scope isolation', () => {
  let sql: SqlStorage;
  const env = {} as Env;
  let sessionThreadId: string;
  let fileThreadId: string;
  // A file whose id is the same string as session A's id: only anchor_kind tells them apart.
  const COLLIDING_FILE_ID = 'session-a';

  function snapshot(threadId: string) {
    const row = sql
      .exec(
        'SELECT status, version, updated_at FROM anchored_comment_threads WHERE id = ?',
        threadId
      )
      .toArray()[0];
    const replies = sql
      .exec('SELECT COUNT(*) AS count FROM anchored_comment_replies WHERE thread_id = ?', threadId)
      .toArray()[0];
    const mutations = sql
      .exec(
        'SELECT COUNT(*) AS count FROM anchored_comment_status_mutations WHERE thread_id = ?',
        threadId
      )
      .toArray()[0];
    return { row, replies: replies?.count, mutations: mutations?.count };
  }

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    sql = createSqlStorage(db);
    runMigrations(sql);
    for (const [session, message] of [
      ['session-a', 'message-a'],
      ['session-b', 'message-b'],
    ]) {
      sql.exec(
        'INSERT INTO chat_sessions (id, topic, started_at) VALUES (?, ?, 1)',
        session,
        session
      );
      sql.exec(
        `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence)
         VALUES (?, ?, 'assistant', 'hi', NULL, 1, 1)`,
        message,
        session
      );
    }
    sessionThreadId = comments.createCommentThread(sql, env, {
      sessionId: 'session-a',
      messageId: 'message-a',
      body: 'Alice private note',
      actor: ALICE,
    }).thread.id;
    fileThreadId = fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-1',
      body: 'File note',
      actor: ALICE,
    }).thread.id;
  });

  describe('message threads across sessions', () => {
    it('get: another session cannot read the thread; its own session can', () => {
      expect(comments.getCommentThread(sql, 'session-b', sessionThreadId)).toBeNull();
      expect(comments.getCommentThread(sql, 'session-a', sessionThreadId)?.body).toBe(
        'Alice private note'
      );
    });

    it('list: another session lists nothing; its own session lists the thread', () => {
      expect(comments.listCommentThreads(sql, env, { sessionId: 'session-b' }).threads).toEqual([]);
      expect(
        comments.listCommentThreads(sql, env, { sessionId: 'session-a' }).threads.map((t) => t.id)
      ).toEqual([sessionThreadId]);
    });

    it('reply: refused through another session and nothing is written', () => {
      const before = snapshot(sessionThreadId);
      expect(() =>
        comments.createCommentReply(sql, env, {
          sessionId: 'session-b',
          threadId: sessionThreadId,
          body: 'injected',
          actor: MALLORY,
        })
      ).toThrow(comments.CommentNotFoundError);
      expect(snapshot(sessionThreadId)).toEqual(before);

      const owner = comments.createCommentReply(sql, env, {
        sessionId: 'session-a',
        threadId: sessionThreadId,
        body: 'legit reply',
        actor: ALICE,
      });
      expect(owner.thread.version).toBe(2);
    });

    it.each(['resolved', 'sent', 'open'] as const)(
      'status %s: refused through another session and nothing is written',
      (status) => {
        const before = snapshot(sessionThreadId);
        expect(() =>
          comments.updateCommentThreadStatus(sql, env, {
            sessionId: 'session-b',
            threadId: sessionThreadId,
            status,
            clientMutationId: `attack-${status}`,
            actor: MALLORY,
          })
        ).toThrow(comments.CommentNotFoundError);
        expect(snapshot(sessionThreadId)).toEqual(before);

        const owner = comments.updateCommentThreadStatus(sql, env, {
          sessionId: 'session-a',
          threadId: sessionThreadId,
          status: status === 'open' ? 'resolved' : status,
          clientMutationId: `owner-${status}`,
          actor: ALICE,
        });
        expect(owner.changed).toBe(true);
      }
    );

    it('idempotency keys are per session: a reused key never returns another session thread', () => {
      const first = comments.createCommentThread(sql, env, {
        sessionId: 'session-a',
        messageId: 'message-a',
        body: 'same body',
        clientMutationId: 'shared-key',
        actor: ALICE,
      });
      const second = comments.createCommentThread(sql, env, {
        sessionId: 'session-b',
        messageId: 'message-b',
        body: 'same body',
        clientMutationId: 'shared-key',
        actor: ALICE,
      });
      expect(second.idempotent).toBe(false);
      expect(second.thread.id).not.toBe(first.thread.id);
      expect(second.thread.sessionId).toBe('session-b');
    });
  });

  describe('library-file threads across files', () => {
    it('get and list: another file sees nothing; its own file sees the thread', () => {
      expect(fileComments.getFileCommentThread(sql, 'file-2', fileThreadId)).toBeNull();
      expect(fileComments.listFileCommentThreads(sql, env, { fileId: 'file-2' }).threads).toEqual(
        []
      );
      expect(fileComments.getFileCommentThread(sql, 'file-1', fileThreadId)?.body).toBe(
        'File note'
      );
    });

    it('reply and resolve: refused through another file and nothing is written', () => {
      const before = snapshot(fileThreadId);
      expect(() =>
        fileComments.createFileCommentReply(sql, env, {
          fileId: 'file-2',
          threadId: fileThreadId,
          body: 'injected',
          actor: MALLORY,
        })
      ).toThrow(comments.CommentNotFoundError);
      expect(() =>
        fileComments.updateFileCommentThreadStatus(sql, env, {
          fileId: 'file-2',
          threadId: fileThreadId,
          status: 'resolved',
          clientMutationId: 'attack-file',
          actor: MALLORY,
        })
      ).toThrow(comments.CommentNotFoundError);
      expect(snapshot(fileThreadId)).toEqual(before);

      expect(
        fileComments.updateFileCommentThreadStatus(sql, env, {
          fileId: 'file-1',
          threadId: fileThreadId,
          status: 'resolved',
          actor: ALICE,
        }).changed
      ).toBe(true);
    });
  });

  describe('across anchor kinds', () => {
    it('a file scope whose id equals a session id cannot reach the session thread', () => {
      const before = snapshot(sessionThreadId);
      expect(fileComments.getFileCommentThread(sql, COLLIDING_FILE_ID, sessionThreadId)).toBeNull();
      expect(
        fileComments.listFileCommentThreads(sql, env, { fileId: COLLIDING_FILE_ID }).threads
      ).toEqual([]);
      expect(() =>
        fileComments.createFileCommentReply(sql, env, {
          fileId: COLLIDING_FILE_ID,
          threadId: sessionThreadId,
          body: 'cross-kind',
          actor: MALLORY,
        })
      ).toThrow(comments.CommentNotFoundError);
      expect(() =>
        fileComments.updateFileCommentThreadStatus(sql, env, {
          fileId: COLLIDING_FILE_ID,
          threadId: sessionThreadId,
          status: 'resolved',
          actor: MALLORY,
        })
      ).toThrow(comments.CommentNotFoundError);
      expect(snapshot(sessionThreadId)).toEqual(before);
    });

    it('a session scope cannot reach a file thread', () => {
      expect(comments.getCommentThread(sql, 'file-1', fileThreadId)).toBeNull();
      const before = snapshot(fileThreadId);
      expect(() =>
        comments.updateCommentThreadStatus(sql, env, {
          sessionId: 'file-1',
          threadId: fileThreadId,
          status: 'sent',
          actor: MALLORY,
        })
      ).toThrow(comments.CommentNotFoundError);
      expect(snapshot(fileThreadId)).toEqual(before);
    });

    it('the schema refuses a row whose typed columns disagree with its scope', () => {
      expect(() =>
        sql.exec(
          `INSERT INTO anchored_comment_threads
             (id, anchor_kind, scope_key, session_id, message_id, file_id, body, author_type,
              author_id, created_at, updated_at, sequence)
           VALUES ('bad-1', 'message', 'session-b', 'session-a', 'message-a', NULL, 'x', 'human',
              'u', 1, 1, 1)`
        )
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        sql.exec(
          `INSERT INTO anchored_comment_threads
             (id, anchor_kind, scope_key, session_id, message_id, file_id, body, author_type,
              author_id, created_at, updated_at, sequence)
           VALUES ('bad-2', 'library_file', 'file-1', 'session-a', NULL, 'file-1', 'x', 'human',
              'u', 1, 1, 1)`
        )
      ).toThrow(/CHECK constraint failed/);
      expect(() =>
        sql.exec(
          `INSERT INTO anchored_comment_threads
             (id, anchor_kind, scope_key, file_id, body, author_type, author_id, created_at,
              updated_at, sequence, sent_at)
           VALUES ('bad-3', 'library_file', 'file-1', 'file-1', 'x', 'human', 'u', 1, 1, 1, 5)`
        )
      ).toThrow(/CHECK constraint failed/);
    });
  });
});
