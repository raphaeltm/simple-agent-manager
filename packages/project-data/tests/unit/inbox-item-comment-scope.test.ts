/**
 * Inbox-item comment threads (inbox slice H1, DO migration 081) keep their anchor scope
 * (.claude/rules/63): a thread of one item cannot be reached through another item, nor through an
 * item id equal to a session id or a file id. Each attack is paired with an owner control.
 * Real SQLite, real migrations.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import * as comments from '../../src/do/comments';
import * as itemComments from '../../src/do/inbox-item-comments';
import * as fileComments from '../../src/do/library-file-comments';
import { runMigrations } from '../../src/do/migrations';
import { listProjectCommentInbox } from '../../src/do/project-comment-inbox';
import type { Env } from '../../src/do/types';
import { createSqlStorage } from '../fixtures/sql-storage';

const MAYA = { kind: 'human' as const, id: 'user-maya', name: 'Maya' };
const env = {} as Env;

describe('inbox item comment scope', () => {
  let sql: SqlStorage;
  let itemThreadId: string;
  let sessionThreadId: string;
  let fileThreadId: string;

  const replies = (threadId: string) =>
    sql
      .exec('SELECT COUNT(*) AS count FROM anchored_comment_replies WHERE thread_id = ?', threadId)
      .toArray()[0]?.count;

  beforeEach(() => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    sql = createSqlStorage(db);
    runMigrations(sql);
    sql.exec("INSERT INTO chat_sessions (id, topic, started_at) VALUES ('session-a', 'a', 1)");
    sql.exec(
      `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence)
       VALUES ('message-a', 'session-a', 'assistant', 'hi', NULL, 1, 1)`
    );
    itemThreadId = itemComments.createInboxItemComment(sql, env, {
      itemId: 'ask-1',
      body: 'Live mode or test mode?',
      actor: MAYA,
    }).thread.id;
    sessionThreadId = comments.createCommentThread(sql, env, {
      sessionId: 'session-a',
      messageId: 'message-a',
      body: 'private note',
      actor: MAYA,
    }).thread.id;
    fileThreadId = fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-1',
      body: 'file note',
      actor: MAYA,
    }).thread.id;
  });

  it('a reply through another item is refused and writes nothing; the right item works', () => {
    expect(() =>
      itemComments.createInboxItemComment(sql, env, {
        itemId: 'ask-2',
        threadId: itemThreadId,
        body: 'sneaky',
        actor: MAYA,
      })
    ).toThrow();
    expect(replies(itemThreadId)).toBe(0);
    const ok = itemComments.createInboxItemComment(sql, env, {
      itemId: 'ask-1',
      threadId: itemThreadId,
      body: 'Live mode.',
      actor: MAYA,
    });
    expect(ok.thread.replies.map((reply) => reply.body)).toEqual(['Live mode.']);
  });

  it('an item id equal to a session or file id cannot reach that kind of thread', () => {
    for (const [itemId, threadId] of [
      ['session-a', sessionThreadId],
      ['file-1', fileThreadId],
    ] as const) {
      expect(() =>
        itemComments.createInboxItemComment(sql, env, {
          itemId,
          threadId,
          body: 'cross-kind',
          actor: MAYA,
        })
      ).toThrow();
      expect(replies(threadId)).toBe(0);
    }
    // Listing by an id equal to a session id returns only inbox-item threads.
    expect(
      itemComments.listInboxItemCommentThreads(sql, env, { itemId: 'session-a' }).threads
    ).toEqual([]);
    expect(
      itemComments.listInboxItemCommentThreads(sql, env, { itemId: 'ask-1' }).threads
    ).toHaveLength(1);
  });

  it('the table CHECK refuses an inbox-item row that names a file or another scope', () => {
    expect(() =>
      sql.exec(
        `INSERT INTO anchored_comment_threads (id, anchor_kind, scope_key, inbox_item_id, file_id,
           body, author_type, author_id, status, created_at, updated_at, sequence)
         VALUES ('bad-1', 'inbox_item', 'ask-9', 'ask-9', 'file-9', 'x', 'human', 'u', 'open', 1, 1, 1)`
      )
    ).toThrow();
    expect(() =>
      sql.exec(
        `INSERT INTO anchored_comment_threads (id, anchor_kind, scope_key, inbox_item_id,
           body, author_type, author_id, status, created_at, updated_at, sequence)
         VALUES ('bad-2', 'inbox_item', 'ask-9', 'ask-8', 'x', 'human', 'u', 'open', 1, 1, 1)`
      )
    ).toThrow();
    expect(() =>
      sql.exec(
        `INSERT INTO anchored_comment_threads (id, anchor_kind, scope_key, file_id, inbox_item_id,
           body, author_type, author_id, status, created_at, updated_at, sequence)
         VALUES ('bad-3', 'library_file', 'file-9', 'file-9', 'ask-9', 'x', 'human', 'u', 'open', 1, 1, 1)`
      )
    ).toThrow();
  });

  it('the project Comments read returns inbox-item threads apart from message and file threads', () => {
    const inbox = listProjectCommentInbox(sql, env, { readableInboxItemIds: ['ask-1'] });
    expect(inbox.inboxItemThreads.map((thread) => thread.itemId)).toEqual(['ask-1']);
    expect(inbox.messageThreads).toHaveLength(1);
    expect(inbox.fileThreads).toHaveLength(1);
    expect(inbox.totalCount).toBe(3);
  });

  it('applies task visibility before page selection and counting', () => {
    const hidden = itemComments.createInboxItemComment(sql, env, {
      itemId: 'ask-hidden',
      body: 'hidden task discussion',
      actor: MAYA,
    }).thread;
    sql.exec(`UPDATE anchored_comment_threads SET updated_at = 9000 WHERE id = ?`, hidden.id);
    sql.exec(`UPDATE anchored_comment_threads SET updated_at = 8000 WHERE id = ?`, itemThreadId);
    sql.exec(`UPDATE anchored_comment_threads SET updated_at = 7000 WHERE id = ?`, fileThreadId);
    sql.exec(`UPDATE anchored_comment_threads SET updated_at = 1000 WHERE id = ?`, sessionThreadId);

    const inbox = listProjectCommentInbox(sql, env, {
      limit: 3,
      readableInboxItemIds: ['ask-1'],
    });

    expect(inbox.inboxItemThreads.map((thread) => thread.itemId)).toEqual(['ask-1']);
    expect(inbox.messageThreads.map((thread) => thread.id)).toEqual([sessionThreadId]);
    expect(inbox.fileThreads.map((thread) => thread.id)).toEqual([fileThreadId]);
    expect(inbox.totalCount).toBe(3);
    expect(inbox.hasMore).toBe(false);
  });

  it('counts readable task threads past one bind batch and honors the status filter', () => {
    // More readable ids than one statement may bind, so the count must batch them.
    const readable = Array.from({ length: 150 }, (_, index) => `ask-many-${index}`);
    for (const itemId of readable) {
      itemComments.createInboxItemComment(sql, env, { itemId, body: itemId, actor: MAYA });
    }
    itemComments.createInboxItemComment(sql, env, {
      itemId: 'ask-hidden',
      body: 'hidden task discussion',
      actor: MAYA,
    });
    sql.exec(
      `UPDATE anchored_comment_threads SET status = 'resolved'
        WHERE inbox_item_id IN ('ask-many-0', 'ask-many-1', 'ask-many-149', 'ask-hidden')`
    );
    const readableInboxItemIds = ['ask-1', ...readable];

    const all = listProjectCommentInbox(sql, env, { limit: 2, readableInboxItemIds });
    // 151 readable task threads + the message thread + the file thread; the hidden one is not.
    expect(all.totalCount).toBe(153);
    expect(all.hasMore).toBe(true);

    const open = listProjectCommentInbox(sql, env, {
      status: 'open',
      limit: 2,
      readableInboxItemIds,
    });
    expect(open.totalCount).toBe(150);

    const resolved = listProjectCommentInbox(sql, env, {
      status: 'resolved',
      limit: 10,
      readableInboxItemIds,
    });
    expect(resolved.totalCount).toBe(3);
    expect(resolved.inboxItemThreads.map((thread) => thread.itemId).sort()).toEqual([
      'ask-many-0',
      'ask-many-1',
      'ask-many-149',
    ]);
  });
});
