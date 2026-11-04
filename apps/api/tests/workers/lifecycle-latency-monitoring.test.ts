/**
 * Lifecycle latency monitoring against real Miniflare D1 with the real migration chain, so
 * the status triggers in migration 0218 are what stamp `*_changed_at` and record transitions.
 * The watchdog is driven with an injected clock instead of hand-aged timestamps (rule 62).
 *
 * Source: apps/api/src/services/lifecycle-latency/, migration 0218_lifecycle_latency_monitoring.sql
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import { runLifecycleLatencyDailyEvaluation } from '../../src/services/lifecycle-latency/daily-evaluation';
import { LIFECYCLE_LATENCY_DEFAULTS } from '../../src/services/lifecycle-latency/defaults';
import { runLifecycleLatencyWatchdog } from '../../src/services/lifecycle-latency/watchdog';
import { resolveLifecycleLatencySettings } from '../../src/services/lifecycle-latency/watches';
import { seedNode, seedUser, seedWorkspace } from './helpers/seed-d1';

const USER_ID = 'user-latency-001';
const MINUTE = 60_000;

async function resetLifecycleState(): Promise<void> {
  await env.DATABASE.batch([
    env.DATABASE.prepare('DELETE FROM lifecycle_latency_alerts'),
    env.DATABASE.prepare(
      "UPDATE workspaces SET status = 'deleted' WHERE status NOT IN ('deleted', 'error')"
    ),
    env.DATABASE.prepare(
      "UPDATE nodes SET status = 'deleted' WHERE status NOT IN ('deleted', 'error')"
    ),
    env.DATABASE.prepare(
      'UPDATE session_snapshots SET sleep_status = NULL, recovery_status = NULL'
    ),
    env.DATABASE.prepare('DELETE FROM lifecycle_state_transitions'),
  ]);
  await env.OBSERVABILITY_DATABASE.prepare('DELETE FROM platform_errors').run();
}

async function setStatus(table: 'workspaces' | 'nodes', id: string, status: string) {
  await env.DATABASE.prepare(`UPDATE ${table} SET status = ? WHERE id = ?`).bind(status, id).run();
}

async function changedAt(table: 'workspaces' | 'nodes', id: string): Promise<string> {
  const row = await env.DATABASE.prepare(`SELECT status_changed_at FROM ${table} WHERE id = ?`)
    .bind(id)
    .first<{ status_changed_at: string | null }>();
  expect(row?.status_changed_at).toBeTruthy();
  return row!.status_changed_at!;
}

async function platformErrors(message: string) {
  const { results } = await env.OBSERVABILITY_DATABASE.prepare(
    'SELECT level, message, workspace_id, node_id, context FROM platform_errors WHERE message = ?'
  )
    .bind(message)
    .all<{
      level: string;
      message: string;
      workspace_id: string | null;
      node_id: string | null;
      context: string | null;
    }>();
  return results ?? [];
}

async function seedSnapshot(id: string, workspaceId: string, nodeId: string) {
  await env.DATABASE.prepare(
    `INSERT INTO session_snapshots
       (id, chat_session_id, workspace_id, node_id, user_id, manifest_r2_key, runtime, status,
        sleep_status, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'test/manifest', 'vm', 'pending', 'preparing',
        datetime('now'), datetime('now'), datetime('now', '+7 days'))`
  )
    .bind(id, `chat-${id}`, workspaceId, nodeId, USER_ID)
    .run();
}

beforeEach(async () => {
  await seedUser(USER_ID);
  await resetLifecycleState();
});

describe('status triggers', () => {
  it('stamps the entry time on insert and on every real status change, and records history', async () => {
    const nodeId = `node-${crypto.randomUUID()}`;
    await seedNode(nodeId, USER_ID, { status: 'creating' });
    const inserted = await changedAt('nodes', nodeId);

    await setStatus('nodes', nodeId, 'running');
    const running = await changedAt('nodes', nodeId);
    expect(running >= inserted).toBe(true);

    // Same status again is not a transition (e.g. a heartbeat rewriting status = 'running').
    await setStatus('nodes', nodeId, 'running');
    await env.DATABASE.prepare('UPDATE nodes SET updated_at = ? WHERE id = ?')
      .bind(new Date(Date.now() + MINUTE).toISOString(), nodeId)
      .run();
    expect(await changedAt('nodes', nodeId)).toBe(running);

    const { results } = await env.DATABASE.prepare(
      `SELECT entity_type, from_status, to_status, entered_at FROM lifecycle_state_transitions
        WHERE entity_id = ? ORDER BY id`
    )
      .bind(nodeId)
      .all();
    expect(results).toEqual([
      { entity_type: 'node', from_status: 'creating', to_status: 'running', entered_at: inserted },
    ]);
  });

  it('records workspace, session sleep and session wake transitions', async () => {
    const nodeId = `node-${crypto.randomUUID()}`;
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const snapshotId = `snap-${crypto.randomUUID()}`;
    await seedNode(nodeId, USER_ID, { status: 'running' });
    await seedWorkspace(workspaceId, nodeId, USER_ID, { status: 'running' });
    await seedSnapshot(snapshotId, workspaceId, nodeId);

    await setStatus('workspaces', workspaceId, 'stopping');
    await env.DATABASE.prepare(
      "UPDATE session_snapshots SET sleep_status = 'sleeping' WHERE id = ?"
    )
      .bind(snapshotId)
      .run();
    await env.DATABASE.prepare(
      "UPDATE session_snapshots SET recovery_status = 'waking' WHERE id = ?"
    )
      .bind(snapshotId)
      .run();

    const snapshot = await env.DATABASE.prepare(
      'SELECT sleep_status_changed_at, recovery_status_changed_at FROM session_snapshots WHERE id = ?'
    )
      .bind(snapshotId)
      .first<{
        sleep_status_changed_at: string | null;
        recovery_status_changed_at: string | null;
      }>();
    expect(snapshot?.sleep_status_changed_at).toBeTruthy();
    expect(snapshot?.recovery_status_changed_at).toBeTruthy();

    const { results } = await env.DATABASE.prepare(
      `SELECT entity_type, entity_id, from_status, to_status FROM lifecycle_state_transitions
        WHERE entity_id IN (?, ?) ORDER BY id`
    )
      .bind(workspaceId, snapshotId)
      .all();
    expect(results).toEqual([
      {
        entity_type: 'workspace',
        entity_id: workspaceId,
        from_status: 'running',
        to_status: 'stopping',
      },
      {
        entity_type: 'session_sleep',
        entity_id: snapshotId,
        from_status: 'preparing',
        to_status: 'sleeping',
      },
      {
        entity_type: 'session_recovery',
        entity_id: snapshotId,
        from_status: null,
        to_status: 'waking',
      },
    ]);
  });
});

describe('lifecycle latency watchdog', () => {
  it('resolves its settings through the real admin settings resolver', async () => {
    expect(await resolveLifecycleLatencySettings(env as never)).toEqual(LIFECYCLE_LATENCY_DEFAULTS);
  });

  it('records one warning per slow stopping episode, and a new episode alerts again', async () => {
    const nodeId = `node-${crypto.randomUUID()}`;
    const workspaceId = `ws-${crypto.randomUUID()}`;
    await seedNode(nodeId, USER_ID, { status: 'running' });
    await seedWorkspace(workspaceId, nodeId, USER_ID, { status: 'running' });
    await env.DATABASE.prepare(
      "UPDATE workspaces SET error_message = 'deletion unconfirmed' WHERE id = ?"
    )
      .bind(workspaceId)
      .run();
    await setStatus('workspaces', workspaceId, 'stopping');
    const entered = Date.parse(await changedAt('workspaces', workspaceId));
    const message = 'Lifecycle latency budget exceeded: workspace stopping';
    const budget = LIFECYCLE_LATENCY_DEFAULTS.workspaceStoppingMinutes * MINUTE;

    // Under the default budget: nothing fires, but the watchdog did run (liveness).
    const early = await runLifecycleLatencyWatchdog(
      env as never,
      new Date(entered + budget - MINUTE)
    );
    expect(early.watchedStates).toBeGreaterThan(0);
    expect(early.alerted).toBe(0);
    expect(await platformErrors(message)).toHaveLength(0);

    const late = await runLifecycleLatencyWatchdog(
      env as never,
      new Date(entered + budget + MINUTE)
    );
    expect(late.alerted).toBe(1);
    expect(late.breached['workspace.stopping']).toBe(1);
    const [row] = await platformErrors(message);
    expect(row).toMatchObject({ level: 'warn', workspace_id: workspaceId, node_id: nodeId });
    expect(JSON.parse(row!.context!)).toMatchObject({
      entityType: 'workspace',
      entityId: workspaceId,
      status: 'stopping',
      budgetMinutes: LIFECYCLE_LATENCY_DEFAULTS.workspaceStoppingMinutes,
      lastError: 'deletion unconfirmed',
    });

    // Same episode on the next tick: still breached, not re-alerted.
    const again = await runLifecycleLatencyWatchdog(
      env as never,
      new Date(entered + budget + 6 * MINUTE)
    );
    expect(again.breached['workspace.stopping']).toBe(1);
    expect(again.alerted).toBe(0);
    expect(await platformErrors(message)).toHaveLength(1);

    // A later, separate stop is a new episode.
    await setStatus('workspaces', workspaceId, 'running');
    await setStatus('workspaces', workspaceId, 'stopping');
    const reentered = Date.parse(await changedAt('workspaces', workspaceId));
    const second = await runLifecycleLatencyWatchdog(
      env as never,
      new Date(Math.max(reentered, entered + budget + 7 * MINUTE) + budget + MINUTE)
    );
    expect(second.alerted).toBe(1);
    expect(await platformErrors(message)).toHaveLength(2);
  });

  it('alerts once when two watchdog runs overlap', async () => {
    const nodeId = `node-${crypto.randomUUID()}`;
    await seedNode(nodeId, USER_ID, { status: 'creating' });
    const at = new Date(Date.now() + (LIFECYCLE_LATENCY_DEFAULTS.nodeCreatingMinutes + 1) * MINUTE);
    // Both runs select the same unalerted episode before either records it; the alert row's
    // primary key decides which one reports.
    const [left, right] = await Promise.all([
      runLifecycleLatencyWatchdog(env as never, at),
      runLifecycleLatencyWatchdog(env as never, at),
    ]);
    expect(left.alerted + right.alerted).toBe(1);
    expect(await platformErrors('Lifecycle latency budget exceeded: node creating')).toHaveLength(
      1
    );
  });

  it('ignores states that are not watched, and states that already ended', async () => {
    const nodeId = `node-${crypto.randomUUID()}`;
    const workspaceId = `ws-${crypto.randomUUID()}`;
    await seedNode(nodeId, USER_ID, { status: 'running' });
    await seedWorkspace(workspaceId, nodeId, USER_ID, { status: 'creating' });
    await setStatus('workspaces', workspaceId, 'running');
    const entered = Date.parse(await changedAt('workspaces', workspaceId));

    const result = await runLifecycleLatencyWatchdog(
      env as never,
      new Date(entered + 24 * 60 * MINUTE)
    );
    expect(result.alerted).toBe(0);
    expect(result.breached).toEqual({});
  });

  it('caps alerts per state, oldest first, and discloses the rest', async () => {
    const nodeIds = [1, 2, 3].map(() => `node-${crypto.randomUUID()}`);
    for (const nodeId of nodeIds) await seedNode(nodeId, USER_ID, { status: 'creating' });
    const settings = { ...LIFECYCLE_LATENCY_DEFAULTS, alertsPerStatePerTick: 2 };
    const at = new Date(Date.now() + (LIFECYCLE_LATENCY_DEFAULTS.nodeCreatingMinutes + 1) * MINUTE);

    const first = await runLifecycleLatencyWatchdog(env as never, at, settings);
    expect(first).toMatchObject({ alerted: 2, deferred: 1, breached: { 'node.creating': 3 } });
    const second = await runLifecycleLatencyWatchdog(env as never, at, settings);
    expect(second).toMatchObject({ alerted: 1, deferred: 0 });
    const third = await runLifecycleLatencyWatchdog(env as never, at, settings);
    expect(third.alerted).toBe(0);
    expect(await platformErrors('Lifecycle latency budget exceeded: node creating')).toHaveLength(
      3
    );
  });

  it('watches session sleep and wake states', async () => {
    const nodeId = `node-${crypto.randomUUID()}`;
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const snapshotId = `snap-${crypto.randomUUID()}`;
    await seedNode(nodeId, USER_ID, { status: 'running' });
    await seedWorkspace(workspaceId, nodeId, USER_ID, { status: 'running' });
    await seedSnapshot(snapshotId, workspaceId, nodeId);
    await env.DATABASE.prepare(
      "UPDATE session_snapshots SET recovery_status = 'waking' WHERE id = ?"
    )
      .bind(snapshotId)
      .run();

    const at = new Date(Date.now() + 16 * MINUTE);
    const result = await runLifecycleLatencyWatchdog(env as never, at);
    expect(result.breached).toMatchObject({
      'session_sleep.preparing': 1,
      'session_recovery.waking': 1,
    });
    expect(
      await platformErrors('Lifecycle latency budget exceeded: session_sleep preparing')
    ).toHaveLength(1);
    expect(
      await platformErrors('Lifecycle latency budget exceeded: session_recovery waking')
    ).toHaveLength(1);
  });

  it('turns a watch off when its budget is 0', async () => {
    const nodeId = `node-${crypto.randomUUID()}`;
    await seedNode(nodeId, USER_ID, { status: 'creating' });
    const settings = { ...LIFECYCLE_LATENCY_DEFAULTS, nodeCreatingMinutes: 0 };
    const result = await runLifecycleLatencyWatchdog(
      env as never,
      new Date(Date.now() + 60 * MINUTE),
      settings
    );
    expect(result.breached['node.creating']).toBeUndefined();
    expect(result.alerted).toBe(0);
  });
});

describe('lifecycle latency daily evaluation', () => {
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  async function seedEpisodes(
    now: number,
    entityType: string,
    fromStatus: string,
    episodes: Array<{ endedAgoMs: number; durationMs: number }>
  ) {
    await env.DATABASE.batch(
      episodes.map(({ endedAgoMs, durationMs }) =>
        env.DATABASE.prepare(
          `INSERT INTO lifecycle_state_transitions (entity_type, entity_id, from_status, to_status, entered_at, changed_at)
           VALUES (?, ?, ?, 'deleted', ?, ?)`
        ).bind(
          entityType,
          crypto.randomUUID(),
          fromStatus,
          new Date(now - endedAgoMs - durationMs).toISOString(),
          new Date(now - endedAgoMs).toISOString()
        )
      )
    );
  }

  it('flags a state whose 24h p95 is over budget and records it for triage', async () => {
    const now = Date.now();
    await seedEpisodes(
      now,
      'workspace',
      'stopping',
      Array.from({ length: 6 }, (_, i) => ({ endedAgoMs: (i + 1) * HOUR, durationMs: 31 * MINUTE }))
    );
    const result = await runLifecycleLatencyDailyEvaluation(env as never, new Date(now));
    const stopping = result.evaluations.find(
      (e) => e.entityType === 'workspace' && e.status === 'stopping'
    );
    expect(stopping).toMatchObject({
      regression: 'over_budget',
      last24h: { count: 6, p95Ms: 31 * MINUTE },
    });
    const rows = await platformErrors('Lifecycle latency regression: workspace stopping');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.level).toBe('warn');
  });

  it('flags a regression against the previous 7 days even when under budget', async () => {
    const now = Date.now();
    await seedEpisodes(now, 'node', 'creating', [
      ...Array.from({ length: 10 }, (_, i) => ({
        endedAgoMs: 2 * DAY + i * HOUR,
        durationMs: 2 * MINUTE,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        endedAgoMs: (i + 1) * HOUR,
        durationMs: 6 * MINUTE,
      })),
    ]);
    const result = await runLifecycleLatencyDailyEvaluation(env as never, new Date(now));
    const creating = result.evaluations.find(
      (e) => e.entityType === 'node' && e.status === 'creating'
    );
    expect(creating).toMatchObject({
      regression: 'vs_baseline',
      last24h: { count: 6, p95Ms: 6 * MINUTE },
      previous7d: { count: 10, p95Ms: 2 * MINUTE },
    });
  });

  it('stays quiet below the sample minimum and for a steady state', async () => {
    const now = Date.now();
    await seedEpisodes(
      now,
      'workspace',
      'stopping',
      Array.from({ length: 4 }, (_, i) => ({ endedAgoMs: (i + 1) * HOUR, durationMs: 40 * MINUTE }))
    );
    await seedEpisodes(now, 'node', 'creating', [
      ...Array.from({ length: 10 }, (_, i) => ({
        endedAgoMs: 2 * DAY + i * HOUR,
        durationMs: 3 * MINUTE,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        endedAgoMs: (i + 1) * HOUR,
        durationMs: 3 * MINUTE,
      })),
    ]);
    const result = await runLifecycleLatencyDailyEvaluation(env as never, new Date(now));
    expect(result.regressions).toBe(0);
    const stopping = result.evaluations.find(
      (e) => e.entityType === 'workspace' && e.status === 'stopping'
    );
    expect(stopping?.last24h.count).toBe(4); // evaluated (liveness), just not judged
    expect(await platformErrors('Lifecycle latency regression: workspace stopping')).toHaveLength(
      0
    );
  });

  it('measures episodes recorded by the real triggers', async () => {
    const nodeId = `node-${crypto.randomUUID()}`;
    const workspaceId = `ws-${crypto.randomUUID()}`;
    await seedNode(nodeId, USER_ID, { status: 'running' });
    await seedWorkspace(workspaceId, nodeId, USER_ID, { status: 'running' });
    await setStatus('workspaces', workspaceId, 'stopping');
    await setStatus('workspaces', workspaceId, 'deleted');

    const result = await runLifecycleLatencyDailyEvaluation(
      env as never,
      new Date(Date.now() + MINUTE)
    );
    const stopping = result.evaluations.find(
      (e) => e.entityType === 'workspace' && e.status === 'stopping'
    );
    expect(stopping?.last24h.count).toBe(1);
    expect(stopping?.last24h.maxMs).toBeGreaterThanOrEqual(0);
  });

  it('purges history and alert records past retention', async () => {
    const now = Date.now();
    const retentionMs = LIFECYCLE_LATENCY_DEFAULTS.retentionDays * DAY;
    await seedEpisodes(now, 'workspace', 'stopping', [
      { endedAgoMs: retentionMs + DAY, durationMs: MINUTE },
      { endedAgoMs: HOUR, durationMs: MINUTE },
    ]);
    await env.DATABASE.batch([
      env.DATABASE.prepare(
        `INSERT INTO lifecycle_latency_alerts VALUES ('workspace', 'old', 'stopping', 'x', ?)`
      ).bind(new Date(now - retentionMs - DAY).toISOString()),
      env.DATABASE.prepare(
        `INSERT INTO lifecycle_latency_alerts VALUES ('workspace', 'new', 'stopping', 'y', ?)`
      ).bind(new Date(now - HOUR).toISOString()),
    ]);

    const result = await runLifecycleLatencyDailyEvaluation(env as never, new Date(now));
    expect(result).toMatchObject({ purgedTransitions: 1, purgedAlerts: 1 });
    const remaining = await env.DATABASE.prepare(
      'SELECT (SELECT COUNT(*) FROM lifecycle_state_transitions) AS t, (SELECT COUNT(*) FROM lifecycle_latency_alerts) AS a'
    ).first<{ t: number; a: number }>();
    expect(remaining).toEqual({ t: 1, a: 1 });
  });
});
