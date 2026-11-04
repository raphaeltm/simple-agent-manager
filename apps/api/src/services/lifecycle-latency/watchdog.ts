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
  entered_at: string;
  breached: number;
  pending: number;
  /** 1 when this episode already has an alert record. */
  alerted: number;
  node_id: string | null;
  workspace_id: string | null;
  user_id: string | null;
  chat_session_id: string | null;
  error_message: string | null;
}

export interface LifecycleLatencyWatchdogResult {
  /** Watched states with a non-zero budget. */
  watchedStates: number;
  /** Episodes over budget right now, per `entity.status`. */
  breached: Record<string, number>;
  /** New alerts recorded this run (at most once per episode). */
  alerted: number;
  /** Over-budget episodes not examined this run because of the per-state cap. */
  deferred: number;
}

/** Stable per state so platform-feedback triage groups every episode into one signature. */
export function slowStateMessage(entityType: LifecycleEntityType, status: string): string {
  return `Lifecycle latency budget exceeded: ${entityType} ${status}`;
}

/**
 * Finds rows that have stayed in a transient state longer than its budget and records one
 * `platform_errors` warning per episode (entity, state, entry time). The hourly
 * platform-feedback triage turns those into incidents for the feedback project.
 *
 * I/O per run: one settings read (cached), one SELECT per entity source (4), one batched
 * INSERT OR IGNORE, and one observability insert per new alert (at most
 * `alertsPerStatePerTick` per state).
 */
export async function runLifecycleLatencyWatchdog(
  env: Env,
  now: Date = new Date(),
  settingsOverride?: LifecycleLatencySettings
): Promise<LifecycleLatencyWatchdogResult> {
  const settings = settingsOverride ?? (await resolveLifecycleLatencySettings(env));
  const perStateCap = Math.max(1, settings.alertsPerStatePerTick);
  const active = LIFECYCLE_WATCHES.filter((watch) => budgetMs(settings, watch) > 0);
  const result: LifecycleLatencyWatchdogResult = {
    watchedStates: active.length,
    breached: {},
    alerted: 0,
    deferred: 0,
  };
  if (active.length === 0) return result;

  const byEntity = new Map<LifecycleEntityType, LifecycleWatch[]>();
  for (const watch of active) {
    byEntity.set(watch.entityType, [...(byEntity.get(watch.entityType) ?? []), watch]);
  }

  const candidates: Array<{ watch: LifecycleWatch; row: SlowRow }> = [];
  for (const [entityType, watches] of byEntity) {
    const rows = await selectSlowRows(env, entityType, watches, settings, perStateCap, now);
    for (const row of rows) {
      const watch = watches.find((candidate) => candidate.status === row.status);
      if (!watch) continue;
      const key = `${entityType}.${row.status}`;
      result.breached[key] = Number(row.breached);
      if (Number(row.alerted) === 0) candidates.push({ watch, row });
    }
  }
  const pendingByState = new Map<string, number>();
  for (const { watch, row } of candidates) {
    pendingByState.set(`${watch.entityType}.${row.status}`, Number(row.pending));
  }
  for (const [key, pending] of pendingByState) {
    const examined = candidates.filter((c) => `${c.watch.entityType}.${c.row.status}` === key);
    result.deferred += Math.max(0, pending - examined.length);
  }
  if (candidates.length === 0) {
    log.info('lifecycle_latency.watchdog', { ...result });
    return result;
  }

  const alertedAt = now.toISOString();
  const inserts = await env.DATABASE.batch(
    candidates.map(({ watch, row }) =>
      env.DATABASE.prepare(
        `INSERT OR IGNORE INTO lifecycle_latency_alerts (entity_type, entity_id, status, entered_at, alerted_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(watch.entityType, row.id, row.status, row.entered_at, alertedAt)
    )
  );

  for (const [index, { watch, row }] of candidates.entries()) {
    if ((inserts[index]?.meta.changes ?? 0) !== 1) continue; // already alerted for this episode
    result.alerted += 1;
    const ageMinutes = Math.round((now.getTime() - Date.parse(row.entered_at)) / 60_000);
    const context = {
      entityType: watch.entityType,
      entityId: row.id,
      status: row.status,
      enteredAt: row.entered_at,
      ageMinutes,
      budgetMinutes: settings[watch.budgetKey],
      overBudgetInState: Number(row.breached),
      chatSessionId: row.chat_session_id,
      lastError: row.error_message?.slice(0, ERROR_MESSAGE_MAX_LENGTH) ?? null,
    };
    log.warn('lifecycle_latency.budget_exceeded', context);
    await persistError(
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
    );
  }

  log.info('lifecycle_latency.watchdog', { ...result });
  return result;
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

async function selectSlowRows(
  env: Env,
  entityType: LifecycleEntityType,
  watches: LifecycleWatch[],
  settings: LifecycleLatencySettings,
  perStateCap: number,
  now: Date
): Promise<SlowRow[]> {
  const source = LIFECYCLE_ENTITY_SOURCES[entityType];
  const predicates = watches
    .map(() => `(t.${source.statusColumn} = ? AND t.${source.changedAtColumn} < ?)`)
    .join(' OR ');
  const bindings = watches.flatMap((watch) => [
    watch.status,
    new Date(now.getTime() - budgetMs(settings, watch)).toISOString(),
  ]);
  // Oldest episodes first, capped per state so one stuck state cannot hide the others. Alerted
  // and unalerted episodes are ranked separately, so a backlog of already-alerted, long-stuck rows
  // can never take the slots of newer ones (the caller alerts only `alerted = 0` rows).
  // `breached` and `pending` disclose the totals (rule 65).
  const sql = `SELECT * FROM (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY status, alerted ORDER BY entered_at, id) AS rn,
        COUNT(*) OVER (PARTITION BY status) AS breached,
        SUM(1 - alerted) OVER (PARTITION BY status) AS pending
      FROM (
        SELECT t.id, t.${source.statusColumn} AS status, t.${source.changedAtColumn} AS entered_at,
          ${prefixed(source.detailColumns, 't')},
          CASE WHEN a.entity_id IS NULL THEN 0 ELSE 1 END AS alerted
        FROM ${source.table} t
        LEFT JOIN lifecycle_latency_alerts a
          ON a.entity_type = ? AND a.entity_id = t.id
         AND a.status = t.${source.statusColumn} AND a.entered_at = t.${source.changedAtColumn}
        WHERE t.${source.changedAtColumn} IS NOT NULL AND (${predicates})
      )
    ) WHERE rn <= ?
    ORDER BY entered_at, id`;
  const { results } = await env.DATABASE.prepare(sql)
    .bind(entityType, ...bindings, perStateCap)
    .all<SlowRow>();
  return results ?? [];
}
