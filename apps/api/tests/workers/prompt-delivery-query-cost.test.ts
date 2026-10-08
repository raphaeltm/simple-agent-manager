import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';
import { resolveDurableExecutionConfig } from '../../src/durable-objects/project-data/durable-execution-config';
import {
  applyPromptDeliveryResult,
  claimDuePromptDeliveries,
  computePromptDeliveryAlarmTime,
} from '../../src/durable-objects/project-data/prompt-delivery';

const config = resolveDurableExecutionConfig({});

function measure(sql: SqlStorage, fn: (metered: SqlStorage) => void) {
  const cursors: SqlStorageCursor[] = [];
  const metered = new Proxy(sql, {
    get(target, prop) {
      if (prop !== 'exec') return Reflect.get(target, prop);
      return (query: string, ...args: unknown[]) => {
        const cursor = target.exec(query, ...args);
        cursors.push(cursor);
        return cursor;
      };
    },
  });
  fn(metered);
  return cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0);
}

describe('prompt delivery query cost in Workers SQLite', () => {
  it('bounds claims and excludes 12000 retained messages from alarm/claim/expiry reads', async () => {
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.newUniqueId()
    ) as DurableObjectStub<ProjectData>;
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const now = Date.now();
      sql.exec(
        `INSERT INTO chat_sessions (id, status, message_count, started_at, created_at, updated_at)
        VALUES ('target', 'active', 0, ?, ?, ?)`,
        now,
        now,
        now
      );
      const seed = (prefix: string, count: number, deliveryState: string) =>
        sql.exec(
          `WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < ?)
          INSERT INTO session_inbox (id, target_session_id, message_type, content, priority,
            created_at, message_class, delivery_state, sender_type, ack_required, expires_at)
          SELECT ? || n, 'target', 'deliver', 'message', 'normal', ?, 'deliver', ?, 'system', 0, ? FROM history`,
          count,
          prefix,
          now,
          deliveryState,
          now + config.ttlMs
        );
      seed('pending-', 76, 'queued');
      const first = claimDuePromptDeliveries(sql, config, now);
      expect(first).toHaveLength(1);
      applyPromptDeliveryResult(
        sql,
        first[0]!,
        {
          kind: 'retry',
          reason: 'busy',
          error: 'busy',
          runtimeIdentity: null,
          capabilities: null,
        },
        config,
        now
      );
      const query = (metered: SqlStorage) => {
        expect(claimDuePromptDeliveries(metered, config, now + 1)).toEqual([]);
        expect(computePromptDeliveryAlarmTime(metered, config, now + 1)).toBe(
          now + config.retryBaseMs
        );
      };
      const withoutHistory = measure(sql, query);
      seed('retained-', 12000, 'acked');
      const withHistory = measure(sql, query);
      console.log(
        JSON.stringify({ metric: 'prompt_delivery_query_rows', withoutHistory, withHistory })
      );
      expect(withHistory).toBeLessThan(1000);
      expect(withHistory).toBeLessThanOrEqual(withoutHistory + 10);
      const next = claimDuePromptDeliveries(sql, config, now + config.retryBaseMs);
      expect(next.map((claim) => claim.message.id)).toEqual(['pending-1']);
      expect(next.length).toBeLessThanOrEqual(config.maxCandidatesPerAlarm);
    });
  });
});
