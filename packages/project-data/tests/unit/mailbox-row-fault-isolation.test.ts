/**
 * One inbox row that no longer matches the row schema (this branch added strict picklists
 * for `delivery_intent` and `steer_outcome`) must not fail a whole mailbox read (rule 50).
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as mailbox from '../../src/do/mailbox';
import { runMigrations } from '../../src/do/migrations';
import { createSqlStorage } from '../fixtures/sql-storage';

describe('mailbox reads tolerate one malformed row', () => {
  let db: Database.Database;
  let sql: SqlStorage;

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
    sql.exec(
      `INSERT INTO chat_sessions
       (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at)
       VALUES ('chat', 'workspace', 'test', 'active', 0, 1, 1, 1)`
    );
    for (const id of ['good-1', 'bad', 'good-2']) {
      mailbox.enqueueMessage(sql, {
        id,
        targetSessionId: 'chat',
        sourceTaskId: null,
        senderType: 'agent',
        senderId: null,
        messageClass: 'deliver',
        content: id,
      });
    }
    // A value outside the picklist, as a future bug or partial repair could leave.
    db.prepare(`UPDATE session_inbox SET delivery_intent = 'sideways' WHERE id = 'bad'`).run();
  });

  afterEach(() => db.close());

  it('lists and pages the good rows', () => {
    expect(mailbox.getPendingMessages(sql, 'chat').map((m) => m.id)).toEqual(['good-1', 'good-2']);
    const listed = mailbox.listMessages(sql, { targetSessionId: 'chat' });
    expect(listed.messages.map((m) => m.id).sort()).toEqual(['good-1', 'good-2']);
    expect(listed.total).toBe(3);
  });

  it('reads one malformed row as missing and one good row as itself', () => {
    expect(mailbox.getMessage(sql, 'bad')).toBeNull();
    expect(mailbox.getMessage(sql, 'good-2')?.id).toBe('good-2');
  });

  it('returns nothing, without throwing, when every row is malformed', () => {
    db.prepare(`UPDATE session_inbox SET delivery_intent = 'sideways'`).run();
    expect(mailbox.getPendingMessages(sql, 'chat')).toEqual([]);
    expect(mailbox.listMessages(sql, { targetSessionId: 'chat' }).messages).toEqual([]);
  });
});
