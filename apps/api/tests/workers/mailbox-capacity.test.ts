import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { enqueueMessage } from '../../src/durable-objects/project-data/mailbox';
import { isMailboxAtCapacity, MAILBOX_CAPACITY_QUERY } from '../../src/durable-objects/project-data/mailbox-capacity';
import { isTargetAtWakeCapacity } from '../../src/durable-objects/project-data/project-events-wake-targets';
import type { Env } from '../../src/durable-objects/project-data/types';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

describe('indexed project mailbox admission capacity', () => {
  it('ignores large retained history, bounds active reads, and shares ordinary/wake admission', async () => {
    const stub = env.PROJECT_DATA.get(env.PROJECT_DATA.idFromName(crypto.randomUUID())) as DurableObjectStub<ProjectDataTestDouble>;
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec(`INSERT INTO chat_sessions (id, task_id, status, message_count, started_at, created_at, updated_at)
        VALUES ('target', 'task', 'active', 0, 1000, 1000, 1000)`);
      sql.exec(`WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 10000)
        INSERT INTO session_inbox (id, target_session_id, source_task_id, message_type, content, priority,
          created_at, message_class, delivery_state, sender_type, sender_id, ack_required, delivery_attempts)
        SELECT 'history-' || n, 'old-chat', NULL, 'deliver', 'Retained message text', 'normal',
          1000, 'deliver', 'acked', 'system', 'test', 0, 1 FROM history`);
      const plan = sql.exec(`EXPLAIN QUERY PLAN ${MAILBOX_CAPACITY_QUERY}`, 2).toArray();
      expect(plan.some((row) => String(row.detail).includes('idx_session_inbox_active_capacity'))).toBe(true);
      const empty = sql.exec(MAILBOX_CAPACITY_QUERY, 2);
      expect(empty.toArray()).toEqual([{ cnt: 0 }]);
      expect(empty.rowsRead).toBeLessThan(10);
      expect(isMailboxAtCapacity(sql, 2)).toBe(false);
      for (let n = 0; n < 2; n++) enqueueMessage(sql, {
        id: `active-${n}`, targetSessionId: 'another-chat', senderType: 'system', senderId: 'test',
        messageClass: 'deliver', content: 'Active', maxMessages: 2, now: 1000,
      });
      const full = sql.exec(MAILBOX_CAPACITY_QUERY, 2);
      expect(full.toArray()).toEqual([{ cnt: 2 }]);
      expect(full.rowsRead).toBeLessThan(10);
      expect(isTargetAtWakeCapacity(sql, { MAILBOX_MAX_MESSAGES_PER_PROJECT: '2' } as Env, 'target')).toBe(true);
      expect(() => enqueueMessage(sql, {
        id: 'overflow', targetSessionId: 'target', senderType: 'system', senderId: 'test',
        messageClass: 'deliver', content: 'Must not admit', maxMessages: 2, now: 1000,
      })).toThrow(/message limit/);
      sql.exec("UPDATE session_inbox SET delivery_state = 'acked' WHERE id = 'active-0'");
      expect(isMailboxAtCapacity(sql, 2)).toBe(false);
      expect(sql.exec("SELECT content FROM session_inbox WHERE id = 'history-1'").toArray()).toEqual([{ content: 'Retained message text' }]);
    });
  });
});
