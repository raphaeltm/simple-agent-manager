import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import * as comments from '../../../src/durable-objects/project-data/comments';
import * as fileComments from '../../../src/durable-objects/project-data/library-file-comments';
import { listProjectCommentInbox } from '../../../src/durable-objects/project-data/project-comment-inbox';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { createSqlStorage } from './sql-storage-test-utils';

const HUMAN = { kind: 'human' as const, id: 'user-1', name: 'Ada' };

describe('ProjectData project comment inbox', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  let env: Env;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    env = {} as Env;
    runMigrations(sql);
  });

  function seedSession(sessionId: string, topic: string | null = `topic ${sessionId}`): void {
    sql.exec(
      `INSERT INTO chat_sessions (id, topic, started_at) VALUES (?, ?, ?)`,
      sessionId,
      topic,
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

  /**
   * Creates a message thread and pins its `updated_at`.
   *
   * Pinning matters: the tests below deliberately make insertion order and
   * activity order disagree, which is the only way to prove the read ranks by
   * activity rather than by whatever order rows happened to be written in.
   */
  function messageThreadAt(
    sessionId: string,
    messageId: string,
    body: string,
    updatedAt: number
  ): string {
    const { thread } = comments.createCommentThread(sql, env, {
      sessionId,
      messageId,
      body,
      actor: HUMAN,
    });
    sql.exec(`UPDATE comment_threads SET updated_at = ? WHERE id = ?`, updatedAt, thread.id);
    return thread.id;
  }

  function fileThreadAt(fileId: string, body: string, updatedAt: number): string {
    const { thread } = fileComments.createFileCommentThread(sql, env, {
      fileId,
      body,
      actor: HUMAN,
    });
    sql.exec(
      `UPDATE library_file_comment_threads SET updated_at = ? WHERE id = ?`,
      updatedAt,
      thread.id
    );
    return thread.id;
  }

  it('returns threads from both anchor kinds in one read', () => {
    seedSession('s-1');
    seedMessage('s-1', 'm-1', 1);
    const messageId = messageThreadAt('s-1', 'm-1', 'On the message', 3_000);
    const fileId = fileThreadAt('file-1', 'On the file', 2_000);

    const inbox = listProjectCommentInbox(sql, env, {});

    expect(inbox.messageThreads.map((t) => t.id)).toEqual([messageId]);
    expect(inbox.fileThreads.map((t) => t.id)).toEqual([fileId]);
    expect(inbox.totalCount).toBe(2);
    expect(inbox.hasMore).toBe(false);
  });

  it('spans sessions — a project-wide read is not scoped to one conversation', () => {
    seedSession('s-1');
    seedSession('s-2');
    seedMessage('s-1', 'm-1', 1);
    seedMessage('s-2', 'm-2', 1);
    const first = messageThreadAt('s-1', 'm-1', 'In session one', 1_000);
    const second = messageThreadAt('s-2', 'm-2', 'In session two', 2_000);

    const inbox = listProjectCommentInbox(sql, env, {});

    expect(new Set(inbox.messageThreads.map((t) => t.id))).toEqual(new Set([first, second]));
  });

  it('orders what it returns by last activity', () => {
    seedSession('s-1');
    seedMessage('s-1', 'm-1', 1);

    const stale = messageThreadAt('s-1', 'm-1', 'Written first, untouched since', 1_000);
    const middle = messageThreadAt('s-1', 'm-1', 'Written second', 5_000);
    const freshest = messageThreadAt('s-1', 'm-1', 'Written last, replied to just now', 9_000);

    const inbox = listProjectCommentInbox(sql, env, {});

    expect(inbox.messageThreads.map((t) => t.id)).toEqual([freshest, middle, stale]);
  });

  /**
   * The discriminating ranking test — the one that pins the SQL `ORDER BY`.
   *
   * Ordering the *returned* list is not enough to prove the ranking is right,
   * because the cross-source merge re-sorts in memory anyway. What the SQL
   * ordering uniquely decides is **which rows survive truncation**, so the only
   * test that can catch a wrong ranking key is one where the page is smaller
   * than the table.
   *
   * Insertion order (and therefore `sequence`, which the session-scoped read
   * orders by, and which is the obvious thing to copy from `listCommentThreads`)
   * is deliberately the REVERSE of activity order here. Under `ORDER BY sequence`
   * the page fills with the five stalest threads and this fails.
   *
   * Verified discriminating: swapping `ORDER BY updated_at DESC` for
   * `ORDER BY sequence ASC` turns this red while the ordering test above stays
   * green.
   */
  it('selects the most recently active threads when the page cannot hold them all', () => {
    seedSession('s-1');
    seedMessage('s-1', 'm-1', 1);

    // Written oldest-activity-first, so sequence ascending == activity ascending.
    const byActivity: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      byActivity.push(messageThreadAt('s-1', 'm-1', `thread ${i}`, 1_000 + i * 100));
    }
    const mostRecentFive = byActivity.slice(5).reverse();

    const inbox = listProjectCommentInbox(sql, env, { limit: 5 });

    expect(inbox.messageThreads.map((t) => t.id)).toEqual(mostRecentFive);
    // And the stalest must NOT have been chosen.
    expect(inbox.messageThreads.map((t) => t.id)).not.toContain(byActivity[0]);
  });

  /** Same proof for the library-file table, which has its own query. */
  it('selects the most recently active file threads when the page cannot hold them all', () => {
    const byActivity: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      byActivity.push(fileThreadAt('file-1', `file thread ${i}`, 1_000 + i * 100));
    }
    const mostRecentThree = byActivity.slice(5).reverse();

    const inbox = listProjectCommentInbox(sql, env, { limit: 3 });

    expect(inbox.fileThreads.map((t) => t.id)).toEqual(mostRecentThree);
    expect(inbox.fileThreads.map((t) => t.id)).not.toContain(byActivity[0]);
  });

  it('ranks across anchor kinds together, interleaving the two tables by activity', () => {
    seedSession('s-1');
    seedMessage('s-1', 'm-1', 1);
    const oldMessage = messageThreadAt('s-1', 'm-1', 'old message thread', 1_000);
    const newMessage = messageThreadAt('s-1', 'm-1', 'new message thread', 4_000);
    const midFile = fileThreadAt('file-1', 'middle file thread', 2_500);

    const inbox = listProjectCommentInbox(sql, env, { limit: 2 });

    // The two most recent overall are newMessage (4000) and midFile (2500).
    // oldMessage (1000) must be cut even though message threads were written
    // first and there are more of them.
    expect(inbox.messageThreads.map((t) => t.id)).toEqual([newMessage]);
    expect(inbox.fileThreads.map((t) => t.id)).toEqual([midFile]);
    expect(inbox.messageThreads.map((t) => t.id)).not.toContain(oldMessage);
    expect(inbox.totalCount).toBe(3);
    expect(inbox.hasMore).toBe(true);
  });

  /**
   * The skew case from rule 65.
   *
   * One conversation holds enough threads to exhaust the whole budget on its
   * own. A single, more recent library thread must still make the page — a cap
   * applied per source, or a page filled from the message table before the file
   * table is consulted, buries it.
   */
  it('does not let one chatty conversation crowd out a more recent library thread', () => {
    seedSession('s-1');
    seedMessage('s-1', 'm-1', 1);
    for (let i = 0; i < 10; i += 1) {
      messageThreadAt('s-1', 'm-1', `chatter ${i}`, 1_000 + i);
    }
    const recentFile = fileThreadAt('file-1', 'the one that matters', 50_000);

    const inbox = listProjectCommentInbox(sql, env, { limit: 5 });

    expect(inbox.fileThreads.map((t) => t.id)).toEqual([recentFile]);
    expect(inbox.messageThreads).toHaveLength(4);
    expect(inbox.totalCount).toBe(11);
    expect(inbox.hasMore).toBe(true);
  });

  it('raising the limit is what admits more threads, not the shape of the data', () => {
    seedSession('s-1');
    seedMessage('s-1', 'm-1', 1);
    for (let i = 0; i < 10; i += 1) {
      messageThreadAt('s-1', 'm-1', `chatter ${i}`, 1_000 + i);
    }
    fileThreadAt('file-1', 'the one that matters', 50_000);

    const wide = listProjectCommentInbox(sql, env, { limit: 50 });

    expect(wide.messageThreads).toHaveLength(10);
    expect(wide.fileThreads).toHaveLength(1);
    expect(wide.hasMore).toBe(false);
    expect(wide.totalCount).toBe(11);
  });

  it('reports a total that exceeds the page, so a cut list cannot read as complete', () => {
    seedSession('s-1');
    seedMessage('s-1', 'm-1', 1);
    for (let i = 0; i < 6; i += 1) messageThreadAt('s-1', 'm-1', `thread ${i}`, 1_000 + i);
    for (let i = 0; i < 3; i += 1) fileThreadAt('file-1', `file thread ${i}`, 2_000 + i);

    const inbox = listProjectCommentInbox(sql, env, { limit: 4 });

    expect(inbox.messageThreads.length + inbox.fileThreads.length).toBe(4);
    expect(inbox.totalCount).toBe(9);
    expect(inbox.hasMore).toBe(true);
  });

  it('returns an identical sequence across repeated identical calls', () => {
    seedSession('s-1');
    seedMessage('s-1', 'm-1', 1);
    // All the same updatedAt, so only the tiebreak can order them.
    for (let i = 0; i < 8; i += 1) messageThreadAt('s-1', 'm-1', `tied ${i}`, 7_000);
    for (let i = 0; i < 4; i += 1) fileThreadAt('file-1', `tied file ${i}`, 7_000);

    const first = listProjectCommentInbox(sql, env, { limit: 6 });
    const second = listProjectCommentInbox(sql, env, { limit: 6 });

    expect(second.messageThreads.map((t) => t.id)).toEqual(first.messageThreads.map((t) => t.id));
    expect(second.fileThreads.map((t) => t.id)).toEqual(first.fileThreads.map((t) => t.id));
  });

  it('joins session topics for the sessions it returned', () => {
    seedSession('s-1', 'Ship the thing');
    seedSession('s-2', null);
    seedMessage('s-1', 'm-1', 1);
    seedMessage('s-2', 'm-2', 1);
    messageThreadAt('s-1', 'm-1', 'a', 2_000);
    messageThreadAt('s-2', 'm-2', 'b', 1_000);

    const inbox = listProjectCommentInbox(sql, env, {});
    const topics = new Map(inbox.sessions.map((s) => [s.id, s.topic]));

    expect(topics.get('s-1')).toBe('Ship the thing');
    expect(topics.get('s-2')).toBeNull();
  });

  it('does not emit a session topic for a session that contributed no thread', () => {
    seedSession('s-1', 'Has a comment');
    seedSession('s-2', 'Has no comment');
    seedMessage('s-1', 'm-1', 1);
    messageThreadAt('s-1', 'm-1', 'only thread', 1_000);

    const inbox = listProjectCommentInbox(sql, env, {});

    expect(inbox.sessions.map((s) => s.id)).toEqual(['s-1']);
  });

  it('filters both anchor kinds by status', () => {
    seedSession('s-1');
    seedMessage('s-1', 'm-1', 1);
    const openMessage = messageThreadAt('s-1', 'm-1', 'still open', 3_000);
    const resolvedMessage = messageThreadAt('s-1', 'm-1', 'done', 2_000);
    sql.exec(`UPDATE comment_threads SET status = 'resolved' WHERE id = ?`, resolvedMessage);
    const openFile = fileThreadAt('file-1', 'still open', 1_500);
    const resolvedFile = fileThreadAt('file-1', 'done', 1_000);
    sql.exec(
      `UPDATE library_file_comment_threads SET status = 'resolved' WHERE id = ?`,
      resolvedFile
    );

    const open = listProjectCommentInbox(sql, env, { status: 'open' });

    expect(open.messageThreads.map((t) => t.id)).toEqual([openMessage]);
    expect(open.fileThreads.map((t) => t.id)).toEqual([openFile]);
    // totalCount must reflect the same filter, or the disclosure lies.
    expect(open.totalCount).toBe(2);
  });

  it('filters sent threads across both anchor kinds', () => {
    seedSession('s-1');
    seedMessage('s-1', 'm-1', 1);
    const openMessage = messageThreadAt('s-1', 'm-1', 'still open', 3_000);
    const sentMessage = messageThreadAt('s-1', 'm-1', 'sent to agent', 2_000);
    sql.exec(`UPDATE comment_threads SET status = 'sent' WHERE id = ?`, sentMessage);
    const sentFile = fileThreadAt('file-1', 'sent file', 1_500);
    sql.exec(`UPDATE library_file_comment_threads SET status = 'sent' WHERE id = ?`, sentFile);
    fileThreadAt('file-1', 'still open file', 1_000);

    const sent = listProjectCommentInbox(sql, env, { status: 'sent' });

    expect(sent.messageThreads.map((t) => t.id)).toEqual([sentMessage]);
    expect(sent.messageThreads.map((t) => t.id)).not.toContain(openMessage);
    expect(sent.fileThreads.map((t) => t.id)).toEqual([sentFile]);
    expect(sent.totalCount).toBe(2);
  });

  it('does not report truncation when both tables exactly meet the merged limit', () => {
    seedSession('s-1');
    seedMessage('s-1', 'm-1', 1);
    const messageOne = messageThreadAt('s-1', 'm-1', 'message one', 4_000);
    const messageTwo = messageThreadAt('s-1', 'm-1', 'message two', 3_000);
    const fileOne = fileThreadAt('file-1', 'file one', 2_000);
    const fileTwo = fileThreadAt('file-1', 'file two', 1_000);

    const inbox = listProjectCommentInbox(sql, env, { limit: 4 });

    expect(inbox.messageThreads.map((t) => t.id)).toEqual([messageOne, messageTwo]);
    expect(inbox.fileThreads.map((t) => t.id)).toEqual([fileOne, fileTwo]);
    expect(inbox.totalCount).toBe(4);
    expect(inbox.hasMore).toBe(false);
  });

  it('skips a malformed row instead of failing the whole read', () => {
    seedSession('s-1');
    seedMessage('s-1', 'm-1', 1);
    const good = messageThreadAt('s-1', 'm-1', 'good', 3_000);
    const bad = messageThreadAt('s-1', 'm-1', 'bad', 2_000);
    const alsoGood = messageThreadAt('s-1', 'm-1', 'also good', 1_000);
    const goodFile = fileThreadAt('file-1', 'good file', 2_500);
    const badFile = fileThreadAt('file-1', 'bad file', 2_400);

    // SQLite is dynamically typed, so a text value survives the NOT NULL column
    // but fails the valibot v.number() (rule 50).
    sql.exec(`UPDATE comment_threads SET created_at = 'not-a-number' WHERE id = ?`, bad);
    sql.exec(
      `UPDATE library_file_comment_threads SET created_at = 'not-a-number' WHERE id = ?`,
      badFile
    );

    const inbox = listProjectCommentInbox(sql, env, {});

    expect(inbox.messageThreads.map((t) => t.id)).toEqual([good, alsoGood]);
    expect(inbox.fileThreads.map((t) => t.id)).toEqual([goodFile]);
  });

  it('returns an empty inbox rather than throwing when the project has no comments', () => {
    seedSession('s-1');

    const inbox = listProjectCommentInbox(sql, env, {});

    expect(inbox.messageThreads).toEqual([]);
    expect(inbox.fileThreads).toEqual([]);
    expect(inbox.sessions).toEqual([]);
    expect(inbox.totalCount).toBe(0);
    expect(inbox.hasMore).toBe(false);
  });

  it('carries replies through, so the inbox can show depth and who moved last', () => {
    seedSession('s-1');
    seedMessage('s-1', 'm-1', 1);
    const threadId = messageThreadAt('s-1', 'm-1', 'root', 1_000);
    comments.createCommentReply(sql, env, {
      sessionId: 's-1',
      threadId,
      body: 'a reply',
      actor: { kind: 'agent', id: 'agent-1', name: 'SAM' },
    });

    const inbox = listProjectCommentInbox(sql, env, {});

    expect(inbox.messageThreads[0]?.replies.map((r) => r.body)).toEqual(['a reply']);
  });

  it('clamps a caller-supplied limit to the configured ceiling', () => {
    seedSession('s-1');
    seedMessage('s-1', 'm-1', 1);
    for (let i = 0; i < 5; i += 1) messageThreadAt('s-1', 'm-1', `thread ${i}`, 1_000 + i);

    // A negative limit reaching `LIMIT ?` means *unbounded* in SQLite, and a
    // non-finite one poisons the comparison. Both must fall back to the default.
    const negative = listProjectCommentInbox(sql, env, { limit: -1 });
    const notANumber = listProjectCommentInbox(sql, env, { limit: Number.NaN });

    expect(negative.messageThreads).toHaveLength(5);
    expect(notANumber.messageThreads).toHaveLength(5);

    const ceilinged = listProjectCommentInbox(
      { ...sql } as SqlStorage,
      {
        ...env,
        PROJECT_COMMENT_LIST_LIMIT: '2',
        PROJECT_COMMENT_LIST_MAX: '3',
      } as Env,
      { limit: 999 }
    );
    expect(ceilinged.messageThreads).toHaveLength(3);
  });

  it('applies the byte budget before hydrating rejected candidates', () => {
    seedSession('s-1');
    seedMessage('s-1', 'm-1', 1);
    const rejectedHeavy = messageThreadAt('s-1', 'm-1', 'x'.repeat(100), 9_000);
    const selectedSmall = messageThreadAt('s-1', 'm-1', 'small enough', 8_000);

    const calls: Array<{ statement: string; params: unknown[] }> = [];
    const tracedSql = {
      ...sql,
      exec(statement: string, ...params: unknown[]) {
        calls.push({ statement, params });
        return sql.exec(statement, ...(params as never[]));
      },
    } as SqlStorage;

    const inbox = listProjectCommentInbox(
      tracedSql,
      {
        ...env,
        PROJECT_COMMENT_LIST_MAX_BYTES: '20',
      } as Env,
      { limit: 2 }
    );

    expect(inbox.messageThreads.map((t) => t.id)).toEqual([selectedSmall]);
    expect(inbox.messageThreads.map((t) => t.id)).not.toContain(rejectedHeavy);
    expect(inbox.hasMore).toBe(true);
    expect(inbox.totalCount).toBe(2);

    const hydrateThreadCall = calls.find(
      (call) => call.statement.includes('FROM comment_threads') && call.statement.includes('id IN')
    );
    expect(hydrateThreadCall?.params).toEqual([selectedSmall]);

    const hydrateReplyCall = calls.find(
      (call) =>
        call.statement.includes('FROM comment_replies') && call.statement.includes('thread_id IN')
    );
    expect(hydrateReplyCall?.params).toEqual([selectedSmall]);
  });
});
