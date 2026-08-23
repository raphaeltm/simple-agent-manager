import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import * as comments from '../../../src/durable-objects/project-data/comments';
import * as fileComments from '../../../src/durable-objects/project-data/library-file-comments';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { createSqlStorage } from './sql-storage-test-utils';

const HUMAN = { kind: 'human' as const, id: 'user-1', name: 'Ada' };

describe('ProjectData message comments', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  let env: Env;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    env = {} as Env;
    runMigrations(sql);
  });

  function seedSession(sessionId: string): void {
    sql.exec(
      `INSERT INTO chat_sessions (id, topic, started_at)
       VALUES (?, ?, ?)`,
      sessionId,
      `topic ${sessionId}`,
      Date.now()
    );
  }

  function seedMessage(sessionId: string, messageId: string, sequence: number): void {
    sql.exec(
      `INSERT INTO chat_messages
         (id, session_id, role, content, tool_metadata, created_at, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      messageId,
      sessionId,
      'assistant',
      `message ${messageId}`,
      null,
      Date.now() + sequence,
      sequence
    );
  }

  it('adds append-only migration tables and indexes', () => {
    const tables = sql
      .exec(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'comment_threads',
           'comment_replies',
           'comment_status_mutations'
         )
         ORDER BY name ASC`
      )
      .toArray()
      .map((row) => row.name);

    expect(tables).toEqual(['comment_replies', 'comment_status_mutations', 'comment_threads']);

    const indexes = sql
      .exec(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name LIKE 'idx_comment_%'
         ORDER BY name ASC`
      )
      .toArray()
      .map((row) => row.name);

    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_comment_replies_session',
        'idx_comment_replies_thread_sequence',
        'idx_comment_status_mutations_session',
        'idx_comment_threads_message',
        'idx_comment_threads_session_sequence',
        'idx_comment_threads_status',
      ])
    );
  });

  it('creates, lists, and idempotently replays message-anchored threads', () => {
    seedSession('session-a');
    seedMessage('session-a', 'message-a', 1);

    const created = comments.createCommentThread(sql, env, {
      sessionId: 'session-a',
      messageId: 'message-a',
      body: '  Needs clarification  ',
      quote: '  selected quote  ',
      clientMutationId: 'thread-key-1',
      actor: HUMAN,
    });

    expect(created.idempotent).toBe(false);
    expect(created.changed).toBe(true);
    expect(created.thread).toMatchObject({
      sessionId: 'session-a',
      anchor: { kind: 'message', messageId: 'message-a', quote: 'selected quote' },
      author: HUMAN,
      body: 'Needs clarification',
      status: 'open',
      sequence: 1,
      version: 1,
      clientMutationId: 'thread-key-1',
      replies: [],
    });

    const replay = comments.createCommentThread(sql, env, {
      sessionId: 'session-a',
      messageId: 'message-a',
      body: 'Needs clarification',
      quote: 'selected quote',
      clientMutationId: 'thread-key-1',
      actor: HUMAN,
    });
    expect(replay.idempotent).toBe(true);
    expect(replay.changed).toBe(false);
    expect(replay.thread.id).toBe(created.thread.id);

    expect(() =>
      comments.createCommentThread(sql, env, {
        sessionId: 'session-a',
        messageId: 'message-a',
        body: 'Different body',
        clientMutationId: 'thread-key-1',
        actor: HUMAN,
      })
    ).toThrow(comments.CommentIdempotencyConflictError);

    expect(comments.listCommentThreads(sql, env, { sessionId: 'session-a' })).toMatchObject({
      hasMore: false,
      threads: [{ id: created.thread.id, sequence: 1 }],
    });
  });

  it('appends replies and status transitions with stable sequence and version semantics', () => {
    seedSession('session-a');
    seedMessage('session-a', 'message-a', 1);
    const created = comments.createCommentThread(sql, env, {
      sessionId: 'session-a',
      messageId: 'message-a',
      body: 'Thread',
      clientMutationId: 'thread-key',
      actor: HUMAN,
    });

    const firstReply = comments.createCommentReply(sql, env, {
      sessionId: 'session-a',
      threadId: created.thread.id,
      body: 'First reply',
      clientMutationId: 'reply-key-1',
      actor: HUMAN,
    });
    const replay = comments.createCommentReply(sql, env, {
      sessionId: 'session-a',
      threadId: created.thread.id,
      body: 'First reply',
      clientMutationId: 'reply-key-1',
      actor: HUMAN,
    });
    const secondReply = comments.createCommentReply(sql, env, {
      sessionId: 'session-a',
      threadId: created.thread.id,
      body: 'Second reply',
      clientMutationId: 'reply-key-2',
      actor: HUMAN,
    });

    expect(firstReply.idempotent).toBe(false);
    expect(replay.idempotent).toBe(true);
    expect(replay.reply.id).toBe(firstReply.reply.id);
    expect(secondReply.thread.replies.map((reply) => reply.sequence)).toEqual([1, 2]);
    expect(secondReply.thread.version).toBe(3);

    const sent = comments.updateCommentThreadStatus(sql, env, {
      sessionId: 'session-a',
      threadId: created.thread.id,
      status: 'sent',
      clientMutationId: 'status-key-1',
      actor: HUMAN,
    });
    expect(sent.thread.status).toBe('sent');
    expect(sent.thread.sentBy).toEqual(HUMAN);
    expect(sent.thread.version).toBe(4);

    const sentReplay = comments.updateCommentThreadStatus(sql, env, {
      sessionId: 'session-a',
      threadId: created.thread.id,
      status: 'sent',
      clientMutationId: 'status-key-1',
      actor: HUMAN,
    });
    expect(sentReplay.idempotent).toBe(true);
    expect(sentReplay.changed).toBe(false);

    expect(() =>
      comments.updateCommentThreadStatus(sql, env, {
        sessionId: 'session-a',
        threadId: created.thread.id,
        status: 'resolved',
        clientMutationId: 'status-key-1',
        actor: HUMAN,
      })
    ).toThrow(comments.CommentIdempotencyConflictError);

    const resolved = comments.updateCommentThreadStatus(sql, env, {
      sessionId: 'session-a',
      threadId: created.thread.id,
      status: 'resolved',
      clientMutationId: 'status-key-2',
      actor: HUMAN,
    });
    const reopened = comments.updateCommentThreadStatus(sql, env, {
      sessionId: 'session-a',
      threadId: created.thread.id,
      status: 'open',
      clientMutationId: 'status-key-3',
      actor: HUMAN,
    });

    expect(resolved.thread.status).toBe('resolved');
    expect(reopened.thread.status).toBe('open');
    expect(reopened.thread.reopenedBy).toEqual(HUMAN);
    expect(reopened.thread.version).toBe(6);
  });

  it('rejects cross-session status mutations without mutating or disclosing the thread', () => {
    seedSession('session-a');
    seedSession('session-b');
    seedMessage('session-a', 'message-a', 1);

    const created = comments.createCommentThread(sql, env, {
      sessionId: 'session-a',
      messageId: 'message-a',
      body: 'Needs a fix',
      clientMutationId: 'thread-key',
      actor: HUMAN,
    });

    expect(() =>
      comments.updateCommentThreadStatus(sql, env, {
        sessionId: 'session-b',
        threadId: created.thread.id,
        status: 'resolved',
        clientMutationId: 'wrong-session-resolve',
        actor: HUMAN,
      })
    ).toThrow(comments.CommentNotFoundError);

    const sessionAThreads = comments.listCommentThreads(sql, env, { sessionId: 'session-a' });
    expect(sessionAThreads.threads).toHaveLength(1);
    expect(sessionAThreads.threads[0]).toMatchObject({
      id: created.thread.id,
      sessionId: 'session-a',
      status: 'open',
      resolvedAt: null,
      resolvedBy: null,
    });

    const sessionBThreads = comments.listCommentThreads(sql, env, { sessionId: 'session-b' });
    expect(sessionBThreads.threads).toHaveLength(0);
  });

  it('enforces message ownership, missing resources, validation, and configured limits', () => {
    seedSession('session-a');
    seedSession('session-b');
    seedMessage('session-a', 'message-a', 1);
    seedMessage('session-b', 'message-b', 1);

    expect(() =>
      comments.createCommentThread(sql, env, {
        sessionId: 'session-a',
        messageId: 'message-missing',
        body: 'Thread',
        actor: HUMAN,
      })
    ).toThrow(comments.CommentNotFoundError);

    expect(() =>
      comments.createCommentThread(sql, env, {
        sessionId: 'session-a',
        messageId: 'message-b',
        body: 'Thread',
        actor: HUMAN,
      })
    ).toThrow(comments.CommentNotFoundError);
    expect(() =>
      comments.listCommentThreads(sql, env, {
        sessionId: 'session-a',
        messageId: 'message-b',
      })
    ).toThrow(comments.CommentNotFoundError);

    env.COMMENT_BODY_MAX_LENGTH = '5';
    env.COMMENT_QUOTE_MAX_LENGTH = '4';
    env.COMMENT_IDEMPOTENCY_KEY_MAX_LENGTH = '3';

    expect(() =>
      comments.createCommentThread(sql, env, {
        sessionId: 'session-a',
        messageId: 'message-a',
        body: '',
        actor: HUMAN,
      })
    ).toThrow(comments.CommentValidationError);
    expect(() =>
      comments.createCommentThread(sql, env, {
        sessionId: 'session-a',
        messageId: 'message-a',
        body: 'too long',
        actor: HUMAN,
      })
    ).toThrow(comments.CommentValidationError);
    expect(() =>
      comments.createCommentThread(sql, env, {
        sessionId: 'session-a',
        messageId: 'message-a',
        body: 'ok',
        quote: 'quote',
        actor: HUMAN,
      })
    ).toThrow(comments.CommentValidationError);
    expect(() =>
      comments.createCommentThread(sql, env, {
        sessionId: 'session-a',
        messageId: 'message-a',
        body: 'ok',
        clientMutationId: 'long',
        actor: HUMAN,
      })
    ).toThrow(comments.CommentValidationError);

    env = {
      ...env,
      COMMENT_BODY_MAX_LENGTH: '100',
      COMMENT_QUOTE_MAX_LENGTH: '100',
      COMMENT_IDEMPOTENCY_KEY_MAX_LENGTH: '100',
      COMMENT_THREADS_PER_SESSION_MAX: '1',
      COMMENT_REPLIES_PER_THREAD_MAX: '1',
    };
    const thread = comments.createCommentThread(sql, env, {
      sessionId: 'session-a',
      messageId: 'message-a',
      body: 'Thread',
      actor: HUMAN,
    }).thread;
    expect(() =>
      comments.createCommentThread(sql, env, {
        sessionId: 'session-a',
        messageId: 'message-a',
        body: 'Another',
        actor: HUMAN,
      })
    ).toThrow(comments.CommentLimitExceededError);

    comments.createCommentReply(sql, env, {
      sessionId: 'session-a',
      threadId: thread.id,
      body: 'Reply',
      actor: HUMAN,
    });
    expect(() =>
      comments.createCommentReply(sql, env, {
        sessionId: 'session-a',
        threadId: thread.id,
        body: 'Another reply',
        actor: HUMAN,
      })
    ).toThrow(comments.CommentLimitExceededError);
  });

  it('lists with status, message, afterSequence, and limit filters in sequence order', () => {
    seedSession('session-a');
    seedMessage('session-a', 'message-a', 1);
    seedMessage('session-a', 'message-b', 2);

    const first = comments.createCommentThread(sql, env, {
      sessionId: 'session-a',
      messageId: 'message-a',
      body: 'First',
      actor: HUMAN,
    }).thread;
    const second = comments.createCommentThread(sql, env, {
      sessionId: 'session-a',
      messageId: 'message-a',
      body: 'Second',
      actor: HUMAN,
    }).thread;
    const third = comments.createCommentThread(sql, env, {
      sessionId: 'session-a',
      messageId: 'message-b',
      body: 'Third',
      actor: HUMAN,
    }).thread;

    comments.updateCommentThreadStatus(sql, env, {
      sessionId: 'session-a',
      threadId: second.id,
      status: 'resolved',
      actor: HUMAN,
    });
    comments.updateCommentThreadStatus(sql, env, {
      sessionId: 'session-a',
      threadId: third.id,
      status: 'sent',
      actor: HUMAN,
    });

    expect(
      comments
        .listCommentThreads(sql, env, { sessionId: 'session-a', messageId: 'message-a' })
        .threads.map((thread) => thread.id)
    ).toEqual([first.id, second.id]);
    expect(
      comments.listCommentThreads(sql, env, { sessionId: 'session-a', status: 'sent' }).threads
    ).toMatchObject([{ id: third.id, status: 'sent' }]);
    expect(
      comments
        .listCommentThreads(sql, env, { sessionId: 'session-a', afterSequence: 1 })
        .threads.map((thread) => thread.id)
    ).toEqual([second.id, third.id]);

    const firstPage = comments.listCommentThreads(sql, env, { sessionId: 'session-a', limit: 2 });
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.threads.map((thread) => thread.id)).toEqual([first.id, second.id]);
  });
});

describe('ProjectData library file comments', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  let env: Env;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    env = {} as Env;
    runMigrations(sql);
  });

  function seedSession(sessionId: string): void {
    sql.exec(
      `INSERT INTO chat_sessions (id, topic, started_at)
       VALUES (?, ?, ?)`,
      sessionId,
      `topic ${sessionId}`,
      Date.now()
    );
  }

  function seedMessage(sessionId: string, messageId: string, sequence: number): void {
    sql.exec(
      `INSERT INTO chat_messages
         (id, session_id, role, content, tool_metadata, created_at, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      messageId,
      sessionId,
      'assistant',
      `message ${messageId}`,
      null,
      Date.now() + sequence,
      sequence
    );
  }

  it('creates, lists, and idempotently replays file-anchored threads', () => {
    const created = fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-1',
      body: '  Needs review  ',
      quote: '  selected text  ',
      clientMutationId: 'file-thread-key-1',
      actor: HUMAN,
    });

    expect(created.idempotent).toBe(false);
    expect(created.changed).toBe(true);
    expect(created.thread).toMatchObject({
      fileId: 'file-1',
      anchor: { kind: 'library_file', fileId: 'file-1', quote: 'selected text' },
      author: HUMAN,
      body: 'Needs review',
      status: 'open',
      sequence: 1,
      version: 1,
      clientMutationId: 'file-thread-key-1',
      replies: [],
    });
    // A file thread is not session-scoped and must never carry a sessionId.
    expect('sessionId' in created.thread).toBe(false);

    const replay = fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-1',
      body: 'Needs review',
      quote: 'selected text',
      clientMutationId: 'file-thread-key-1',
      actor: HUMAN,
    });
    expect(replay.idempotent).toBe(true);
    expect(replay.changed).toBe(false);
    expect(replay.thread.id).toBe(created.thread.id);

    expect(() =>
      fileComments.createFileCommentThread(sql, env, {
        fileId: 'file-1',
        body: 'Different body',
        clientMutationId: 'file-thread-key-1',
        actor: HUMAN,
      })
    ).toThrow(comments.CommentIdempotencyConflictError);

    const listed = fileComments.listFileCommentThreads(sql, env, { fileId: 'file-1' });
    expect(listed.hasMore).toBe(false);
    expect(listed.threads).toHaveLength(1);
    expect(listed.threads[0]).toMatchObject({
      id: created.thread.id,
      fileId: 'file-1',
      sequence: 1,
    });
  });

  it('appends replies and status transitions on file threads', () => {
    const created = fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-1',
      body: 'File thread',
      clientMutationId: 'ft-key',
      actor: HUMAN,
    });

    const firstReply = fileComments.createFileCommentReply(sql, env, {
      fileId: 'file-1',
      threadId: created.thread.id,
      body: 'First reply',
      clientMutationId: 'reply-key-1',
      actor: HUMAN,
    });
    const replayReply = fileComments.createFileCommentReply(sql, env, {
      fileId: 'file-1',
      threadId: created.thread.id,
      body: 'First reply',
      clientMutationId: 'reply-key-1',
      actor: HUMAN,
    });
    const secondReply = fileComments.createFileCommentReply(sql, env, {
      fileId: 'file-1',
      threadId: created.thread.id,
      body: 'Second reply',
      clientMutationId: 'reply-key-2',
      actor: HUMAN,
    });

    expect(firstReply.idempotent).toBe(false);
    expect(replayReply.idempotent).toBe(true);
    expect(replayReply.reply.id).toBe(firstReply.reply.id);
    expect(secondReply.thread.replies.map((r) => r.sequence)).toEqual([1, 2]);
    // version: 1 (create) + 1 (reply 1) + 1 (reply 2) = 3
    expect(secondReply.thread.version).toBe(3);

    const resolved = fileComments.updateFileCommentThreadStatus(sql, env, {
      fileId: 'file-1',
      threadId: created.thread.id,
      status: 'resolved',
      clientMutationId: 'status-key-1',
      actor: HUMAN,
    });
    expect(resolved.thread.status).toBe('resolved');
    expect(resolved.thread.resolvedBy).toEqual(HUMAN);
    expect(resolved.thread.version).toBe(4);

    const resolvedReplay = fileComments.updateFileCommentThreadStatus(sql, env, {
      fileId: 'file-1',
      threadId: created.thread.id,
      status: 'resolved',
      clientMutationId: 'status-key-1',
      actor: HUMAN,
    });
    expect(resolvedReplay.idempotent).toBe(true);
    expect(resolvedReplay.changed).toBe(false);

    const reopened = fileComments.updateFileCommentThreadStatus(sql, env, {
      fileId: 'file-1',
      threadId: created.thread.id,
      status: 'open',
      clientMutationId: 'status-key-2',
      actor: HUMAN,
    });
    expect(reopened.thread.status).toBe('open');
    expect(reopened.thread.reopenedBy).toEqual(HUMAN);
    expect(reopened.thread.version).toBe(5);
  });

  it('rejects the message-only "sent" status on a file thread', () => {
    const created = fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-1',
      body: 'File thread',
      actor: HUMAN,
    });

    expect(() =>
      fileComments.updateFileCommentThreadStatus(sql, env, {
        fileId: 'file-1',
        threadId: created.thread.id,
        status: 'sent',
        actor: HUMAN,
      })
    ).toThrow(comments.CommentValidationError);

    // The rejected transition must not have mutated the thread.
    const after = fileComments.getFileCommentThread(sql, 'file-1', created.thread.id);
    expect(after).toMatchObject({ status: 'open', version: 1 });
  });

  describe('file scoping', () => {
    // Every read and mutate is scoped by file_id. A thread id alone must never
    // be enough to reach a thread that belongs to a different file — this is the
    // file-comment analogue of message-comment session isolation.

    it('does not return a thread through the wrong fileId', () => {
      const owned = fileComments.createFileCommentThread(sql, env, {
        fileId: 'file-owner',
        body: 'Owned thread',
        actor: HUMAN,
      });

      // Control: the correct fileId does resolve the thread.
      expect(fileComments.getFileCommentThread(sql, 'file-owner', owned.thread.id)).toMatchObject({
        id: owned.thread.id,
      });
      // Attack: a real thread id under someone else's fileId resolves to nothing.
      expect(fileComments.getFileCommentThread(sql, 'file-other', owned.thread.id)).toBeNull();
    });

    it('refuses to reply to a thread through the wrong fileId', () => {
      const owned = fileComments.createFileCommentThread(sql, env, {
        fileId: 'file-owner',
        body: 'Owned thread',
        actor: HUMAN,
      });

      expect(() =>
        fileComments.createFileCommentReply(sql, env, {
          fileId: 'file-other',
          threadId: owned.thread.id,
          body: 'Injected reply',
          actor: HUMAN,
        })
      ).toThrow(comments.CommentNotFoundError);

      // Nothing was written.
      const after = fileComments.getFileCommentThread(sql, 'file-owner', owned.thread.id);
      expect(after?.replies).toEqual([]);
      expect(after?.version).toBe(1);

      // Owner-path control: the legitimate fileId still works.
      const ok = fileComments.createFileCommentReply(sql, env, {
        fileId: 'file-owner',
        threadId: owned.thread.id,
        body: 'Legitimate reply',
        actor: HUMAN,
      });
      expect(ok.reply.body).toBe('Legitimate reply');
    });

    it('refuses to change status of a thread through the wrong fileId', () => {
      const owned = fileComments.createFileCommentThread(sql, env, {
        fileId: 'file-owner',
        body: 'Owned thread',
        actor: HUMAN,
      });

      expect(() =>
        fileComments.updateFileCommentThreadStatus(sql, env, {
          fileId: 'file-other',
          threadId: owned.thread.id,
          status: 'resolved',
          actor: HUMAN,
        })
      ).toThrow(comments.CommentNotFoundError);

      expect(fileComments.getFileCommentThread(sql, 'file-owner', owned.thread.id)).toMatchObject({
        status: 'open',
      });

      // Owner-path control.
      const ok = fileComments.updateFileCommentThreadStatus(sql, env, {
        fileId: 'file-owner',
        threadId: owned.thread.id,
        status: 'resolved',
        actor: HUMAN,
      });
      expect(ok.thread.status).toBe('resolved');
    });
  });

  it('keeps file threads and message threads in separate storage', () => {
    seedSession('session-x');
    seedMessage('session-x', 'message-x', 1);

    const messageThread = comments.createCommentThread(sql, env, {
      sessionId: 'session-x',
      messageId: 'message-x',
      body: 'Message comment',
      clientMutationId: 'msg-key',
      actor: HUMAN,
    });

    const fileThread = fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-2',
      body: 'File comment',
      clientMutationId: 'file-key',
      actor: HUMAN,
    });

    const sessionList = comments.listCommentThreads(sql, env, { sessionId: 'session-x' });
    expect(sessionList.threads).toHaveLength(1);
    expect(sessionList.threads[0]).toMatchObject({
      id: messageThread.thread.id,
      anchor: { kind: 'message', messageId: 'message-x' },
    });

    const fileList = fileComments.listFileCommentThreads(sql, env, { fileId: 'file-2' });
    expect(fileList.threads).toHaveLength(1);
    expect(fileList.threads[0]).toMatchObject({
      id: fileThread.thread.id,
      anchor: { kind: 'library_file', fileId: 'file-2' },
    });

    // Neither getter can reach across into the other table.
    expect(comments.getCommentThread(sql, 'session-x', fileThread.thread.id)).toBeNull();
    expect(fileComments.getFileCommentThread(sql, 'file-2', messageThread.thread.id)).toBeNull();

    // The tables are physically distinct.
    const messageRows = sql
      .exec('SELECT COUNT(*) AS c FROM comment_threads')
      .toArray()[0] as { c: number };
    const fileRows = sql
      .exec('SELECT COUNT(*) AS c FROM library_file_comment_threads')
      .toArray()[0] as { c: number };
    expect(messageRows.c).toBe(1);
    expect(fileRows.c).toBe(1);
  });

  it('enforces per-file thread limit', () => {
    env.COMMENT_THREADS_PER_SESSION_MAX = '1';

    fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-3',
      body: 'First file thread',
      actor: HUMAN,
    });

    expect(() =>
      fileComments.createFileCommentThread(sql, env, {
        fileId: 'file-3',
        body: 'Second file thread',
        actor: HUMAN,
      })
    ).toThrow(comments.CommentLimitExceededError);

    // The limit is per file, not global.
    const otherFile = fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-4',
      body: 'Thread on different file',
      actor: HUMAN,
    });
    expect(otherFile.thread.fileId).toBe('file-4');
  });

  it('rejects an empty fileId rather than creating an unreachable thread', () => {
    expect(() =>
      fileComments.createFileCommentThread(sql, env, {
        fileId: '   ',
        body: 'Orphan',
        actor: HUMAN,
      })
    ).toThrow(comments.CommentValidationError);
  });

  it('lists file threads with status and afterSequence filters', () => {
    const first = fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-5',
      body: 'First',
      actor: HUMAN,
    }).thread;
    const second = fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-5',
      body: 'Second',
      actor: HUMAN,
    }).thread;
    const third = fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-5',
      body: 'Third',
      actor: HUMAN,
    }).thread;

    fileComments.updateFileCommentThreadStatus(sql, env, {
      fileId: 'file-5',
      threadId: second.id,
      status: 'resolved',
      actor: HUMAN,
    });

    const openThreads = fileComments.listFileCommentThreads(sql, env, {
      fileId: 'file-5',
      status: 'open',
    });
    expect(openThreads.threads.map((t) => t.id)).toEqual([first.id, third.id]);

    const resolvedThreads = fileComments.listFileCommentThreads(sql, env, {
      fileId: 'file-5',
      status: 'resolved',
    });
    expect(resolvedThreads.threads).toMatchObject([{ id: second.id, status: 'resolved' }]);

    const afterFirst = fileComments.listFileCommentThreads(sql, env, {
      fileId: 'file-5',
      afterSequence: 1,
    });
    expect(afterFirst.threads.map((t) => t.id)).toEqual([second.id, third.id]);

    const afterSecond = fileComments.listFileCommentThreads(sql, env, {
      fileId: 'file-5',
      afterSequence: 2,
    });
    expect(afterSecond.threads.map((t) => t.id)).toEqual([third.id]);

    const firstPage = fileComments.listFileCommentThreads(sql, env, {
      fileId: 'file-5',
      limit: 2,
    });
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.threads.map((t) => t.id)).toEqual([first.id, second.id]);
  });

  it('skips a malformed row instead of failing the whole list read', () => {
    const good = fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-6',
      body: 'Good one',
      actor: HUMAN,
    }).thread;
    fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-6',
      body: 'Bad one',
      actor: HUMAN,
    });
    const alsoGood = fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-6',
      body: 'Also good',
      actor: HUMAN,
    }).thread;

    // Corrupt the middle row the way legacy data or a schema tightening would:
    // SQLite is dynamically typed, so a text value survives the NOT NULL column
    // but fails the valibot v.number(). See rule 50.
    sql.exec(`UPDATE library_file_comment_threads SET created_at = 'not-a-number' WHERE sequence = 2`);

    const listed = fileComments.listFileCommentThreads(sql, env, { fileId: 'file-6' });
    expect(listed.threads.map((t) => t.id)).toEqual([good.id, alsoGood.id]);
  });
});
