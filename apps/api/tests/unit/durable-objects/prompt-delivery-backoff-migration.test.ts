import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS, runMigrations } from '../../../src/durable-objects/migrations';
import { resolveDurableExecutionConfig } from '../../../src/durable-objects/project-data/durable-execution-config';
import {
  applyPromptDeliveryResult,
  claimDuePromptDeliveries,
  computePromptDeliveryAlarmTime,
} from '../../../src/durable-objects/project-data/prompt-delivery';
import { createSqlStorage } from './sql-storage-test-utils';

describe('prompt target backoff additive migration', () => {
  it('upgrades a populated mailbox without changing messages or losing old retry deadlines', () => {
    const db = new Database(':memory:');
    try {
      const sql = createSqlStorage(db);
      sql.exec('CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
      for (const migration of MIGRATIONS) {
        if (migration.name === '062-prompt-delivery-target-backoff') break;
        migration.run(sql);
        sql.exec('INSERT INTO migrations VALUES (?, ?)', migration.name, 1);
      }
      sql.exec(`INSERT INTO chat_sessions (id, status, message_count, started_at, created_at, updated_at)
        VALUES ('target', 'active', 0, 1, 1, 1)`);
      sql.exec(`INSERT INTO session_inbox (id, target_session_id, message_type, content, priority,
        created_at, message_class, delivery_state, sender_type, ack_required, next_attempt_at)
        VALUES ('first', 'target', 'deliver', 'preserved first', 'normal', 1, 'deliver', 'retry_wait', 'system', 0, 50000),
          ('second', 'target', 'deliver', 'preserved second', 'normal', 2, 'deliver', 'queued', 'system', 0, NULL),
          ('history', 'target', 'deliver', 'retained history', 'normal', 0, 'deliver', 'acked', 'system', 0, NULL)`);
      const before = db.prepare('SELECT * FROM session_inbox ORDER BY rowid').all();
      runMigrations(sql);
      runMigrations(sql);
      expect(db.prepare('SELECT * FROM session_inbox ORDER BY rowid').all()).toEqual(before);
      const config = resolveDurableExecutionConfig({});
      expect(computePromptDeliveryAlarmTime(sql, config, 1000)).toBe(50000);
      expect(claimDuePromptDeliveries(sql, config, 49999)).toEqual([]);
      const [claim] = claimDuePromptDeliveries(sql, config, 50000);
      expect(claim?.message.id).toBe('first');
      expect(
        applyPromptDeliveryResult(
          sql,
          claim!,
          {
            kind: 'retry',
            reason: 'busy',
            error: 'busy',
            runtimeIdentity: null,
            capabilities: null,
          },
          config,
          50000
        )
      ).toBe(true);
      expect(computePromptDeliveryAlarmTime(sql, config, 50000)).toBe(50000 + config.retryBaseMs);
    } finally {
      db.close();
    }
  });
});
