import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectData } from '../../src/durable-objects/project-data';
import { computeProjectDataAlarmSectionTimes } from '../../src/durable-objects/project-data/alarm-schedule';
import { computeMailboxAlarmTime } from '../../src/durable-objects/project-data/mailbox';

function probe(real: SqlStorage) {
  const cursors: SqlStorageCursor[] = [];
  const sql = new Proxy(real, {
    get(target, key) {
      if (key !== 'exec') return Reflect.get(target, key);
      return (query: string, ...bindings: unknown[]) => {
        const cursor = target.exec(query, ...bindings);
        cursors.push(cursor);
        return cursor;
      };
    },
  });
  return { sql, rowsRead: () => cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0) };
}

describe('mailbox alarm scheduling query cost', () => {
  it('keeps polling due while reads stay bounded as delivered history grows', async () => {
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.newUniqueId()
    ) as DurableObjectStub<ProjectData>;
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const pollMs = 30_000;
      expect(computeMailboxAlarmTime(sql, pollMs)).toBeNull();
      sql.exec(`INSERT INTO chat_sessions (id, status, message_count, started_at, created_at, updated_at)
        VALUES ('target', 'active', 0, 1000, 1000, 1000)`);
      const seed = (prefix: string, count: number, deliveryState: string) => sql.exec(
        `WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < ?)
        INSERT INTO session_inbox (id, target_session_id, message_type, content, priority,
          created_at, message_class, delivery_state, sender_type, ack_required)
        SELECT ? || n, 'target', 'deliver', 'retained', 'normal', 1000,
          'deliver', ?, 'system', 0 FROM history`,
        count, prefix, deliveryState
      );
      seed('first-', 1, 'delivered');
      const baseline = probe(sql);
      expect(computeProjectDataAlarmSectionTimes(baseline.sql, {}).mailbox_delivery_sweep)
        .toBe(Date.now() + pollMs);
      seed('retained-', 12_000, 'delivered');
      const loaded = probe(sql);
      expect(computeProjectDataAlarmSectionTimes(loaded.sql, {}).mailbox_delivery_sweep)
        .toBe(Date.now() + pollMs);
      expect(loaded.rowsRead()).toBeLessThanOrEqual(baseline.rowsRead() + 10);
      const repeated = probe(sql);
      for (let n = 0; n < 100; n++) {
        expect(computeMailboxAlarmTime(repeated.sql, pollMs)).toBe(Date.now() + pollMs);
      }
      expect(repeated.rowsRead()).toBeLessThanOrEqual(200);
      console.log(JSON.stringify({ metric: 'mailbox_alarm_rows', baseline: baseline.rowsRead(),
        loaded: loaded.rowsRead(), repeated100: repeated.rowsRead() }));
      sql.exec("UPDATE session_inbox SET delivery_state = 'acked' WHERE delivery_state = 'delivered'");
      const terminal = probe(sql);
      expect(computeMailboxAlarmTime(terminal.sql, pollMs)).toBeNull();
      expect(terminal.rowsRead()).toBeLessThan(10);
      seed('queued-', 1, 'queued');
      expect(computeMailboxAlarmTime(sql, pollMs)).toBe(Date.now() + pollMs);
    });
  });
});
