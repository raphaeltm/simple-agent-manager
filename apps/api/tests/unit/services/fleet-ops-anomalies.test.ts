/**
 * Real-SQL tests for `findAnomalies` (`.claude/rules/28`): every class is seeded with one
 * anomalous row and one healthy neighbour, so a deleted predicate shows up as an extra finding.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { platformErrors } from '../../../src/db/observability-schema';
import * as schema from '../../../src/db/schema';
import { WORKSPACE_DELETION_QUARANTINE_MESSAGE } from '../../../src/durable-objects/node-lifecycle-workspace-deletion';
import type { Env } from '../../../src/env';
import { resolveCleanupConfig } from '../../../src/scheduled/node-cleanup/config';
import { findAnomalies } from '../../../src/services/fleet-ops/anomalies';
import { FLEET_OPS_DEFAULTS } from '../../../src/services/fleet-ops/settings-definitions';
import {
  createSchemaTables,
  createSqliteD1,
  createSqliteD1WithBindLimit,
} from '../../helpers/sqlite-d1';

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const MIN = 60_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

let main: Database.Database;
let obs: Database.Database;
let env: Env;

function insert(db: Database.Database, table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).run(...keys.map((k) => row[k] ?? null));
}

function node(id: string, extra: Record<string, unknown> = {}) {
  insert(main, 'nodes', {
    id,
    user_id: 'user-a',
    name: id,
    status: 'running',
    node_role: 'workspace',
    node_class: 'managed',
    runtime: 'vm',
    cloud_provider: 'hetzner',
    health_status: 'healthy',
    heartbeat_stale_after_seconds: 180,
    last_heartbeat_at: iso(MIN),
    created_at: iso(600 * MIN),
    updated_at: iso(MIN),
    ...extra,
  });
}

function workspace(id: string, nodeId: string, extra: Record<string, unknown> = {}) {
  insert(main, 'workspaces', {
    id,
    node_id: nodeId,
    user_id: 'user-a',
    project_id: 'proj-1',
    name: id,
    repository: 'o/r',
    status: 'running',
    created_at: iso(500 * MIN),
    updated_at: iso(MIN),
    last_activity_at: iso(MIN),
    ...extra,
  });
}

function task(id: string, extra: Record<string, unknown> = {}) {
  insert(main, 'tasks', {
    id,
    project_id: 'proj-1',
    user_id: 'user-a',
    title: id,
    status: 'in_progress',
    created_at: iso(500 * MIN),
    updated_at: iso(MIN),
    ...extra,
  });
}

function findingIds(report: Awaited<ReturnType<typeof findAnomalies>>, cls: string) {
  const entry = report.classes.find((c) => c.class === cls);
  if (!entry) throw new Error(`class ${cls} missing`);
  if (entry.error) throw new Error(`class ${cls} failed: ${entry.error}`);
  return entry;
}

beforeEach(() => {
  main = new Database(':memory:');
  obs = new Database(':memory:');
  createSchemaTables(main, [
    schema.nodes,
    schema.workspaces,
    schema.tasks,
    schema.sessionSnapshots,
    schema.platformFeedbackTriages,
  ]);
  createSchemaTables(obs, [platformErrors]);
  env = {
    DATABASE: createSqliteD1(main),
    OBSERVABILITY_DATABASE: createSqliteD1(obs),
  } as unknown as Env;
});

describe('findAnomalies', () => {
  it('reports nothing for a healthy fleet, while every class still runs (liveness)', async () => {
    node('node-healthy');
    workspace('ws-healthy', 'node-healthy');
    task('task-healthy', { workspace_id: 'ws-healthy' });

    const report = await findAnomalies(env, FLEET_OPS_DEFAULTS, { now: NOW });

    expect(report.classes).toHaveLength(9);
    for (const entry of report.classes) {
      expect(entry.error, entry.class).toBeUndefined();
      expect(entry.findings, entry.class).toEqual([]);
      expect(entry.total, entry.class).toBe(0);
    }
  });

  it('finds an empty node past the reaper grace plus the Operations grace, not one inside it', async () => {
    const graceMs = resolveCleanupConfig(env).gracePeriodMs + FLEET_OPS_DEFAULTS.emptyNodeGraceMs;
    node('node-empty-old', { created_at: iso(graceMs + 5 * MIN) });
    node('node-empty-young', { created_at: iso(graceMs - 5 * MIN) });
    node('node-busy', { created_at: iso(graceMs + 60 * MIN) });
    workspace('ws-busy', 'node-busy', { updated_at: iso(graceMs + 60 * MIN) });
    // A stopped workspace that last moved long ago does not make the node busy.
    node('node-stopped-ws', { created_at: iso(graceMs + 60 * MIN) });
    workspace('ws-stopped', 'node-stopped-ws', {
      status: 'stopped',
      updated_at: iso(graceMs + 30 * MIN),
    });
    node('node-user-owned', { created_at: iso(graceMs + 60 * MIN), node_class: 'user-owned' });

    const entry = findingIds(
      await findAnomalies(env, FLEET_OPS_DEFAULTS, { now: NOW }),
      'empty_node_past_warm_grace'
    );

    expect(entry.findings.map((f) => f.ids.nodeId)).toEqual(['node-stopped-ws', 'node-empty-old']);
    expect(entry.findings[0]?.reason).toContain('no active workspace');
  });

  it('finds nodes whose heartbeat is older than their own stale bound', async () => {
    node('node-stale', { last_heartbeat_at: iso(10 * MIN), heartbeat_stale_after_seconds: 300 });
    node('node-fresh', { last_heartbeat_at: iso(2 * MIN), heartbeat_stale_after_seconds: 300 });
    node('node-never', { last_heartbeat_at: null, created_at: iso(30 * MIN) });
    node('node-stopped', { status: 'stopped', last_heartbeat_at: iso(600 * MIN) });

    const entry = findingIds(
      await findAnomalies(env, FLEET_OPS_DEFAULTS, { now: NOW }),
      'stale_node_heartbeat'
    );

    expect(entry.findings.map((f) => f.ids.nodeId)).toEqual(['node-never', 'node-stale']);
    expect(entry.findings[0]?.reason).toContain('is unhealthy');
    expect(entry.findings[1]?.reason).toContain('is stale');
  });

  it('finds nodes destroying past the threshold with their recorded cleanup refusal', async () => {
    const threshold = FLEET_OPS_DEFAULTS.destroyingNodeHours * 60 * MIN;
    node('node-stuck', {
      status: 'destroying',
      node_role: 'deployment',
      last_heartbeat_at: iso(threshold + 60 * MIN),
      cleanup_blocked_since: iso(threshold),
      cleanup_blocked_reason: 'exact provider credential binding is missing',
    });
    node('node-deleting', { status: 'deleting', last_heartbeat_at: iso(threshold + MIN) });
    // Healthy neighbours: a teardown still inside the threshold, and a long-dead node already deleted.
    node('node-recent', { status: 'destroying', last_heartbeat_at: iso(threshold - 10 * MIN) });
    node('node-deleted', { status: 'deleted', last_heartbeat_at: iso(threshold * 4) });

    const entry = findingIds(
      await findAnomalies(env, FLEET_OPS_DEFAULTS, { now: NOW }),
      'node_destroying_too_long'
    );

    expect(entry.findings.map((f) => f.ids.nodeId)).toEqual(['node-stuck', 'node-deleting']);
    expect(entry.findings[0]?.reason).toContain('deployment node has been destroying');
    expect(entry.findings[0]?.reason).toContain('exact provider credential binding is missing');
    expect(entry.findings[1]?.reason).toContain('no cleanup refusal recorded');
  });

  it('finds running workspaces whose task ended past the grace, unless another task is active', async () => {
    node('node-1');
    const grace = FLEET_OPS_DEFAULTS.terminalTaskGraceMs;
    workspace('ws-orphan', 'node-1');
    task('task-done', {
      workspace_id: 'ws-orphan',
      status: 'completed',
      completed_at: iso(grace + MIN),
    });
    workspace('ws-recent', 'node-1');
    task('task-recent', {
      workspace_id: 'ws-recent',
      status: 'failed',
      completed_at: iso(grace - MIN),
    });
    workspace('ws-reused', 'node-1');
    task('task-old', {
      workspace_id: 'ws-reused',
      status: 'cancelled',
      completed_at: iso(grace + MIN),
    });
    task('task-live', { workspace_id: 'ws-reused', status: 'in_progress' });
    workspace('ws-stopped', 'node-1', { status: 'stopped' });
    task('task-stopped', {
      workspace_id: 'ws-stopped',
      status: 'completed',
      completed_at: iso(grace + MIN),
    });

    const entry = findingIds(
      await findAnomalies(env, FLEET_OPS_DEFAULTS, { now: NOW }),
      'running_workspace_for_terminal_task'
    );

    expect(entry.findings.map((f) => f.ids.workspaceId)).toEqual(['ws-orphan']);
    expect(entry.findings[0]?.ids.taskId).toBe('task-done');
  });

  it('finds in-progress tasks with no task or workspace activity for N minutes', async () => {
    const idle = FLEET_OPS_DEFAULTS.idleTaskMinutes * MIN;
    node('node-1');
    workspace('ws-idle', 'node-1', { last_activity_at: iso(idle + MIN) });
    task('task-idle', { workspace_id: 'ws-idle', updated_at: iso(idle + MIN) });
    workspace('ws-active', 'node-1', { last_activity_at: iso(MIN) });
    task('task-ws-active', { workspace_id: 'ws-active', updated_at: iso(idle + MIN) });
    task('task-no-ws', { updated_at: iso(idle + 10 * MIN) });
    task('task-queued', { status: 'queued', updated_at: iso(idle + MIN) });

    const entry = findingIds(
      await findAnomalies(env, FLEET_OPS_DEFAULTS, { now: NOW }),
      'idle_in_progress_task'
    );

    expect(entry.findings.map((f) => f.ids.taskId)).toEqual(['task-no-ws', 'task-idle']);
  });

  it('finds recent snapshot sleep, capture and recovery failures, but not healthy or old ones', async () => {
    const snap = (id: string, extra: Record<string, unknown>) =>
      insert(main, 'session_snapshots', {
        id,
        user_id: 'user-a',
        chat_session_id: `chat-${id}`,
        runtime: 'vm',
        status: 'available',
        updated_at: iso(MIN),
        ...extra,
      });
    snap('s-sleep', { sleep_status: 'terminal_failed', sleep_attempts: 3, sleep_error: 'boom' });
    snap('s-capture', { capture_error: 'disk full', updated_at: iso(2 * MIN) });
    snap('s-recovery', { recovery_status: 'failed', updated_at: iso(3 * MIN) });
    snap('s-ok', { sleep_status: 'sleeping' });
    snap('s-old', {
      sleep_status: 'failed',
      updated_at: iso((FLEET_OPS_DEFAULTS.lookbackHours + 1) * 60 * MIN),
    });

    const entry = findingIds(
      await findAnomalies(env, FLEET_OPS_DEFAULTS, { now: NOW }),
      'session_snapshot_failure'
    );

    expect(entry.findings.map((f) => f.ids.snapshotId)).toEqual([
      's-sleep',
      's-capture',
      's-recovery',
    ]);
    expect(entry.findings[0]?.reason).toContain('sleep_error');
    // Error text is never inlined into the sweep; the story tool returns it fenced.
    expect(entry.findings[0]?.reason).not.toContain('boom');
  });

  it('finds wakes older than the waking threshold, weeks old included, but not a fresh wake', async () => {
    const threshold = FLEET_OPS_DEFAULTS.wakingMinutes * MIN;
    const snap = (id: string, extra: Record<string, unknown>) =>
      insert(main, 'session_snapshots', {
        id,
        user_id: 'user-a',
        project_id: 'proj-1',
        chat_session_id: `chat-${id}`,
        runtime: 'vm',
        status: 'available',
        recovery_status: 'waking',
        updated_at: iso(MIN),
        ...extra,
      });
    task('task-dead', { status: 'sleeping', updated_at: iso(threshold) });
    task('task-live', { status: 'queued' });
    task('task-fresh', { status: 'queued' });
    // Weeks old, far outside the snapshot-failure lookback window.
    snap('s-dead', {
      recovery_task_id: 'task-dead',
      recovery_claimed_at: iso(30 * 24 * 60 * MIN),
      updated_at: iso(MIN),
    });
    snap('s-live', { recovery_task_id: 'task-live', recovery_claimed_at: iso(threshold + MIN) });
    // No claim time: age falls back to created_at, which no other writer moves; a fresh
    // updated_at (another writer touched the row) must not hide it.
    snap('s-missing', {
      recovery_task_id: 'task-gone',
      recovery_claimed_at: null,
      created_at: iso(threshold + 2 * MIN),
      updated_at: iso(MIN),
    });
    snap('s-fresh', { recovery_task_id: 'task-fresh', recovery_claimed_at: iso(threshold - MIN) });
    snap('s-failed', { recovery_status: 'failed', recovery_claimed_at: iso(threshold + MIN) });

    const report = await findAnomalies(env, FLEET_OPS_DEFAULTS, { now: NOW });
    const entry = findingIds(report, 'session_wake_stalled');

    expect(entry.findings.map((f) => f.ids.snapshotId)).toEqual(['s-dead', 's-missing', 's-live']);
    expect(entry.total).toBe(3);
    expect(entry.findings[0]?.reason).toContain('recovery task sleeping');
    expect(entry.findings[0]?.reason).toContain('dead claim');
    expect(entry.findings[1]?.reason).toContain('recovery task missing');
    expect(entry.findings[2]?.reason).toContain('still running');
    expect(report.thresholds.wakingMinutes).toBe(FLEET_OPS_DEFAULTS.wakingMinutes);
  });

  it('reports a waking row with an unreadable timestamp first instead of dropping it', async () => {
    insert(main, 'session_snapshots', {
      id: 's-garbled',
      user_id: 'user-a',
      chat_session_id: 'chat-garbled',
      runtime: 'vm',
      status: 'available',
      recovery_status: 'waking',
      recovery_claimed_at: 'not a time',
      created_at: iso(MIN),
      updated_at: iso(MIN),
    });
    insert(main, 'session_snapshots', {
      id: 's-old',
      user_id: 'user-a',
      chat_session_id: 'chat-old',
      runtime: 'vm',
      status: 'available',
      recovery_status: 'waking',
      recovery_claimed_at: iso((FLEET_OPS_DEFAULTS.wakingMinutes + 5) * MIN),
      updated_at: iso(MIN),
    });
    const entry = findingIds(
      await findAnomalies(env, FLEET_OPS_DEFAULTS, { now: NOW }),
      'session_wake_stalled'
    );
    expect(entry.findings.map((f) => f.ids.snapshotId)).toEqual(['s-garbled', 's-old']);
    expect(entry.findings[0]?.reason).toContain('an unknown number of min');
  });

  it('honours a configured waking threshold', async () => {
    insert(main, 'session_snapshots', {
      id: 's-30',
      user_id: 'user-a',
      chat_session_id: 'chat-30',
      runtime: 'vm',
      status: 'available',
      recovery_status: 'waking',
      recovery_claimed_at: iso(30 * MIN),
      updated_at: iso(MIN),
    });
    const ids = async (wakingMinutes: number) =>
      findingIds(
        await findAnomalies(env, { ...FLEET_OPS_DEFAULTS, wakingMinutes }, { now: NOW }),
        'session_wake_stalled'
      ).findings.map((f) => f.ids.snapshotId);

    expect(await ids(60)).toEqual([]);
    expect(await ids(20)).toEqual(['s-30']);
  });

  it('finds deletion quarantine reports for workspaces that still exist', async () => {
    node('node-1');
    workspace('ws-stuck', 'node-1', { status: 'stopping' });
    workspace('ws-deleted-since', 'node-1', { status: 'deleted' });
    const report = (
      id: string,
      workspaceId: string,
      msAgo: number,
      message = WORKSPACE_DELETION_QUARANTINE_MESSAGE
    ) =>
      insert(obs, 'platform_errors', {
        id,
        source: 'api',
        level: 'error',
        message,
        workspace_id: workspaceId,
        node_id: 'node-1',
        timestamp: NOW - msAgo,
        created_at: NOW - msAgo,
      });
    report('e1', 'ws-stuck', 10 * MIN);
    report('e2', 'ws-stuck', 5 * MIN);
    report('e3', 'ws-deleted-since', 5 * MIN);
    report('e4', 'ws-other', 5 * MIN, 'Some other error');

    const entry = findingIds(
      await findAnomalies(env, FLEET_OPS_DEFAULTS, { now: NOW }),
      'workspace_deletion_quarantine'
    );

    expect(entry.findings.map((f) => f.ids.workspaceId)).toEqual(['ws-stuck']);
    expect(entry.findings[0]?.reason).toContain('2 time(s)');
    expect(entry.total).toBe(1);
  });

  it('finds pending incidents, most severe first', async () => {
    const triage = (signature: string, extra: Record<string, unknown>) =>
      insert(main, 'platform_feedback_triages', {
        signature,
        source: 'vm-agent',
        summary: 'untrusted summary text',
        severity: 'warn',
        occurrence_count: 1,
        first_seen_at: NOW - MIN,
        last_seen_at: NOW - MIN,
        queue_state: 'pending',
        ...extra,
      });
    triage('sig-warn', {});
    triage('sig-error', { severity: 'error' });
    triage('sig-resolved', { queue_state: 'resolved', severity: 'error' });

    const entry = findingIds(
      await findAnomalies(env, FLEET_OPS_DEFAULTS, { now: NOW }),
      'pending_incident'
    );

    expect(entry.findings.map((f) => f.ids.signature)).toEqual(['sig-error', 'sig-warn']);
    expect(JSON.stringify(entry)).not.toContain('untrusted summary text');
  });

  it('caps each class and discloses the total, oldest first', async () => {
    for (let i = 0; i < 5; i++) {
      node(`node-stale-${i}`, { last_heartbeat_at: iso((20 + i) * MIN) });
    }

    const report = await findAnomalies(
      env,
      { ...FLEET_OPS_DEFAULTS, anomalyMaxPerClass: 2 },
      { now: NOW }
    );
    const entry = findingIds(report, 'stale_node_heartbeat');

    expect(entry.total).toBe(5);
    expect(entry.returned).toBe(2);
    expect(entry.truncated).toBe(true);
    expect(entry.findings.map((f) => f.ids.nodeId)).toEqual(['node-stale-4', 'node-stale-3']);
  });

  it('reports more quarantined workspaces than D1 can bind in one statement', async () => {
    // D1 rejects statements with more than 100 bound parameters; the in-memory engine does not.
    env = { ...env, DATABASE: createSqliteD1WithBindLimit(main, 100) } as Env;
    node('node-1');
    for (let i = 0; i < 150; i++) {
      const id = `ws-q-${String(i).padStart(3, '0')}`;
      workspace(id, 'node-1', { status: i === 0 ? 'deleted' : 'stopping' });
      insert(obs, 'platform_errors', {
        id: `e-${id}`,
        source: 'api',
        level: 'error',
        message: WORKSPACE_DELETION_QUARANTINE_MESSAGE,
        workspace_id: id,
        node_id: 'node-1',
        timestamp: NOW - MIN - i,
        created_at: NOW - MIN - i,
      });
    }

    const entry = findingIds(
      await findAnomalies(env, { ...FLEET_OPS_DEFAULTS, anomalyMaxPerClass: 200 }, { now: NOW }),
      'workspace_deletion_quarantine'
    );

    // The one deleted since is dropped, which needs a status from both lookup chunks.
    expect(entry.returned).toBe(149);
    expect(entry.findings.map((f) => f.ids.workspaceId)).not.toContain('ws-q-000');
    expect(entry.findings.at(-1)?.ids.workspaceId).toBe('ws-q-149');
  });

  it('applies the quarantine cap after dropping workspaces deleted since', async () => {
    node('node-1');
    const report = (workspaceId: string, msAgo: number) =>
      insert(obs, 'platform_errors', {
        id: `e-${workspaceId}`,
        source: 'api',
        level: 'error',
        message: WORKSPACE_DELETION_QUARANTINE_MESSAGE,
        workspace_id: workspaceId,
        node_id: 'node-1',
        timestamp: NOW - msAgo,
        created_at: NOW - msAgo,
      });
    // The three newest reports belong to workspaces deleted since; the open one is older.
    for (const [i, id] of ['ws-gone-1', 'ws-gone-2', 'ws-gone-3'].entries()) {
      workspace(id, 'node-1', { status: 'deleted' });
      report(id, (i + 1) * MIN);
    }
    workspace('ws-open', 'node-1', { status: 'stopping' });
    report('ws-open', 10 * MIN);

    const entry = findingIds(
      await findAnomalies(env, { ...FLEET_OPS_DEFAULTS, anomalyMaxPerClass: 2 }, { now: NOW }),
      'workspace_deletion_quarantine'
    );

    expect(entry.findings.map((f) => f.ids.workspaceId)).toEqual(['ws-open']);
    expect(entry.total).toBe(1);
    expect(entry.truncated).toBe(false);
  });

  it('isolates a failing class: the others still report', async () => {
    node('node-stale', { last_heartbeat_at: iso(30 * MIN) });
    obs.exec('DROP TABLE platform_errors');

    const report = await findAnomalies(env, FLEET_OPS_DEFAULTS, { now: NOW });

    expect(
      report.classes.find((c) => c.class === 'workspace_deletion_quarantine')?.error
    ).toBeTruthy();
    expect(findingIds(report, 'stale_node_heartbeat').findings).toHaveLength(1);
  });
});
