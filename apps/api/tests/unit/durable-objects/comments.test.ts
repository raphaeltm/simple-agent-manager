import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import * as comments from '../../../src/durable-objects/project-data/comments';
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
