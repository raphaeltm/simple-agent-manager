import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';
import { computeProjectDataAlarmSectionTimes } from '../../src/durable-objects/project-data/alarm-schedule';
import { readProjectEventWakeLeaseUntil } from '../../src/durable-objects/project-data/project-events-wake-delivery';
import type { Env } from '../../src/durable-objects/project-data/types';

function probe(real: SqlStorage) {
  const cursors: SqlStorageCursor[] = [];
  let leaseQueries = 0;
  const sql = new Proxy(real, {
    get(target, key) {
      if (key !== 'exec') return Reflect.get(target, key);
      return (query: string, ...bindings: unknown[]) => {
        if (query.includes('AS lease_until')) leaseQueries++;
        const cursor = target.exec(query, ...bindings);
        cursors.push(cursor);
        return cursor;
      };
    },
  });
  return { sql, leaseQueries: () => leaseQueries, rowsRead: () => cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0) };
}

describe('event wake lease scheduling cost', () => {
  it('excludes retained history from every active task lookup and preserves lease deadlines', async () => {
    const stub = env.PROJECT_DATA.get(env.PROJECT_DATA.newUniqueId()) as DurableObjectStub<ProjectData>;
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const projectId = 'lease-cost-project';
      const now = Date.now();
      const scheduleEnv = { PROJECT_EVENT_WAKE_ENABLED: 'true' } as Env;
      sql.exec("INSERT INTO do_meta (key, value) VALUES ('projectId', ?)", projectId);
      for (let n = 0; n < 11; n++) {
        sql.exec(`INSERT INTO chat_sessions (id, workspace_id, task_id, status, message_count,
          started_at, created_at, updated_at) VALUES (?, ?, ?, 'active', 0, ?, ?, ?)`,
          `target-${n}`, `workspace-${n}`, `task-${n}`, now, now, now);
        sql.exec(`INSERT INTO acp_sessions (id, chat_session_id, workspace_id, node_id, status,
          created_at, updated_at, last_heartbeat_at) VALUES (?, ?, ?, 'node', 'running', ?, ?, ?)`,
          `acp-${n}`, `target-${n}`, `workspace-${n}`, now, now, now);
      }
      const before = probe(sql);
      const beforeTimes = computeProjectDataAlarmSectionTimes(before.sql, scheduleEnv, now);
      expect(before.leaseQueries()).toBe(22);
      expect(typeof beforeTimes.task_reconciliation).toBe('number');
      sql.exec(`WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 2000)
        INSERT INTO project_event_subscriptions (id, project_id, owner_type, owner_id,
          idempotency_key, idempotency_fingerprint, filter_json, filter_fingerprint, match_key_count,
          requested_delivery, resolved_delivery, target_session_id, lifecycle_state, created_at, updated_at)
        SELECT 'history-sub-' || n, ?, 'agent', 'owner', 'history-key-' || n, 'fp', '{}', 'fp', 0,
          'existing_session_prompt', 'queued_for_prompt_delivery', 'old-target-' || n, 'expired', 1, 1
        FROM history`, projectId);
      sql.exec(`INSERT INTO project_event_delivery_batches (id, project_id, subscription_id,
          idempotency_key, idempotency_fingerprint, state, requested_delivery, resolved_delivery,
          target_session_id, match_ids_json, event_count, created_at, updated_at, delivery_channel)
        SELECT 'history-batch-' || id, project_id, id, id, 'fp', 'expired', requested_delivery,
          resolved_delivery, target_session_id, '[]', 0, 1, 1, 'prompt_queue'
        FROM project_event_subscriptions WHERE project_id = ?`, projectId);
      const after = probe(sql);
      const afterTimes = computeProjectDataAlarmSectionTimes(after.sql, scheduleEnv, now);
      expect(after.leaseQueries()).toBe(22);
      expect(typeof afterTimes.task_reconciliation).toBe('number');
      expect(after.rowsRead()).toBeLessThanOrEqual(before.rowsRead() + 50);
      sql.exec("DELETE FROM do_meta WHERE key = 'projectId'");
      const legacy = probe(sql);
      expect(readProjectEventWakeLeaseUntil(legacy.sql, 'target-0', now)).toBeNull();
      expect(legacy.rowsRead()).toBeGreaterThan(3000);
      sql.exec("INSERT INTO do_meta (key, value) VALUES ('projectId', ?)", projectId);
      const repeated = probe(sql);
      for (let round = 0; round < 10; round++) {
        for (let n = 0; n < 11; n++) {
          expect(readProjectEventWakeLeaseUntil(repeated.sql, `target-${n}`, now)).toBeNull();
        }
      }
      expect(repeated.rowsRead()).toBeLessThan(1000);
      console.log(JSON.stringify({ metric: 'event_wake_lease_rows', baseline: before.rowsRead(),
        retained: after.rowsRead(), legacySingleLookup: legacy.rowsRead(), lookups110: repeated.rowsRead() }));
      sql.exec(`UPDATE project_event_subscriptions SET contract_version = 2, owner_version = 2,
        owner_project_id = ?, owner_chat_session_id = 'target-0', owner_task_id = 'task-0',
        target_session_id = 'target-0', lifecycle_state = 'active', expires_at = ?,
        delivery_lifetime_expires_at = ? WHERE id = 'history-sub-1'`,
        projectId, now + 10000, now + 20000);
      sql.exec(`UPDATE project_event_delivery_batches SET state = 'pending', target_session_id = 'target-0',
        delivery_expires_at = ?, readable_until = ? WHERE subscription_id = 'history-sub-1'`,
        now + 5000, now + 15000);
      expect(readProjectEventWakeLeaseUntil(sql, 'target-0', now)).toBe(now + 5000);
      sql.exec("DELETE FROM do_meta WHERE key = 'projectId'");
      expect(readProjectEventWakeLeaseUntil(sql, 'target-0', now)).toBe(now + 5000);
      sql.exec("INSERT INTO do_meta (key, value) VALUES ('projectId', ?)", projectId);
      sql.exec(`INSERT INTO project_event_subscriptions (id, project_id, owner_type, owner_id,
        idempotency_key, idempotency_fingerprint, filter_json, filter_fingerprint, match_key_count,
        requested_delivery, resolved_delivery, target_session_id, lifecycle_state, created_at, updated_at)
        VALUES ('foreign-sub', 'other-project', 'agent', 'owner', 'foreign', 'fp', '{}', 'fp', 0,
          'existing_session_prompt', 'queued_for_prompt_delivery', 'target-0', 'active', 1, 1)`);
      sql.exec(`INSERT INTO project_event_delivery_batches (id, project_id, subscription_id,
        idempotency_key, idempotency_fingerprint, state, requested_delivery, resolved_delivery,
        target_session_id, match_ids_json, event_count, created_at, updated_at, delivery_channel,
        delivery_expires_at, readable_until)
        VALUES ('foreign-batch', 'other-project', 'foreign-sub', 'foreign', 'fp', 'pending',
          'existing_session_prompt', 'queued_for_prompt_delivery', 'target-0', '[]', 1, 1, 1,
          'prompt_queue', ?, ?)`, now + 1000, now + 1000);
      expect(readProjectEventWakeLeaseUntil(sql, 'target-0', now)).toBe(now + 5000);
      sql.exec("UPDATE project_event_delivery_batches SET state = 'delivered' WHERE subscription_id = 'history-sub-1'");
      expect(readProjectEventWakeLeaseUntil(sql, 'target-0', now)).toBe(now + 10000);
      sql.exec("UPDATE project_event_subscriptions SET lifecycle_state = 'cancelled' WHERE id = 'history-sub-1'");
      expect(readProjectEventWakeLeaseUntil(sql, 'target-0', now)).toBe(now + 15000);
      expect(readProjectEventWakeLeaseUntil(sql, 'target-0', now + 15000)).toBeNull();
    });
  });
});
