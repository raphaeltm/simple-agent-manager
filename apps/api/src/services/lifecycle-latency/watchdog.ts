import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { persistError } from '../observability';
import {
  budgetMs,
  LIFECYCLE_ENTITY_SOURCES,
  LIFECYCLE_WATCHES,
  type LifecycleEntityType,
  type LifecycleLatencySettings,
  type LifecycleWatch,
  resolveLifecycleLatencySettings,
} from './watches';

const ERROR_MESSAGE_MAX_LENGTH = 300;

interface SlowRow {
  id: string;
  status: string;
  first_seen_at: string;
  /** 1 when this episode was already alerted. */
  alerted: number;
  breached: number;
  pending: number;
  node_id: string | null;
  workspace_id: string | null;
  user_id: string | null;
  chat_session_id: string | null;
  error_message: string | null;
}

export interface LifecycleLatencyWatchdogResult {
  /** Watched states with a non-zero budget. */
  watchedStates: number;
  /** Rows currently seen in a watched state, per entity type. */
  observed: Record<string, number>;
  /** Entity types whose sample hit `observationsPerSourcePerTick`; their episodes are not ended. */
  truncated: string[];
  /** Episodes that ended since the previous run. */
  ended: number;
  /** Episodes over budget right now, per `entity.status`. */
  breached: Record<string, number>;
  /** New alerts recorded this run (at most once per episode). */
  alerted: number;
  /** Over-budget episodes not alerted this run because of the per-state cap. */
  deferred: number;
}

/** Stable per state so platform-feedback triage groups every episode into one signature. */
export function slowStateMessage(entityType: LifecycleEntityType, status: string): string {
  return `Lifecycle latency budget exceeded: ${entityType} ${status}`;
}

/**
 * Samples rows in transient states every run and records one `platform_errors` warning per
 * episode that stays in a state longer than its budget. The hourly platform-feedback triage turns
 * those into incidents for the feedback project.
 *
 * Entry time is when this watchdog first saw the row in the state, so an alert fires at most one
 * run late. It deliberately does not use triggers on the status tables (migration 0219).
 *
 * I/O per run, per entity source (4): one sample SELECT, one batched upsert of at most
 * `observationsPerSourcePerTick` rows, one two-statement batch that ends unseen episodes, one
 * alert SELECT and one batched compare-and-set. Plus one observability insert per new alert,
 * issued in parallel (at most `alertsPerStatePerTick` per state).
 */
export async function runLifecycleLatencyWatchdog(
  env: Env,
  now: Date = new Date(),
  settingsOverride?: LifecycleLatencySettings
): Promise<LifecycleLatencyWatchdogResult> {
  const settings = settingsOverride ?? (await resolveLifecycleLatencySettings(env));
  const active = LIFECYCLE_WATCHES.filter((watch) => budgetMs(settings, watch) > 0);
  const result: LifecycleLatencyWatchdogResult = {
    watchedStates: active.length,
    observed: {},
    truncated: [],
    ended: 0,
    breached: {},
    alerted: 0,
    deferred: 0,
  };

  const byEntity = new Map<LifecycleEntityType, LifecycleWatch[]>();
  for (const watch of active) {
    byEntity.set(watch.entityType, [...(byEntity.get(watch.entityType) ?? []), watch]);
  }
  const nowIso = now.toISOString();

  // Every entity type is swept, including ones with no active watch, so turning a watch off
  // still ends its open episodes.
  for (const entityType of Object.keys(LIFECYCLE_ENTITY_SOURCES) as LifecycleEntityType[]) {
    const watches = byEntity.get(entityType) ?? [];
    const truncated = await observe(env, entityType, watches, settings, nowIso, result);
    if (!truncated) result.ended += await endUnseenEpisodes(env, entityType, nowIso);
  }

  const alerts: Array<{ watch: LifecycleWatch; row: SlowRow }> = [];
  const pendingByState = new Map<string, number>();
  for (const [entityType, watches] of byEntity) {
    for (const row of await selectSlowObservations(env, entityType, watches, settings, now)) {
      const watch = watches.find((candidate) => candidate.status === row.status);
      if (!watch) continue;
      const key = `${entityType}.${row.status}`;
      result.breached[key] = Number(row.breached);
      pendingByState.set(key, Number(row.pending));
      if (Number(row.alerted) === 0) alerts.push({ watch, row });
    }
  }
  for (const [key, pending] of pendingByState) {
    const selected = alerts.filter((a) => `${a.watch.entityType}.${a.row.status}` === key);
    result.deferred += Math.max(0, pending - selected.length);
  }

  if (alerts.length > 0) {
    // Compare-and-set per episode: of two overlapping runs, exactly one claims each alert.
    const claims = await env.DATABASE.batch(
      alerts.map(({ watch, row }) =>
        env.DATABASE.prepare(
          `UPDATE lifecycle_state_observations SET alerted_at = ?
            WHERE entity_type = ? AND entity_id = ? AND status = ? AND first_seen_at = ?
              AND alerted_at IS NULL`
        ).bind(nowIso, watch.entityType, row.id, row.status, row.first_seen_at)
      )
    );
    const writes: Promise<void>[] = [];
    for (const [index, { watch, row }] of alerts.entries()) {
      if ((claims[index]?.meta.changes ?? 0) !== 1) continue;
      result.alerted += 1;
      const context = {
        entityType: watch.entityType,
        entityId: row.id,
        status: row.status,
        firstSeenAt: row.first_seen_at,
        ageMinutes: Math.round((now.getTime() - Date.parse(row.first_seen_at)) / 60_000),
        budgetMinutes: settings[watch.budgetKey],
        overBudgetInState: Number(row.breached),
        chatSessionId: row.chat_session_id,
        lastError: row.error_message?.slice(0, ERROR_MESSAGE_MAX_LENGTH) ?? null,
      };
      log.warn('lifecycle_latency.budget_exceeded', context);
      // Independent writes; persistError never throws, so one slow write cannot stall the others.
      writes.push(
        persistError(
          env.OBSERVABILITY_DATABASE,
          {
            source: 'api',
            level: 'warn',
            message: slowStateMessage(watch.entityType, row.status),
            context,
            nodeId: row.node_id,
            workspaceId: row.workspace_id,
            userId: row.user_id,
            sessionId: row.chat_session_id,
          },
          env
        )
      );
    }
    await Promise.all(writes);
  }

  log.info('lifecycle_latency.watchdog', { ...result });
  return result;
}

/** Records this run's sighting of every row in a watched state. Returns true when truncated. */
async function observe(
  env: Env,
  entityType: LifecycleEntityType,
  watches: LifecycleWatch[],
  settings: LifecycleLatencySettings,
  nowIso: string,
  result: LifecycleLatencyWatchdogResult
): Promise<boolean> {
  if (watches.length === 0) return false;
  const source = LIFECYCLE_ENTITY_SOURCES[entityType];
  const cap = Math.max(1, settings.observationsPerSourcePerTick);
  const placeholders = watches.map(() => '?').join(', ');
  // Oldest rows first (rowid order), one extra row to detect truncation.
  const { results } = await env.DATABASE.prepare(
    `SELECT id, ${source.statusColumn} AS status FROM ${source.table}
      WHERE ${source.statusColumn} IN (${placeholders})
      ORDER BY rowid LIMIT ?`
  )
    .bind(...watches.map((watch) => watch.status), cap + 1)
    .all<{ id: string; status: string }>();
  const rows = results ?? [];
  const truncated = rows.length > cap;
  const sample = rows.slice(0, cap);
  result.observed[entityType] = sample.length;
  if (truncated) {
    result.truncated.push(entityType);
    log.warn('lifecycle_latency.sample_truncated', {
      entityType,
      cap,
      action: 'episodes_not_ended_this_run',
    });
  }
  if (sample.length > 0) {
    await env.DATABASE.batch(
      sample.map((row) =>
        env.DATABASE.prepare(
          `INSERT INTO lifecycle_state_observations
             (entity_type, entity_id, status, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (entity_type, entity_id, status) DO UPDATE SET last_seen_at = excluded.last_seen_at`
        ).bind(entityType, row.id, row.status, nowIso, nowIso)
      )
    );
  }
  return truncated;
}

/**
 * Moves observations this run did not refresh into the episode history. One atomic batch, so an
 * overlapping run cannot record the same episode twice.
 */
async function endUnseenEpisodes(
  env: Env,
  entityType: LifecycleEntityType,
  nowIso: string
): Promise<number> {
  const [inserted] = await env.DATABASE.batch([
    env.DATABASE.prepare(
      `INSERT INTO lifecycle_state_episodes
         (entity_type, entity_id, status, first_seen_at, last_seen_at, ended_at)
       SELECT entity_type, entity_id, status, first_seen_at, last_seen_at, ?
         FROM lifecycle_state_observations WHERE entity_type = ? AND last_seen_at < ?`
    ).bind(nowIso, entityType, nowIso),
    env.DATABASE.prepare(
      'DELETE FROM lifecycle_state_observations WHERE entity_type = ? AND last_seen_at < ?'
    ).bind(entityType, nowIso),
  ]);
  return inserted?.meta.changes ?? 0;
}

async function selectSlowObservations(
  env: Env,
  entityType: LifecycleEntityType,
  watches: LifecycleWatch[],
  settings: LifecycleLatencySettings,
  now: Date
): Promise<SlowRow[]> {
  const source = LIFECYCLE_ENTITY_SOURCES[entityType];
  const predicates = watches.map(() => '(o.status = ? AND o.first_seen_at < ?)').join(' OR ');
  const bindings = watches.flatMap((watch) => [
    watch.status,
    new Date(now.getTime() - budgetMs(settings, watch)).toISOString(),
  ]);
  // Oldest episodes first, capped per state so one stuck state cannot hide the others. Alerted
  // and unalerted episodes are ranked separately, so a backlog of already-alerted, long-stuck
  // rows never takes the slots of newer ones; the caller alerts only `alerted = 0` rows.
  // `breached` and `pending` disclose the totals (rule 65). The join keeps only rows still in
  // that state.
  const sql = `SELECT * FROM (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY status, alerted ORDER BY first_seen_at, id) AS rn,
        COUNT(*) OVER (PARTITION BY status) AS breached,
        SUM(1 - alerted) OVER (PARTITION BY status) AS pending
      FROM (
        SELECT o.entity_id AS id, o.status AS status, o.first_seen_at AS first_seen_at,
          CASE WHEN o.alerted_at IS NULL THEN 0 ELSE 1 END AS alerted,
          ${prefixed(source.detailColumns, 't')}
        FROM lifecycle_state_observations o
        JOIN ${source.table} t ON t.id = o.entity_id AND t.${source.statusColumn} = o.status
        WHERE o.entity_type = ? AND (${predicates})
      )
    ) WHERE rn <= ?
    ORDER BY first_seen_at, id`;
  const { results } = await env.DATABASE.prepare(sql)
    .bind(entityType, ...bindings, Math.max(1, settings.alertsPerStatePerTick))
    .all<SlowRow>();
  return results ?? [];
}

/** Qualifies each `expr AS alias` detail column with the table alias. */
function prefixed(detailColumns: string, alias: string): string {
  return detailColumns
    .split(',')
    .map((column) => {
      const trimmed = column.trim();
      return trimmed.startsWith('NULL ') ? trimmed : `${alias}.${trimmed}`;
    })
    .join(', ');
}
