/**
 * DO migration 073: legacy message and library-file comment rows move into the anchored
 * tables with every field preserved, the copy is a no-op when run again, pre-migration
 * idempotency keys still replay, and the parity check catches a bad copy.
 *
 * Runs the real migration chain on a real SQLite engine with foreign keys enforced, as
 * Durable Object SQLite does.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MIGRATIONS, runMigrations } from '../../../src/durable-objects/migrations';
import {
  checkLegacyCommentParity,
  copyLegacyCommentRows,
} from '../../../src/durable-objects/project-data/anchored-comments-migration';
import * as comments from '../../../src/durable-objects/project-data/comments';
import * as fileComments from '../../../src/durable-objects/project-data/library-file-comments';
import { listProjectCommentInbox } from '../../../src/durable-objects/project-data/project-comment-inbox';
import type { Env } from '../../../src/durable-objects/project-data/types';
import { createSqlStorage } from './sql-storage-test-utils';

const MIGRATION_073 = '073-anchored-comment-threads';
const OWNER = { kind: 'human' as const, id: 'user-owner', name: 'Owner' };

/** Apply every migration before 073 and record them, as an existing project object has. */
function migrateToBefore073(sql: SqlStorage): void {
  sql.exec(
    'CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)'
  );
  for (const migration of MIGRATIONS) {
    if (migration.name === MIGRATION_073) break;
    migration.run(sql);
    sql.exec('INSERT INTO migrations (name, applied_at) VALUES (?, ?)', migration.name, 1);
  }
}

function count(sql: SqlStorage, query: string): number {
  return Number(sql.exec(query).toArray()[0]?.count ?? 0);
}

describe('DO migration 073: anchored comment threads', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  const env = {} as Env;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    sql = createSqlStorage(db);
    migrateToBefore073(sql);
    seedLegacy(sql);
    runMigrations(sql);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('copies every legacy row and reads it back unchanged through the adapters', () => {
    const sent = comments.getCommentThread(sql, 'session-a', 'legacy-thread-sent');
    expect(sent).toEqual({
      id: 'legacy-thread-sent',
      sessionId: 'session-a',
      anchor: { kind: 'message', messageId: 'message-a1', quote: 'quoted text' },
      author: { kind: 'human', id: 'user-teammate', name: 'Teammate' },
      body: 'Please fix this',
      status: 'sent',
      createdAt: 1000,
      updatedAt: 1300,
      sequence: 1,
      version: 3,
      clientMutationId: 'client-thread-1',
      sentAt: 1300,
      sentBy: { kind: 'human', id: 'user-owner', name: 'Owner' },
      resolvedAt: null,
      resolvedBy: null,
      reopenedAt: null,
      reopenedBy: null,
      mentions: [{ userId: 'user-owner', displayName: 'Owner' }],
      replies: [
        {
          id: 'legacy-reply-1',
          threadId: 'legacy-thread-sent',
          sessionId: 'session-a',
          author: { kind: 'agent', id: 'agent-1', name: 'SAM agent' },
          body: 'On it',
          createdAt: 1100,
          sequence: 1,
          clientMutationId: null,
          mentions: [],
        },
      ],
    });

    const resolved = comments.getCommentThread(sql, 'session-b', 'legacy-thread-resolved');
    expect(resolved).toMatchObject({
      status: 'resolved',
      resolvedAt: 2200,
      resolvedBy: { kind: 'human', id: 'user-owner', name: 'Owner' },
      reopenedAt: 2100,
      reopenedBy: { kind: 'agent', id: 'agent-1', name: null },
    });

    const file = fileComments.getFileCommentThread(sql, 'file-1', 'legacy-file-thread');
    expect(file).toEqual({
      id: 'legacy-file-thread',
      fileId: 'file-1',
      anchor: { kind: 'library_file', fileId: 'file-1', quote: 'file quote' },
      author: { kind: 'human', id: 'user-owner', name: 'Owner' },
      body: 'Typo in heading',
      status: 'resolved',
      createdAt: 3000,
      updatedAt: 3200,
      sequence: 1,
      version: 2,
      clientMutationId: 'client-file-1',
      resolvedAt: 3200,
      resolvedBy: { kind: 'human', id: 'user-owner', name: 'Owner' },
      reopenedAt: null,
      reopenedBy: null,
      replies: [
        {
          id: 'legacy-file-reply',
          threadId: 'legacy-file-thread',
          author: { kind: 'human', id: 'user-teammate', name: 'Teammate' },
          body: 'Fixed',
          createdAt: 3100,
          sequence: 1,
          clientMutationId: 'client-file-reply-1',
        },
      ],
    });

    const inbox = listProjectCommentInbox(sql, env, {});
    expect(inbox.totalCount).toBe(3);
    expect(inbox.messageThreads.map((t) => t.id).sort()).toEqual([
      'legacy-thread-resolved',
      'legacy-thread-sent',
    ]);
    expect(inbox.fileThreads.map((t) => t.id)).toEqual(['legacy-file-thread']);
  });

  it('passes parity, and a second copy run writes nothing', () => {
    expect(checkLegacyCommentParity(sql)).toEqual({
      ok: true,
      checks: [
        { name: 'message_threads', legacyCount: 2, anchoredCount: 2, mismatched: 0 },
        { name: 'file_threads', legacyCount: 1, anchoredCount: 1, mismatched: 0 },
        { name: 'message_replies', legacyCount: 1, anchoredCount: 1, mismatched: 0 },
        { name: 'file_replies', legacyCount: 1, anchoredCount: 1, mismatched: 0 },
        { name: 'message_status_mutations', legacyCount: 1, anchoredCount: 1, mismatched: 0 },
        { name: 'file_status_mutations', legacyCount: 1, anchoredCount: 1, mismatched: 0 },
      ],
    });
    const before = count(sql, 'SELECT COUNT(*) AS count FROM anchored_comment_threads');
    copyLegacyCommentRows(sql);
    copyLegacyCommentRows(sql);
    expect(count(sql, 'SELECT COUNT(*) AS count FROM anchored_comment_threads')).toBe(before);
    expect(count(sql, 'SELECT COUNT(*) AS count FROM anchored_comment_replies')).toBe(2);
    expect(count(sql, 'SELECT COUNT(*) AS count FROM anchored_comment_status_mutations')).toBe(2);
    expect(checkLegacyCommentParity(sql).ok).toBe(true);
  });

  it('a later copy adds rows written to the legacy tables, but never overwrites copied rows', () => {
    // A Worker rolled back to pre-073 code writes the legacy tables (the documented rollback
    // hazard). Rolling forward re-runs the copy: missing rows arrive, copied rows stay as-is.
    sql.exec(
      `INSERT INTO comment_threads
         (id, session_id, anchor_kind, message_id, quote, body, author_type, author_id,
          author_name, status, created_at, updated_at, sequence, version)
       VALUES ('rollback-thread', 'session-b', 'message', 'message-b1', NULL, 'Written during rollback',
         'human', 'user-owner', 'Owner', 'open', 5000, 5000, 2, 1)`
    );
    sql.exec(
      `INSERT INTO comment_replies
         (id, thread_id, session_id, body, author_type, author_id, author_name, created_at, sequence)
       VALUES ('rollback-reply', 'rollback-thread', 'session-b', 'Rollback reply', 'human',
         'user-owner', 'Owner', 5100, 1)`
    );
    sql.exec(
      "UPDATE comment_threads SET status = 'open', updated_at = 6000 WHERE id = 'legacy-thread-resolved'"
    );
    sql.exec(
      `INSERT INTO comment_replies
         (id, thread_id, session_id, body, author_type, author_id, author_name, created_at, sequence)
       VALUES ('reply-on-copied', 'legacy-thread-resolved', 'session-b', 'Late reply', 'human',
         'user-owner', 'Owner', 6000, 1)`
    );

    copyLegacyCommentRows(sql);

    const threads = comments.listCommentThreads(sql, env, { sessionId: 'session-b' }).threads;
    const added = threads.find((t) => t.id === 'rollback-thread');
    expect(added?.body).toBe('Written during rollback');
    expect(added?.replies.map((r) => r.body)).toEqual(['Rollback reply']);
    const copied = threads.find((t) => t.id === 'legacy-thread-resolved');
    expect(copied?.replies.map((r) => r.body)).toEqual(['Late reply']);
    expect(copied?.status).toBe('resolved');
    expect(copied?.updatedAt).toBe(2200);
  });

  it('records the migration once, so the runner does not copy again', () => {
    runMigrations(sql);
    expect(
      count(sql, `SELECT COUNT(*) AS count FROM migrations WHERE name = '${MIGRATION_073}'`)
    ).toBe(1);
  });

  it('detects a copy that lost or changed a row', () => {
    sql.exec(
      "UPDATE anchored_comment_threads SET body = 'tampered' WHERE id = 'legacy-thread-sent'"
    );
    sql.exec("DELETE FROM anchored_comment_replies WHERE id = 'legacy-file-reply'");
    const report = checkLegacyCommentParity(sql);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'message_threads')).toMatchObject({
      legacyCount: 2,
      anchoredCount: 2,
      mismatched: 1,
    });
    expect(report.checks.find((c) => c.name === 'file_replies')).toMatchObject({
      legacyCount: 1,
      anchoredCount: 0,
      mismatched: 1,
    });
  });

  it('logs the parity result for the project when the migration runs', () => {
    const fresh = new Database(':memory:');
    fresh.pragma('foreign_keys = ON');
    const freshSql = createSqlStorage(fresh);
    migrateToBefore073(freshSql);
    seedLegacy(freshSql);
    freshSql.exec("INSERT INTO do_meta (key, value) VALUES ('projectId', 'project-1')");
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    runMigrations(freshSql);
    const lines = logs.mock.calls.map((call) => String(call[0]));
    const parity = lines.find((line) => line.includes('comments.migration_parity'));
    expect(parity).toBeDefined();
    expect(parity).toContain('"projectId":"project-1"');
    expect(parity).toContain('"ok":true');
    fresh.close();
  });

  it('replays idempotency keys that were stored before the migration', () => {
    // Same request as the legacy row: same key, same fingerprint inputs.
    const thread = comments.createCommentThread(sql, env, {
      sessionId: 'session-a',
      messageId: 'message-a1',
      body: 'Please fix this',
      quote: 'quoted text',
      clientMutationId: 'client-thread-1',
      actor: { kind: 'human', id: 'user-teammate', name: 'Teammate' },
      mentions: [{ userId: 'user-owner', displayName: 'Owner' }],
    });
    expect(thread).toMatchObject({ idempotent: true, thread: { id: 'legacy-thread-sent' } });

    const status = comments.updateCommentThreadStatus(sql, env, {
      sessionId: 'session-a',
      threadId: 'legacy-thread-sent',
      status: 'sent',
      clientMutationId: 'comment-directive-legacy-thread-sent',
      actor: OWNER,
    });
    expect(status).toMatchObject({ idempotent: true, changed: false });

    const reply = fileComments.createFileCommentReply(sql, env, {
      fileId: 'file-1',
      threadId: 'legacy-file-thread',
      body: 'Fixed',
      clientMutationId: 'client-file-reply-1',
      actor: { kind: 'human', id: 'user-teammate', name: 'Teammate' },
    });
    expect(reply).toMatchObject({ idempotent: true, reply: { id: 'legacy-file-reply' } });

    const fileStatus = fileComments.updateFileCommentThreadStatus(sql, env, {
      fileId: 'file-1',
      threadId: 'legacy-file-thread',
      status: 'resolved',
      clientMutationId: 'client-file-resolve',
      actor: OWNER,
    });
    expect(fileStatus).toMatchObject({ idempotent: true, changed: false });

    // A different request under a stored key still conflicts.
    expect(() =>
      comments.createCommentThread(sql, env, {
        sessionId: 'session-a',
        messageId: 'message-a1',
        body: 'Something else',
        clientMutationId: 'client-thread-1',
        actor: { kind: 'human', id: 'user-teammate', name: 'Teammate' },
      })
    ).toThrow(comments.CommentIdempotencyConflictError);
  });

  it('continues per-scope sequences after the copied rows', () => {
    const created = comments.createCommentThread(sql, env, {
      sessionId: 'session-a',
      messageId: 'message-a1',
      body: 'New after migration',
      actor: OWNER,
    });
    expect(created.thread.sequence).toBe(2);
    const fileCreated = fileComments.createFileCommentThread(sql, env, {
      fileId: 'file-1',
      body: 'New file comment',
      actor: OWNER,
    });
    expect(fileCreated.thread.sequence).toBe(2);
  });

  it('cascades message comment deletion with the message, as the legacy tables did', () => {
    sql.exec("DELETE FROM chat_messages WHERE id = 'message-b1'");
    expect(comments.getCommentThread(sql, 'session-b', 'legacy-thread-resolved')).toBeNull();
    expect(
      count(
        sql,
        "SELECT COUNT(*) AS count FROM comment_threads WHERE id = 'legacy-thread-resolved'"
      )
    ).toBe(0);
  });
});

function seedLegacy(sql: SqlStorage): void {
  for (const [session, message] of [
    ['session-a', 'message-a1'],
    ['session-b', 'message-b1'],
  ]) {
    sql.exec(
      'INSERT INTO chat_sessions (id, topic, started_at) VALUES (?, ?, ?)',
      session,
      session,
      1
    );
    sql.exec(
      `INSERT INTO chat_messages (id, session_id, role, content, tool_metadata, created_at, sequence)
       VALUES (?, ?, 'assistant', 'hello', NULL, 1, 1)`,
      message,
      session
    );
  }

  sql.exec(
    `INSERT INTO comment_threads
       (id, session_id, anchor_kind, message_id, quote, body, author_type, author_id, author_name,
        status, created_at, updated_at, sequence, version, client_mutation_id,
        client_mutation_fingerprint, sent_at, sent_by_type, sent_by_id, sent_by_name, mentions_json)
     VALUES ('legacy-thread-sent', 'session-a', 'message', 'message-a1', 'quoted text',
       'Please fix this', 'human', 'user-teammate', 'Teammate', 'sent', 1000, 1300, 1, 3,
       'client-thread-1', ?, 1300, 'human', 'user-owner', 'Owner', ?)`,
    // The fingerprint exactly as the pre-migration code stored it.
    JSON.stringify([
      'thread',
      'message-a1',
      'Please fix this',
      'quoted text',
      'human',
      'user-teammate',
      'mentions',
      'user-owner',
    ]),
    JSON.stringify([{ userId: 'user-owner', displayName: 'Owner' }])
  );
  sql.exec(
    `INSERT INTO comment_replies
       (id, thread_id, session_id, body, author_type, author_id, author_name, created_at, sequence)
     VALUES ('legacy-reply-1', 'legacy-thread-sent', 'session-a', 'On it', 'agent', 'agent-1',
       'SAM agent', 1100, 1)`
  );
  sql.exec(
    `INSERT INTO comment_status_mutations
       (thread_id, session_id, client_mutation_id, target_status, thread_version, created_at)
     VALUES ('legacy-thread-sent', 'session-a', 'comment-directive-legacy-thread-sent', 'sent', 3, 1300)`
  );
  sql.exec(
    `INSERT INTO comment_threads
       (id, session_id, anchor_kind, message_id, quote, body, author_type, author_id, author_name,
        status, created_at, updated_at, sequence, version, resolved_at, resolved_by_type,
        resolved_by_id, resolved_by_name, reopened_at, reopened_by_type, reopened_by_id)
     VALUES ('legacy-thread-resolved', 'session-b', 'message', 'message-b1', NULL, 'Done?',
       'human', 'user-owner', 'Owner', 'resolved', 2000, 2200, 1, 4, 2200, 'human', 'user-owner',
       'Owner', 2100, 'agent', 'agent-1')`
  );

  sql.exec(
    `INSERT INTO library_file_comment_threads
       (id, file_id, anchor_kind, quote, body, author_type, author_id, author_name, status,
        created_at, updated_at, sequence, version, client_mutation_id, client_mutation_fingerprint,
        resolved_at, resolved_by_type, resolved_by_id, resolved_by_name)
     VALUES ('legacy-file-thread', 'file-1', 'library_file', 'file quote', 'Typo in heading',
       'human', 'user-owner', 'Owner', 'resolved', 3000, 3200, 1, 2, 'client-file-1', ?, 3200,
       'human', 'user-owner', 'Owner')`,
    JSON.stringify([
      'file_thread',
      'file-1',
      'Typo in heading',
      'file quote',
      'human',
      'user-owner',
    ])
  );
  sql.exec(
    `INSERT INTO library_file_comment_replies
       (id, thread_id, file_id, body, author_type, author_id, author_name, created_at, sequence,
        client_mutation_id, client_mutation_fingerprint)
     VALUES ('legacy-file-reply', 'legacy-file-thread', 'file-1', 'Fixed', 'human',
       'user-teammate', 'Teammate', 3100, 1, 'client-file-reply-1', ?)`,
    JSON.stringify(['file_reply', 'legacy-file-thread', 'Fixed', 'human', 'user-teammate'])
  );
  sql.exec(
    `INSERT INTO library_file_comment_status_mutations
       (thread_id, file_id, client_mutation_id, target_status, thread_version, created_at)
     VALUES ('legacy-file-thread', 'file-1', 'client-file-resolve', 'resolved', 2, 3200)`
  );
}
