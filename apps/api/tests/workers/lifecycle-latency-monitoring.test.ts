/**
 * Lifecycle latency monitoring against real Miniflare D1 with the real migration chain.
 * The watchdog is driven with an injected clock; state changes go through real UPDATEs.
 *
 * Source: apps/api/src/services/lifecycle-latency/, migrations 0219 and 0220.
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
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

async function resetLifecycleState(): Promise<void> {
  await env.DATABASE.batch([
    env.DATABASE.prepare('DELETE FROM lifecycle_state_observations'),
    env.DATABASE.prepare('DELETE FROM lifecycle_state_episodes'),
    env.DATABASE.prepare(
      "UPDATE workspaces SET status = 'deleted' WHERE status NOT IN ('deleted', 'error')"
    ),
    env.DATABASE.prepare(
      "UPDATE nodes SET status = 'deleted' WHERE status NOT IN ('deleted', 'error')"
    ),
    env.DATABASE.prepare(
      'UPDATE session_snapshots SET sleep_status = NULL, recovery_status = NULL'
    ),
  ]);
  await env.OBSERVABILITY_DATABASE.prepare('DELETE FROM platform_errors').run();
}

async function setStatus(table: 'workspaces' | 'nodes', id: string, status: string) {
  return env.DATABASE.prepare(`UPDATE ${table} SET status = ? WHERE id = ?`).bind(status, id).run();
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

async function seedStoppingWorkspace() {
  const nodeId = `node-${crypto.randomUUID()}`;
  const workspaceId = `ws-${crypto.randomUUID()}`;
  await seedNode(nodeId, USER_ID, { status: 'running' });
  await seedWorkspace(workspaceId, nodeId, USER_ID, { status: 'running' });
  await env.DATABASE.prepare(
    "UPDATE workspaces SET status = 'stopping', error_message = 'deletion unconfirmed' WHERE id = ?"
  )
    .bind(workspaceId)
    .run();
  return { nodeId, workspaceId };
}

beforeEach(async () => {
  await seedUser(USER_ID);
  await resetLifecycleState();
});

describe('status tables stay trigger-free', () => {
  // Status writers guard with `meta.changes === 1`, and D1 counts trigger writes in it. A
  // trigger that writes on these tables broke node provisioning on staging (migration 0219).
  it('reports exactly one change for a one-row status update on every watched table', async () => {
    const nodeId = `node-${crypto.randomUUID()}`;
    const workspaceId = `ws-${crypto.randomUUID()}`;
    const snapshotId = `snap-${crypto.randomUUID()}`;
    await seedNode(nodeId, USER_ID, { status: 'creating' });
    await seedWorkspace(workspaceId, nodeId, USER_ID, { status: 'creating' });
    await seedSnapshot(snapshotId, workspaceId, nodeId);

    const updates = await env.DATABASE.batch([
      env.DATABASE.prepare("UPDATE nodes SET status = 'running' WHERE id = ?").bind(nodeId),
      env.DATABASE.prepare("UPDATE workspaces SET status = 'running' WHERE id = ?").bind(
        workspaceId
      ),
      env.DATABASE.prepare(
        "UPDATE session_snapshots SET sleep_status = 'sleeping' WHERE id = ?"
      ).bind(snapshotId),
      env.DATABASE.prepare(
        "UPDATE session_snapshots SET recovery_status = 'waking' WHERE id = ?"
      ).bind(snapshotId),
    ]);
    expect(updates.map((update) => update.meta.changes)).toEqual([1, 1, 1, 1]);

    // Only guard triggers that write nothing (BEFORE ... RAISE) may exist on these tables.
    const { results } = await env.DATABASE.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'trigger'
         AND tbl_name IN ('workspaces', 'nodes', 'session_snapshots') ORDER BY name`
    ).all<{ name: string }>();
    expect((results ?? []).map((row) => row.name)).toEqual(['trg_nodes_capacity_pool_max_nodes']);
  });
});

describe('lifecycle latency watchdog', () => {
  it('resolves its settings through the real admin settings resolver', async () => {
    expect(await resolveLifecycleLatencySettings(env as never)).toEqual(LIFECYCLE_LATENCY_DEFAULTS);
  });

  it('records one warning per slow episode, ends the episode when the state ends, and alerts a new one', async () => {
    const { nodeId, workspaceId } = await seedStoppingWorkspace();
    const message = 'Lifecycle latency budget exceeded: workspace stopping';
    const budget = LIFECYCLE_LATENCY_DEFAULTS.workspaceStoppingMinutes * MINUTE;
    const t0 = Date.now();

    // First sighting: observed, nothing over budget yet (liveness: the run did see it).
    const first = await runLifecycleLatencyWatchdog(env as never, new Date(t0));
    expect(first.observed.workspace).toBe(1);
    expect(first.alerted).toBe(0);
    const under = await runLifecycleLatencyWatchdog(env as never, new Date(t0 + budget - MINUTE));
    expect(under.alerted).toBe(0);
    expect(await platformErrors(message)).toHaveLength(0);

    const over = await runLifecycleLatencyWatchdog(env as never, new Date(t0 + budget + MINUTE));
    expect(over.alerted).toBe(1);
    expect(over.breached['workspace.stopping']).toBe(1);
    const [row] = await platformErrors(message);
    expect(row).toMatchObject({ level: 'warn', workspace_id: workspaceId, node_id: nodeId });
    expect(JSON.parse(row!.context!)).toMatchObject({
      entityType: 'workspace',
      entityId: workspaceId,
      status: 'stopping',
      ageMinutes: LIFECYCLE_LATENCY_DEFAULTS.workspaceStoppingMinutes + 1,
      budgetMinutes: LIFECYCLE_LATENCY_DEFAULTS.workspaceStoppingMinutes,
      lastError: 'deletion unconfirmed',
    });

    // Same episode on the next run: still breached, not re-alerted.
    const again = await runLifecycleLatencyWatchdog(
      env as never,
      new Date(t0 + budget + 6 * MINUTE)
    );
    expect(again).toMatchObject({ alerted: 0, breached: { 'workspace.stopping': 1 } });
    expect(await platformErrors(message)).toHaveLength(1);

    // The workspace leaves the state: the episode is recorded and the observation closed.
    await setStatus('workspaces', workspaceId, 'running');
    const ended = await runLifecycleLatencyWatchdog(
      env as never,
      new Date(t0 + budget + 11 * MINUTE)
    );
    expect(ended.ended).toBe(1);
    const episode = await env.DATABASE.prepare(
      'SELECT status, first_seen_at, last_seen_at FROM lifecycle_state_episodes WHERE entity_id = ?'
    )
      .bind(workspaceId)
      .first<{ status: string; first_seen_at: string; last_seen_at: string }>();
    expect(episode).toEqual({
      status: 'stopping',
      first_seen_at: new Date(t0).toISOString(),
      last_seen_at: new Date(t0 + budget + 6 * MINUTE).toISOString(),
    });

    // A later, separate stop is a new episode and alerts again.
    await setStatus('workspaces', workspaceId, 'stopping');
    const t1 = t0 + budget + 20 * MINUTE;
    await runLifecycleLatencyWatchdog(env as never, new Date(t1));
    const second = await runLifecycleLatencyWatchdog(env as never, new Date(t1 + budget + MINUTE));
    expect(second.alerted).toBe(1);
    expect(await platformErrors(message)).toHaveLength(2);
  });

  it('ignores states that are not watched', async () => {
    const nodeId = `node-${crypto.randomUUID()}`;
    const workspaceId = `ws-${crypto.randomUUID()}`;
    await seedNode(nodeId, USER_ID, { status: 'running' });
    await seedWorkspace(workspaceId, nodeId, USER_ID, { status: 'running' });
    const t0 = Date.now();
    await runLifecycleLatencyWatchdog(env as never, new Date(t0));
    const result = await runLifecycleLatencyWatchdog(env as never, new Date(t0 + DAY));
    expect(result).toMatchObject({ alerted: 0, breached: {}, observed: { workspace: 0, node: 0 } });
  });

  it('caps alerts per state, oldest first, and discloses the rest', async () => {
    for (let i = 0; i < 3; i++)
      await seedNode(`node-${crypto.randomUUID()}`, USER_ID, { status: 'creating' });
    const settings = { ...LIFECYCLE_LATENCY_DEFAULTS, alertsPerStatePerTick: 2 };
    const t0 = Date.now();
    await runLifecycleLatencyWatchdog(env as never, new Date(t0), settings);
    const at = new Date(t0 + (LIFECYCLE_LATENCY_DEFAULTS.nodeCreatingMinutes + 1) * MINUTE);

    expect(await runLifecycleLatencyWatchdog(env as never, at, settings)).toMatchObject({
      alerted: 2,
      deferred: 1,
      breached: { 'node.creating': 3 },
    });
    expect(await runLifecycleLatencyWatchdog(env as never, at, settings)).toMatchObject({
      alerted: 1,
      deferred: 0,
    });
    expect((await runLifecycleLatencyWatchdog(env as never, at, settings)).alerted).toBe(0);
    expect(await platformErrors('Lifecycle latency budget exceeded: node creating')).toHaveLength(
      3
    );
  });

  it('alerts once when two watchdog runs overlap', async () => {
    await seedNode(`node-${crypto.randomUUID()}`, USER_ID, { status: 'creating' });
    const t0 = Date.now();
    await runLifecycleLatencyWatchdog(env as never, new Date(t0));
    const at = new Date(t0 + (LIFECYCLE_LATENCY_DEFAULTS.nodeCreatingMinutes + 1) * MINUTE);
    const [left, right] = await Promise.all([
      runLifecycleLatencyWatchdog(env as never, at),
      runLifecycleLatencyWatchdog(env as never, at),
    ]);
    expect(left.alerted + right.alerted).toBe(1);
    expect(await platformErrors('Lifecycle latency budget exceeded: node creating')).toHaveLength(
      1
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

    const t0 = Date.now();
    await runLifecycleLatencyWatchdog(env as never, new Date(t0));
    const result = await runLifecycleLatencyWatchdog(env as never, new Date(t0 + 16 * MINUTE));
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

  it('turns a watch off when its budget is 0, closing its open episodes', async () => {
    const nodeId = `node-${crypto.randomUUID()}`;
    await seedNode(nodeId, USER_ID, { status: 'creating' });
    const t0 = Date.now();
    await runLifecycleLatencyWatchdog(env as never, new Date(t0));
    const settings = { ...LIFECYCLE_LATENCY_DEFAULTS, nodeCreatingMinutes: 0 };
    const result = await runLifecycleLatencyWatchdog(env as never, new Date(t0 + HOUR), settings);
    expect(result).toMatchObject({ alerted: 0, ended: 1 });
    expect(result.breached['node.creating']).toBeUndefined();
  });

  it('does not close episodes it could not see when the sample is truncated', async () => {
    const first = `node-${crypto.randomUUID()}`;
    await seedNode(first, USER_ID, { status: 'creating' });
    const t0 = Date.now();
    await runLifecycleLatencyWatchdog(env as never, new Date(t0));
    await seedNode(`node-${crypto.randomUUID()}`, USER_ID, { status: 'creating' });
    await seedNode(`node-${crypto.randomUUID()}`, USER_ID, { status: 'creating' });
    await setStatus('nodes', first, 'running');

    const settings = { ...LIFECYCLE_LATENCY_DEFAULTS, observationsPerSourcePerTick: 1 };
    const truncated = await runLifecycleLatencyWatchdog(
      env as never,
      new Date(t0 + MINUTE),
      settings
    );
    expect(truncated).toMatchObject({ truncated: ['node'], ended: 0 });

    // A full sample later closes the episode that really ended.
    const full = await runLifecycleLatencyWatchdog(env as never, new Date(t0 + 2 * MINUTE));
    expect(full.truncated).toEqual([]);
    expect(full.ended).toBe(1);
  });
});

describe('lifecycle latency watchdog under sustained overflow', () => {
  it('observes every row within a few runs when more rows exist than the sample cap', async () => {
    const nodeIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = `node-${crypto.randomUUID()}`;
      nodeIds.push(id);
      await seedNode(id, USER_ID, { status: 'creating' });
    }
    const settings = { ...LIFECYCLE_LATENCY_DEFAULTS, observationsPerSourcePerTick: 1 };
    const t0 = Date.now();
    for (let run = 0; run < 3; run++) {
      const result = await runLifecycleLatencyWatchdog(
        env as never,
        new Date(t0 + run * MINUTE),
        settings
      );
      expect(result.truncated).toEqual(['node']);
    }
    const { results } = await env.DATABASE.prepare(
      "SELECT entity_id FROM lifecycle_state_observations WHERE entity_type = 'node' ORDER BY entity_id"
    ).all<{ entity_id: string }>();
    expect((results ?? []).map((row) => row.entity_id)).toEqual([...nodeIds].sort());

    // Every one is then alerted once it is over budget, despite the small sample cap.
    const late = new Date(t0 + (LIFECYCLE_LATENCY_DEFAULTS.nodeCreatingMinutes + 3) * MINUTE);
    const alerted = await runLifecycleLatencyWatchdog(env as never, late, settings);
    expect(alerted.alerted).toBe(3);
  });
});

describe('lifecycle latency daily evaluation', () => {
  async function seedEpisodes(
    now: number,
    entityType: string,
    status: string,
    episodes: Array<{ endedAgoMs: number; durationMs: number }>
  ) {
    await env.DATABASE.batch(
      episodes.map(({ endedAgoMs, durationMs }) =>
        env.DATABASE.prepare(
          `INSERT INTO lifecycle_state_episodes (entity_type, entity_id, status, first_seen_at, last_seen_at, ended_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          entityType,
          crypto.randomUUID(),
          status,
          new Date(now - endedAgoMs - durationMs).toISOString(),
          new Date(now - endedAgoMs).toISOString(),
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

  it('skips a state whose budget is 0, even when it regressed against its baseline', async () => {
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
    const settings = { ...LIFECYCLE_LATENCY_DEFAULTS, nodeCreatingMinutes: 0 };
    const result = await runLifecycleLatencyDailyEvaluation(env as never, new Date(now), settings);
    expect(result.evaluations.some((e) => e.entityType === 'node' && e.status === 'creating')).toBe(
      false
    );
    expect(result.evaluations.length).toBeGreaterThan(0);
    expect(await platformErrors('Lifecycle latency regression: node creating')).toHaveLength(0);
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

  it('measures episodes the watchdog recorded', async () => {
    const { workspaceId } = await seedStoppingWorkspace();
    const t0 = Date.now();
    await runLifecycleLatencyWatchdog(env as never, new Date(t0));
    await runLifecycleLatencyWatchdog(env as never, new Date(t0 + 5 * MINUTE));
    await setStatus('workspaces', workspaceId, 'deleted');
    await runLifecycleLatencyWatchdog(env as never, new Date(t0 + 10 * MINUTE));

    const result = await runLifecycleLatencyDailyEvaluation(
      env as never,
      new Date(t0 + 11 * MINUTE)
    );
    const stopping = result.evaluations.find(
      (e) => e.entityType === 'workspace' && e.status === 'stopping'
    );
    expect(stopping?.last24h).toMatchObject({ count: 1, maxMs: 5 * MINUTE });
  });

  it('purges episodes past retention', async () => {
    const now = Date.now();
    const retentionMs = LIFECYCLE_LATENCY_DEFAULTS.retentionDays * DAY;
    await seedEpisodes(now, 'workspace', 'stopping', [
      { endedAgoMs: retentionMs + DAY, durationMs: MINUTE },
      { endedAgoMs: HOUR, durationMs: MINUTE },
    ]);
    const result = await runLifecycleLatencyDailyEvaluation(env as never, new Date(now));
    expect(result.purgedEpisodes).toBe(1);
    const remaining = await env.DATABASE.prepare(
      'SELECT COUNT(*) AS n FROM lifecycle_state_episodes'
    ).first<{
      n: number;
    }>();
    expect(remaining?.n).toBe(1);
  });
});
