/**
 * Joint test for the two column families that now share the `session_state` row.
 *
 * PR #1840 (migration 029) added the reconciliation columns — `activity_source`,
 * `activity_reason`, `activity_probe_at`, `activity_probe_attempts`. This branch
 * (migration 030) added the harness-work columns — `runtime_work_state`,
 * `runtime_work_count`, `runtime_work_source`, `runtime_work_updated_at`,
 * `runtime_work_progress_at`.
 *
 * Both were merged into the SAME INSERT / ON CONFLICT / SELECT statements and the
 * same row mapper during the rebase. `session-activity-reconciliation.test.ts` and
 * `session-state-mirror.test.ts` each exercise only their own family, so neither
 * would catch one family clobbering the other. This file is the missing joint
 * coverage for the acceptance criterion "PR #1840's reconciled-activity behavior is
 * preserved, not clobbered".
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations } from '../../../src/durable-objects/migrations';
import {
  getSessionState,
  reconcileStaleActivity,
  upsertActivityState,
} from '../../../src/durable-objects/project-data/session-state';
import { createSqlStorage } from './sql-storage-test-utils';

const SESSION = 'acp-joint-1';

describe('session_state: #1840 reconciliation columns coexist with harness-work columns', () => {
  let db: Database.Database;
  let sql: SqlStorage;
  const now = Date.now();

  beforeEach(() => {
    db = new Database(':memory:');
    sql = createSqlStorage(db);
    runMigrations(sql);
  });

  afterEach(() => db.close());

  it('persists and reads back BOTH column families from one write', () => {
    upsertActivityState(sql, SESSION, {
      activity: 'idle',
      agentType: 'claude-code',
      source: 'vm_report',
      runtimeWorkState: 'active',
      runtimeWorkCount: 3,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkProgressAt: now - 1000,
      now,
    });

    const state = getSessionState(sql, SESSION);
    expect(state).not.toBeNull();

    // #1840's family
    expect(state!.activitySource).toBe('vm_report');
    expect(state!.activityReason).toBe('completed');
    // this branch's family
    expect(state!.runtimeWorkState).toBe('active');
    expect(state!.runtimeWorkCount).toBe(3);
    expect(state!.runtimeWorkSource).toBe('claude_sdk');
    expect(state!.runtimeWorkUpdatedAt).toBe(now);
    expect(state!.runtimeWorkProgressAt).toBe(now - 1000);
  });

  it('a harness-only rereport does not clobber #1840 provenance', () => {
    upsertActivityState(sql, SESSION, {
      activity: 'prompting',
      source: 'vm_report',
      runtimeWorkState: 'active',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkProgressAt: now - 5000,
      now: now - 5000,
    });

    // Heartbeat rereport carrying the same harness snapshot.
    upsertActivityState(sql, SESSION, {
      activity: 'prompting',
      source: 'vm_report',
      runtimeWorkState: 'active',
      runtimeWorkCount: 1,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkProgressAt: now - 5000,
      now,
    });

    const state = getSessionState(sql, SESSION);
    expect(state!.activitySource).toBe('vm_report');
    expect(state!.runtimeWorkState).toBe('active');
    // The heartbeat advances the receipt clock but NOT the progress clock — the
    // distinction the absolute sleep ceiling depends on.
    expect(state!.runtimeWorkUpdatedAt).toBe(now);
    expect(state!.runtimeWorkProgressAt).toBe(now - 5000);
  });

  it('an activity write WITHOUT harness fields preserves the stored harness state', () => {
    upsertActivityState(sql, SESSION, {
      activity: 'prompting',
      runtimeWorkState: 'active',
      runtimeWorkCount: 2,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkProgressAt: now - 2000,
      now: now - 2000,
    });

    // A plain activity report from a path that knows nothing about harness work.
    upsertActivityState(sql, SESSION, { activity: 'prompting', now });

    const state = getSessionState(sql, SESSION);
    expect(state!.runtimeWorkState).toBe('active');
    expect(state!.runtimeWorkCount).toBe(2);
    expect(state!.runtimeWorkSource).toBe('claude_sdk');
  });

  it("#1840's stale-activity reconciliation leaves the harness columns untouched", () => {
    upsertActivityState(sql, SESSION, {
      activity: 'prompting',
      source: 'vm_report',
      runtimeWorkState: 'active',
      runtimeWorkCount: 4,
      runtimeWorkSource: 'claude_sdk',
      runtimeWorkProgressAt: now - 10_000,
      now: now - 10 * 60 * 1000,
    });

    // Drive #1840's own repair path over the same row.
    reconcileStaleActivity(sql, 60_000, now);

    const state = getSessionState(sql, SESSION);
    expect(state!.runtimeWorkState).toBe('active');
    expect(state!.runtimeWorkCount).toBe(4);
    expect(state!.runtimeWorkSource).toBe('claude_sdk');
    expect(state!.runtimeWorkProgressAt).toBe(now - 10_000);
  });

  it('migration 030/031 columns all exist alongside migration 029 columns', () => {
    const columns = (
      db.prepare('PRAGMA table_info(session_state)').all() as Array<{ name: string }>
    ).map((c) => c.name);

    expect(columns).toEqual(
      expect.arrayContaining([
        // 029 (PR #1840)
        'activity_source',
        'activity_reason',
        'activity_probe_at',
        'activity_probe_attempts',
        // 030 (this branch)
        'runtime_work_state',
        'runtime_work_count',
        'runtime_work_source',
        'runtime_work_updated_at',
        'runtime_work_progress_at',
      ])
    );
  });
});
