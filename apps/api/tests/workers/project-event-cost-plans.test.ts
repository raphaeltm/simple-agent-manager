/** Real SQLite counters and plans: no synthetic query results. */
import { MIGRATIONS } from '@simple-agent-manager/project-data/internal/do/migrations';
import { admitProjectEvent } from '@simple-agent-manager/project-data/internal/do/project-events';
import { runProjectEventRetention } from '@simple-agent-manager/project-data/internal/do/project-events-status-retention';
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../src/env';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const testEnv = env as unknown as Env;
const migration = MIGRATIONS.find(
  (entry) => entry.name === '077-project-event-storage-cost-indexes'
)!;
const stubFor = (projectId: string) =>
  env.PROJECT_DATA.get(
    env.PROJECT_DATA.idFromName(projectId)
  ) as DurableObjectStub<ProjectDataTestDouble>;
const inputFor = (projectId: string, deliveryKey: string) => ({
  projectId,
  source: 'github',
  eventType: 'check_suite.completed',
  subject: { type: 'commit', id: 'sha' },
  severity: 'info' as const,
  deliveryKey,
  payloadFingerprint: 'fp',
  metadata: {},
  display: { title: 'CI' },
  occurredAt: Date.now(),
  receivedAt: Date.now(),
});

function observe(sql: SqlStorage) {
  const statements: Array<{ query: string; bindings: unknown[]; cursor: SqlStorageCursor }> = [];
  const original = sql.exec.bind(sql);
  const spy = vi.spyOn(sql, 'exec').mockImplementation((query: string, ...bindings: unknown[]) => {
    const cursor = original(query, ...bindings);
    statements.push({ query, bindings, cursor });
    return cursor;
  });
  return {
    statements,
    restore: () => spy.mockRestore(),
    usage: () => ({
      read: statements.reduce((sum, entry) => sum + entry.cursor.rowsRead, 0),
      written: statements.reduce((sum, entry) => sum + entry.cursor.rowsWritten, 0),
    }),
  };
}

function restoreLegacyIndexes(sql: SqlStorage) {
  sql.exec('DROP INDEX idx_project_event_matches_event_id');
  sql.exec(
    'CREATE INDEX idx_project_events_project_source_type ON project_events(project_id,source,event_type,received_at DESC,id)'
  );
  sql.exec(
    'CREATE INDEX idx_project_events_project_subject ON project_events(project_id,subject_type,subject_id,received_at DESC,id)'
  );
  sql.exec(
    'CREATE INDEX idx_project_events_project_severity ON project_events(project_id,severity,received_at DESC,id)'
  );
  sql.exec(
    'CREATE INDEX idx_project_events_audience ON project_events(project_id,audience_scope,audience_user_id,received_at DESC,id)'
  );
}

function seedRetention(sql: SqlStorage, projectId: string) {
  const now = Date.now();
  sql.exec(
    `INSERT INTO project_event_subscriptions
    (id,project_id,owner_type,owner_id,idempotency_key,idempotency_fingerprint,filter_version,filter_json,filter_fingerprint,match_key_count,requested_delivery,resolved_delivery,lifecycle_state,created_at,updated_at)
    VALUES ('live',?,'agent','agent','key','fp',1,'{}','fp',0,'record_only','record_only','active',?,?)`,
    projectId,
    now,
    now
  );
  // A substantial healthy suffix must never be scanned for each expired deletion.
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2000)
    INSERT INTO project_events(id,project_id,source,event_type,subject_type,subject_id,severity,delivery_key,payload_fingerprint,metadata_json,metadata_bytes,display_json,display_bytes,occurred_at,received_at,updated_at,state)
    SELECT 'fresh-'||i,?,'github','check_suite.completed','commit','sha','info','fresh-'||i,'fp','{}',2,'{}',2,?,?,?,'recorded' FROM n`,
    projectId,
    now,
    now,
    now
  );
  sql.exec(
    `INSERT INTO project_event_matches(id,project_id,event_id,subscription_id,state,matched_at,lifecycle_checked_at)
    SELECT id,project_id,id,'live','matched',received_at,received_at FROM project_events WHERE project_id=?`,
    projectId
  );
  // More than the default 500-row batch, all with the same timestamp.
  sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<601)
    INSERT INTO project_events(id,project_id,source,event_type,subject_type,subject_id,severity,delivery_key,payload_fingerprint,metadata_json,metadata_bytes,display_json,display_bytes,occurred_at,received_at,updated_at,state)
    SELECT 'old-'||i,?,'github','check_suite.completed','commit','sha','info','old-'||i,'fp','{}',2,'{}',2,1,1,1,'recorded' FROM n`,
    projectId
  );
}

function plan(sql: SqlStorage, query: string, ...bindings: unknown[]): string {
  return sql
    .exec('EXPLAIN QUERY PLAN ' + query, ...bindings)
    .toArray()
    .map((row) => row.detail)
    .join('\n');
}

describe('project event physical storage cost', () => {
  it('cuts an event insert from nine to five rows and leaves an established retention checkpoint untouched', async () => {
    const projectId = 'cost-admission';
    await runInDurableObject(stubFor(projectId), (_instance, state) => {
      const sql = state.storage.sql;
      restoreLegacyIndexes(sql);
      const observed = observe(sql);
      try {
        admitProjectEvent(sql, testEnv, projectId, inputFor(projectId, 'legacy'));
        expect(
          observed.statements.find((row) => row.query.startsWith('INSERT INTO project_events'))!
            .cursor.rowsWritten
        ).toBe(9);
        observed.restore();
        migration.run(sql);
      } finally {
        observed.restore();
      }
      const after = observe(sql);
      try {
        const event = admitProjectEvent(sql, testEnv, projectId, inputFor(projectId, 'optimized'));
        expect(event).toMatchObject({ outcome: 'created', matches: [] });
        expect(after.usage().written).toBe(5);
        expect(
          after.statements.find((row) =>
            row.query.includes('INSERT INTO project_event_wake_scheduler_state')
          )!.cursor.rowsWritten
        ).toBe(0);
      } finally {
        after.restore();
      }
    });
  });

  it('rearms the real RPC on cold admission, but writes five SQL rows and no alarm on the next unmatched admission', async () => {
    const projectId = 'cost-rpc-alarm';
    const stub = stubFor(projectId);
    await stub.ensureProjectId(projectId);
    await runInDurableObject(stub, async (instance, state) => {
      const alarms = vi.spyOn(state.storage, 'setAlarm');
      const observed = observe(state.storage.sql);
      try {
        instance.admitProjectEvent(inputFor(projectId, 'cold'));
        await vi.waitFor(() => expect(alarms).toHaveBeenCalledTimes(1));
        expect(await state.storage.getAlarm()).not.toBeNull();
        observed.statements.length = 0;
        alarms.mockClear();
        const created = instance.admitProjectEvent(inputFor(projectId, 'warm'));
        // The recalculation starts synchronously; an awaited getAlarm also drains its storage I/O.
        await state.storage.getAlarm();
        expect(created.matches).toEqual([]);
        expect(observed.usage().written).toBe(5);
        expect(alarms).not.toHaveBeenCalled();
        const replay = instance.admitProjectEvent(inputFor(projectId, 'warm'));
        expect(replay).toMatchObject({
          outcome: 'duplicate_replay',
          event: { id: created.event.id, duplicateCount: 1 },
        });
        const conflict = instance.admitProjectEvent({
          ...inputFor(projectId, 'warm'),
          payloadFingerprint: 'different',
        });
        expect(conflict).toMatchObject({
          outcome: 'conflict',
          event: { id: created.event.id, state: 'conflicted', conflictCount: 1 },
        });
        expect(alarms).not.toHaveBeenCalled();
        expect(state.storage.sql.exec('SELECT COUNT(*) AS n FROM project_events').one().n).toBe(2);
      } finally {
        observed.restore();
        alarms.mockRestore();
        await state.storage.deleteAlarm();
      }
    });
  });

  it('replaces multiplicative FK scans with indexed deletes and drains equal-time events across batches', async () => {
    const measurements = [];
    for (const legacy of [true, false]) {
      const projectId = `cost-retention-${legacy}`;
      measurements.push(
        await runInDurableObject(stubFor(projectId), (_instance, state) => {
          const sql = state.storage.sql;
          if (legacy) restoreLegacyIndexes(sql);
          seedRetention(sql, projectId);
          const deletePlan = plan(
            sql,
            'DELETE FROM project_events WHERE project_id=? AND id IN (?) RETURNING id',
            projectId,
            'old-1'
          );
          const observed = observe(sql);
          try {
            const first = runProjectEventRetention(sql, testEnv, projectId, {
              projectId,
              refreshAccounting: false,
            });
            const firstUsage = observed.usage();
            const actualDelete = observed.statements.find((row) =>
              row.query.startsWith('DELETE FROM project_events')
            )!;
            const actualDeletePlan = plan(sql, actualDelete.query, ...actualDelete.bindings);
            expect(actualDeletePlan).toContain('sqlite_autoindex_project_events_1 (id=?)');
            expect(actualDeletePlan).not.toContain('idx_project_events_project_received');
            const selection = observed.statements.find((row) =>
              row.query.startsWith('SELECT e.id AS id FROM project_events')
            )!;
            const selectionPlan = plan(
              sql,
              selection.query,
              projectId,
              Date.now() - 30 * 86400000,
              projectId,
              501
            );
            expect(first).toMatchObject({ deletedEvents: 500, hasMore: true });
            const nextAt = sql
              .exec(
                'SELECT next_retention_at FROM project_event_wake_scheduler_state WHERE project_id=?',
                projectId
              )
              .one().next_retention_at;
            expect(Number(nextAt) - Date.now()).toBeLessThanOrEqual(60000);
            const second = runProjectEventRetention(sql, testEnv, projectId, {
              projectId,
              refreshAccounting: false,
            });
            expect(second).toMatchObject({ deletedEvents: 101, hasMore: false });
            expect(
              sql.exec('SELECT COUNT(*) AS n FROM project_events WHERE received_at=1').one().n
            ).toBe(0);
            expect(sql.exec('SELECT COUNT(*) AS n FROM project_events').one().n).toBe(2000);
            expect(sql.exec('SELECT COUNT(*) AS n FROM project_event_matches').one().n).toBe(2000);
            expect(selectionPlan).toContain('received_at<?');
            expect(selectionPlan).not.toContain('TEMP B-TREE');
            return { deletePlan, ...firstUsage };
          } finally {
            observed.restore();
          }
        })
      );
    }
    expect(measurements.map(({ read, written }) => ({ read, written }))).toMatchInlineSnapshot(`
      [
        {
          "read": 2006527,
          "written": 504,
        },
        {
          "read": 6527,
          "written": 504,
        },
      ]
    `);
    expect(measurements[0]!.deletePlan).toContain('SCAN project_event_matches');
    expect(measurements[0]!.read).toBeGreaterThan(2_000_000);
    expect(measurements[1]!.deletePlan).toContain(
      'idx_project_event_matches_event_id (event_id=?)'
    );
    expect(measurements[1]!.deletePlan).not.toContain('SCAN project_event_matches');
    expect(measurements[1]!.read).toBeLessThan(20_000);
  });
  it('preserves expired protected events and measures the remaining linear cutoff candidate work', async () => {
    const projectId = 'cost-retention-expired-protected';
    const measurements = await runInDurableObject(stubFor(projectId), (_instance, state) => {
      const sql = state.storage.sql;
      seedRetention(sql, projectId);
      // Force all protected events ahead of the deletable events in cutoff order.
      // Their active matches must protect them even though received_at is old.
      sql.exec("UPDATE project_events SET received_at=0 WHERE id LIKE 'fresh-%'");
      const observed = observe(sql);
      try {
        const first = runProjectEventRetention(sql, testEnv, projectId, {
          projectId,
          refreshAccounting: false,
        });
        const firstUsage = observed.usage();
        expect(first).toMatchObject({ deletedEvents: 500, hasMore: true });
        observed.statements.length = 0;
        const second = runProjectEventRetention(sql, testEnv, projectId, {
          projectId,
          refreshAccounting: false,
        });
        const secondUsage = observed.usage();
        expect(second).toMatchObject({ deletedEvents: 101, hasMore: false });
        expect(sql.exec('SELECT COUNT(*) AS n FROM project_events').one().n).toBe(2000);
        expect(sql.exec('SELECT COUNT(*) AS n FROM project_event_matches').one().n).toBe(2000);
        return { first: firstUsage, second: secondUsage };
      } finally {
        observed.restore();
      }
    });
    expect(measurements).toMatchInlineSnapshot(`
      {
        "first": {
          "read": 10527,
          "written": 504,
        },
        "second": {
          "read": 8533,
          "written": 104,
        },
      }
    `);
  });
});
