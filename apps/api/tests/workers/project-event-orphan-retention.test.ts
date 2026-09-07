import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { repairProjectEventOrphanMatches } from '../../src/durable-objects/project-data/project-events-orphan-retention';
import { markSchedulerSuccess } from '../../src/durable-objects/project-data/project-events-scheduler';
import { runProjectEventRetention } from '../../src/durable-objects/project-data/project-events-status-retention';
import type { Env } from '../../src/durable-objects/project-data/types';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const NOW = 100_000;
const INTERVAL = 86_400_000;
const projectId = 'orphan-window-project';
const matchId = (n: number) => `match-${String(n).padStart(8, '0')}`;
const retentionEnv = {
  PROJECT_EVENT_RETENTION_BATCH_ROWS: '2',
  PROJECT_EVENT_RETENTION_INTERVAL_MS: String(INTERVAL),
} as Env;

function seed(sql: SqlStorage, count: number): void {
  sql.exec(
    `INSERT INTO project_event_subscriptions
    (id, project_id, contract_version, owner_type, owner_id, idempotency_key,
     idempotency_fingerprint, filter_version, filter_json, filter_fingerprint,
     match_key_count, requested_delivery, resolved_delivery, lifecycle_state, created_at, updated_at)
    VALUES ('sub', ?, 1, 'agent', 'agent', 'key', 'fp', 1, '{"version":1}',
      'filter', 0, 'record_only', 'record_only', 'active', ?, ?)`,
    projectId,
    NOW,
    NOW
  );
  sql.exec(
    `INSERT INTO project_event_delivery_batches
    (id, project_id, subscription_id, idempotency_key, idempotency_fingerprint,
     state, requested_delivery, resolved_delivery, match_ids_json, event_count, created_at, updated_at)
    VALUES ('healthy-batch', ?, 'sub', 'batch-key', 'batch-fp', 'pending',
      'record_only', 'record_only', '[]', 0, ?, ?)`,
    projectId,
    NOW,
    NOW
  );
  sql.exec(
    `WITH RECURSIVE history(n) AS
    (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < ?)
    INSERT INTO project_events
    (id, project_id, contract_version, source, event_type, subject_type, subject_id,
     severity, delivery_key, payload_fingerprint, metadata_json, metadata_bytes,
     display_json, display_bytes, raw_payload_ref_bytes, occurred_at, received_at, updated_at, state)
    SELECT 'event-' || n, ?, 1, 'github', 'check_suite.completed', 'pull_request', 'subject',
      'warning', 'delivery-' || n, 'sha256:fp', '{}', 2, '{"untrusted":true}', 18, 0,
      ?, ?, ?, 'recorded' FROM history`,
    count,
    projectId,
    NOW,
    NOW,
    NOW
  );
  sql.exec(
    `WITH RECURSIVE history(n) AS
    (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < ?)
    INSERT INTO project_event_matches
    (id, project_id, event_id, subscription_id, state, matched_at, lifecycle_checked_at, batch_id)
    SELECT printf('match-%08d', n), ?, 'event-' || n, 'sub', 'batch_created', ?, 1000,
      'healthy-batch' FROM history`,
    count,
    projectId,
    NOW
  );
}

function checkpoint(sql: SqlStorage) {
  return sql
    .exec(
      `SELECT orphan_scan_lifecycle_at, orphan_scan_match_id, next_retention_at
    FROM project_event_wake_scheduler_state WHERE project_id = ?`,
      projectId
    )
    .toArray()[0];
}

// Observe real workerd counters after production code consumes its real cursors.
// This adapter neither rewrites queries nor supplies synthetic SQL results.
function measuredSql(sql: SqlStorage) {
  const cursors: Array<ReturnType<SqlStorage['exec']>> = [];
  const queries: string[] = [];
  const measured = new Proxy(sql, {
    get(target, property) {
      if (property !== 'exec') return Reflect.get(target, property, target);
      return (query: string, ...bindings: unknown[]) => {
        const cursor = target.exec(query, ...bindings);
        cursors.push(cursor);
        queries.push(query);
        return cursor;
      };
    },
  });
  return { sql: measured, cursors, queries };
}

describe('bounded durable orphan repair windows', () => {
  it('reports logical deletions while draining indexed attempts, matches, batches and events under one shared budget', async () => {
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(crypto.randomUUID())
    ) as DurableObjectStub<ProjectDataTestDouble>;
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      seed(sql, 1);
      sql.exec(
        "UPDATE project_event_delivery_batches SET state = 'failed' WHERE id = 'healthy-batch'"
      );
      sql.exec(
        `INSERT INTO project_event_delivery_attempts
        (id, project_id, batch_id, idempotency_key, idempotency_fingerprint, attempt_number,
         state, started_at, completed_at, created_at)
        VALUES ('attempt', ?, 'healthy-batch', 'attempt-key', 'attempt-fp', 1, 'failed', ?, ?, ?)`,
        projectId,
        NOW,
        NOW,
        NOW
      );
      const counters = [
        'deletedAttempts',
        'deletedMatches',
        'deletedBatches',
        'deletedEvents',
      ] as const;
      for (const [pass, expected] of counters.entries()) {
        const result = state.storage.transactionSync(() =>
          runProjectEventRetention(
            sql,
            { ...retentionEnv, PROJECT_EVENT_RETENTION_DAYS: '0' },
            projectId,
            { projectId, now: NOW + pass + 1, limit: 1, refreshAccounting: false }
          )
        );
        for (const counter of counters) expect(result[counter]).toBe(counter === expected ? 1 : 0);
        expect(result.hasMore).toBe(pass < counters.length - 1);
      }
    });
  });

  it.each([1_000, 20_000])(
    'bounds actual inspected rows across %i healthy matches and a deep persisted seek',
    async (count) => {
      const stub = env.PROJECT_DATA.get(
        env.PROJECT_DATA.idFromName(crypto.randomUUID())
      ) as DurableObjectStub<ProjectDataTestDouble>;
      await runInDurableObject(stub, (_instance, state) => {
        const sql = state.storage.sql;
        seed(sql, count);
        const first = measuredSql(sql);
        const result = repairProjectEventOrphanMatches(first.sql, projectId, NOW, 1, 2);
        expect(result).toEqual({
          mutated: 0,
          count: 0,
          hasMore: false,
          cursor: { lifecycleAt: 1000, matchId: matchId(2) },
        });
        expect(first.cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0)).toBeLessThan(30);
        expect(first.cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0)).toBe(0);
        expect(repairProjectEventOrphanMatches(sql, projectId, NOW, 0, 2)).toEqual(result);

        // A resumed invocation reads only its next window even near the end of the index.
        markSchedulerSuccess(sql, projectId, NOW, 'retention', NOW + INTERVAL, {
          lifecycleAt: 1000,
          matchId: matchId(count - 3),
        });
        sql.exec(
          'UPDATE project_event_matches SET batch_id = ? WHERE id = ?',
          'missing',
          matchId(count)
        );
        const resumed = measuredSql(sql);
        expect(repairProjectEventOrphanMatches(resumed.sql, projectId, NOW, 1, 2)).toEqual({
          mutated: 0,
          count: 0,
          hasMore: false,
          cursor: { lifecycleAt: 1000, matchId: matchId(count - 1) },
        });
        expect(resumed.cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0)).toBeLessThan(30);
        expect(resumed.cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0)).toBe(0);

        // This rejects the original LIMIT-after-anti-join implementation using real cost,
        // not a plan-name assertion: it must scan the entire healthy prefix to find one orphan.
        const oldQuery = sql.exec(
          `SELECT m.id FROM project_event_matches m
        WHERE m.project_id = ? AND m.state = 'batch_created' AND m.batch_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM project_event_delivery_batches b
          WHERE b.project_id = m.project_id AND b.id = m.batch_id)
        ORDER BY m.lifecycle_checked_at ASC, m.id LIMIT 2`,
          projectId
        );
        expect(oldQuery.toArray()).toEqual([{ id: matchId(count) }]);
        expect(oldQuery.rowsRead).toBeGreaterThan(count);

        // Deletions can leave a durable cursor beyond the remaining history.
        markSchedulerSuccess(sql, projectId, NOW, 'retention', NOW + INTERVAL, {
          lifecycleAt: 1000,
          matchId: matchId(count + 1),
        });
        const empty = measuredSql(sql);
        expect(repairProjectEventOrphanMatches(empty.sql, projectId, NOW, 1, 2)).toEqual({
          mutated: 0,
          count: 0,
          hasMore: false,
          cursor: null,
        });
        expect(empty.cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0)).toBeLessThan(30);
      });
    }
  );

  it('persists manual-call progress through healthy windows at normal cadence, then wraps and revisits disappeared parents', async () => {
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(crypto.randomUUID())
    ) as DurableObjectStub<ProjectDataTestDouble>;
    await runInDurableObject(stub, (_instance, state) => {
      seed(state.storage.sql, 5);
      state.storage.sql.exec(
        'UPDATE project_event_matches SET batch_id = ? WHERE id = ?',
        'missing',
        matchId(5)
      );
    });
    // Separate DO callbacks discard all local variables between passes. Only SQLite carries progress.
    for (const [pass, expected] of [
      [0, 2],
      [1, 4],
    ] as const) {
      await runInDurableObject(stub, (_instance, state) => {
        const sql = state.storage.sql;
        const now = NOW + pass;
        const observed = measuredSql(sql);
        const result = state.storage.transactionSync(() =>
          runProjectEventRetention(observed.sql, retentionEnv, projectId, {
            projectId,
            now,
            limit: 1,
            refreshAccounting: false,
          })
        );
        expect(result).toMatchObject({ repairedOrphanMatches: 0, hasMore: false });
        expect(checkpoint(sql)).toEqual({
          orphan_scan_lifecycle_at: 1000,
          orphan_scan_match_id: matchId(expected),
          next_retention_at: now + INTERVAL,
        });
        // One existing singleton scheduler statement; workerd also counts its index
        // writes. No mutation statement may target healthy business rows.
        const writes = observed.queries.filter((query) =>
          /^\s*(INSERT|UPDATE|DELETE)\b/i.test(query)
        );
        expect(writes).toHaveLength(1);
        expect(writes[0]).toMatch(/^INSERT INTO project_event_wake_scheduler_state/);
        expect(
          sql
            .exec(
              `SELECT DISTINCT state, matched_at, lifecycle_checked_at
          FROM project_event_matches`
            )
            .toArray()
        ).toEqual([{ state: 'batch_created', matched_at: NOW, lifecycle_checked_at: 1000 }]);
        markSchedulerSuccess(sql, projectId, now, 'materialization', now + 20);
        expect(checkpoint(sql)?.orphan_scan_match_id).toBe(matchId(expected));
      });
    }
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const result = state.storage.transactionSync(() =>
        runProjectEventRetention(sql, retentionEnv, projectId, {
          projectId,
          now: NOW + 2,
          limit: 1,
          refreshAccounting: false,
        })
      );
      expect(result).toMatchObject({ repairedOrphanMatches: 1, deletedMatches: 0, hasMore: false });
      expect(checkpoint(sql)?.orphan_scan_match_id).toBeNull();
      expect(
        sql
          .exec(
            'SELECT state, batch_id, matched_at, reason FROM project_event_matches WHERE id = ?',
            matchId(5)
          )
          .toArray()
      ).toEqual([
        {
          state: 'expired',
          batch_id: 'missing',
          matched_at: NOW,
          reason: 'retention_orphan_batch_repaired',
        },
      ]);
      sql.exec("DELETE FROM project_event_delivery_batches WHERE id = 'healthy-batch'");
      const revisit = state.storage.transactionSync(() =>
        runProjectEventRetention(sql, retentionEnv, projectId, {
          projectId,
          now: NOW + 3,
          limit: 1,
          refreshAccounting: false,
        })
      );
      expect(revisit).toMatchObject({ repairedOrphanMatches: 1, hasMore: true });
      expect(checkpoint(sql)?.orphan_scan_match_id).toBe(matchId(1));
      expect(
        sql.exec('SELECT state FROM project_event_matches WHERE id = ?', matchId(2)).toArray()
      ).toEqual([{ state: 'batch_created' }]);
    });
  });

  it('with zero remaining business budget still advances healthy rows but stops before a proven orphan', async () => {
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(crypto.randomUUID())
    ) as DurableObjectStub<ProjectDataTestDouble>;
    await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      seed(sql, 3);
      sql.exec('UPDATE project_event_matches SET batch_id = ? WHERE id = ?', 'missing', matchId(2));
      // Subscription expiry consumes the one shared mutation before orphan repair.
      sql.exec("UPDATE project_event_subscriptions SET expires_at = ? WHERE id = 'sub'", NOW);
      const result = state.storage.transactionSync(() =>
        runProjectEventRetention(sql, retentionEnv, projectId, {
          projectId,
          now: NOW,
          limit: 1,
          refreshAccounting: false,
        })
      );
      expect(result).toMatchObject({
        expiredSubscriptions: 1,
        repairedOrphanMatches: 0,
        hasMore: true,
      });
      expect(checkpoint(sql)?.orphan_scan_match_id).toBe(matchId(1));
      const next = state.storage.transactionSync(() =>
        runProjectEventRetention(sql, retentionEnv, projectId, {
          projectId,
          now: NOW + 1,
          limit: 1,
          refreshAccounting: false,
        })
      );
      expect(next).toMatchObject({
        expiredSubscriptions: 0,
        repairedOrphanMatches: 1,
        hasMore: false,
      });
      expect(checkpoint(sql)?.orphan_scan_match_id).toBeNull();
    });
  });
});
