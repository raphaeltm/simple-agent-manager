/**
 * Operator alerts for ProjectData storage safety, pushed to superadmins as "Operational
 * Failure" notifications (type `cron_failure`).
 *
 * On 2026-09-27 the SAM project's archive breaker opened and nothing told anyone: the breaker
 * write logged nothing, and storage "alerts" were log lines plus `platform_errors` rows. Five
 * days later the root ProjectData object reached Cloudflare's hard 10 GiB per-object cap and
 * every SAM write failed. This step reads only D1 (the DO may be full) and pages superadmins
 * while a breaker is not closed, while a project's last exported measurement is near the real
 * cap, and while automatic cleanup cannot reach its target. Each condition repeats at most
 * once per recipient per throttle window, and every alert names when it was observed: it can
 * only be as fresh as the telemetry the object last exported.
 */
import type { NotificationUrgency } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { listRealSuperadmins, notifySuperadminsThrottled } from './superadmin-ops-alerts';

/** Cloudflare's per-object SQLite cap (10 GiB); the configured storage limit is lower. */
export const DEFAULT_PROJECT_DATA_STORAGE_HARD_CAP_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_PROJECT_DATA_STORAGE_WALL_ALERT_RATIO = 0.95;
export const DEFAULT_PROJECT_DATA_STORAGE_ALERT_NOTIFICATION_THROTTLE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_STORAGE_ALERT_STALE_AFTER_MS = 3 * 60 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_STORAGE_ALERT_MAX_ALERTS_PER_TICK = 5;
export const DEFAULT_PROJECT_DATA_STORAGE_ALERT_KV_PREFIX = 'project-data-storage-alert';
const ADMIN_STORAGE_URL = '/admin/storage';

export interface ProjectDataStorageAlertConfig {
  hardCapBytes: number;
  wallAlertRatio: number;
  throttleMs: number;
  staleAfterMs: number;
  maxAlertsPerTick: number;
  kvPrefix: string;
}

export interface ProjectDataStorageAlertStats {
  /** Conditions found this tick; a lower bound when `alerts` was capped. */
  candidates: number;
  alerts: number;
  notificationsSent: number;
  throttled: number;
  deliveryFailures: number;
}

type AlertKind =
  | 'breaker_open'
  | 'breaker_frozen'
  | 'near_wall'
  | 'near_wall_stale'
  | 'cleanup_unreachable';

interface StorageAlert {
  kind: AlertKind;
  projectId: string;
  /** Distinguishes episodes so a re-opened breaker or an escalation alerts again. */
  episode: string;
  urgency: NotificationUrgency;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
}

interface BreakerRow {
  project_id: string;
  project_name: string | null;
  state: 'open' | 'frozen';
  reason: string | null;
  opened_at: number | null;
  updated_at: number;
}

interface TelemetryRow {
  project_id: string;
  project_name: string | null;
  database_size_bytes: number;
  measured_at: number;
  cleanup_health: string | null;
}

function parseRatio(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseFloat(raw ?? '');
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}

export function resolveProjectDataStorageAlertConfig(env: Env): ProjectDataStorageAlertConfig {
  return {
    hardCapBytes: parsePositiveInt(
      env.PROJECT_DATA_STORAGE_HARD_CAP_BYTES,
      DEFAULT_PROJECT_DATA_STORAGE_HARD_CAP_BYTES
    ),
    wallAlertRatio: parseRatio(
      env.PROJECT_DATA_STORAGE_WALL_ALERT_RATIO,
      DEFAULT_PROJECT_DATA_STORAGE_WALL_ALERT_RATIO
    ),
    throttleMs: parsePositiveInt(
      env.PROJECT_DATA_STORAGE_ALERT_NOTIFICATION_THROTTLE_MS,
      DEFAULT_PROJECT_DATA_STORAGE_ALERT_NOTIFICATION_THROTTLE_MS
    ),
    staleAfterMs: parsePositiveInt(
      env.PROJECT_DATA_STORAGE_ALERT_STALE_AFTER_MS,
      DEFAULT_PROJECT_DATA_STORAGE_ALERT_STALE_AFTER_MS
    ),
    maxAlertsPerTick: parsePositiveInt(
      env.PROJECT_DATA_STORAGE_ALERT_MAX_ALERTS_PER_TICK,
      DEFAULT_PROJECT_DATA_STORAGE_ALERT_MAX_ALERTS_PER_TICK
    ),
    kvPrefix:
      env.PROJECT_DATA_STORAGE_ALERT_KV_PREFIX || DEFAULT_PROJECT_DATA_STORAGE_ALERT_KV_PREFIX,
  };
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

function label(row: { project_id: string; project_name: string | null }): string {
  return row.project_name ? `${row.project_name} (${row.project_id})` : row.project_id;
}

function iso(ms: number | null): string {
  return ms === null ? 'an unknown time' : new Date(ms).toISOString();
}

function breakerAlert(row: BreakerRow, nearWall: boolean): StorageAlert {
  const since = row.opened_at ?? row.updated_at;
  const reason = row.reason ?? 'no reason recorded';
  if (row.state === 'open') {
    return {
      kind: 'breaker_open',
      projectId: row.project_id,
      episode: String(since),
      urgency: 'high',
      title: `Archive drain stopped: ${row.project_name ?? row.project_id}`,
      body: `The archive circuit breaker for ${label(row)} has been open since ${iso(since)} (${reason}). Its sessions are not archived until a superadmin closes the breaker in Admin → Storage.`,
      metadata: { projectId: row.project_id, breakerState: row.state, reason, since },
    };
  }
  // An operator freeze is deliberate, but a forgotten one stops the drain the same way. It
  // escalates, under a distinct episode, once the project's storage is near the hard cap.
  return {
    kind: 'breaker_frozen',
    projectId: row.project_id,
    episode: `${since}:${nearWall ? 'near_wall' : 'normal'}`,
    urgency: nearWall ? 'high' : 'medium',
    title: `Archive drain frozen: ${row.project_name ?? row.project_id}`,
    body: `The archive circuit breaker for ${label(row)} has been frozen since ${iso(since)} (${reason}).${
      nearWall ? ' Its storage is near the 10 GiB hard cap.' : ''
    } Its sessions are not archived until a superadmin closes the breaker in Admin → Storage.`,
    metadata: { projectId: row.project_id, breakerState: row.state, reason, since, nearWall },
  };
}

function wallAlert(
  row: TelemetryRow,
  config: ProjectDataStorageAlertConfig,
  now: number
): StorageAlert {
  const percent = ((row.database_size_bytes / config.hardCapBytes) * 100).toFixed(1);
  const stale = now - row.measured_at > config.staleAfterMs;
  const observed = `${gigabytes(row.database_size_bytes)} of ${gigabytes(config.hardCapBytes)} (${percent}%) as of ${iso(row.measured_at)}`;
  return {
    kind: stale ? 'near_wall_stale' : 'near_wall',
    projectId: row.project_id,
    episode: stale ? 'stale' : 'current',
    urgency: 'high',
    title: `${row.project_name ?? row.project_id} storage is near the 10 GiB hard cap${stale ? ' (telemetry stale)' : ''}`,
    body: stale
      ? `The last measurement exported for ${label(row)} was ${observed}, and nothing newer has arrived. Writes fail at the cap. Check Admin → Storage.`
      : `${label(row)} is at ${observed}. Writes fail at the cap. Check the archive breaker and recover space in Admin → Storage.`,
    metadata: {
      projectId: row.project_id,
      databaseSizeBytes: row.database_size_bytes,
      hardCapBytes: config.hardCapBytes,
      measuredAt: row.measured_at,
      stale,
    },
  };
}

function cleanupAlert(row: TelemetryRow): StorageAlert {
  return {
    kind: 'cleanup_unreachable',
    projectId: row.project_id,
    episode: 'target_unreachable',
    urgency: 'medium',
    title: `${row.project_name ?? row.project_id}: automatic storage cleanup cannot reach its target`,
    body: `Automatic cleanup for ${label(row)} has nothing left that it may reclaim, at ${gigabytes(row.database_size_bytes)} as of ${iso(row.measured_at)}. Archiving or a manual recovery has to free the rest (Admin → Storage).`,
    metadata: {
      projectId: row.project_id,
      databaseSizeBytes: row.database_size_bytes,
      measuredAt: row.measured_at,
    },
  };
}

/**
 * Collect current alert conditions, most severe first, bounded per tick. Each query is ordered by
 * severity before its LIMIT (open breakers before frozen ones, larger objects first), so the
 * per-tick bound can never drop a severe condition in favour of a milder one.
 */
export async function collectProjectDataStorageAlerts(
  env: Env,
  config: ProjectDataStorageAlertConfig,
  now: number
): Promise<{ alerts: StorageAlert[]; candidates: number }> {
  const limit = config.maxAlertsPerTick;
  // One extra row per query so a capped tick can tell that it dropped something (rule 65).
  const fetchLimit = limit + 1;
  const wallBytes = Math.floor(config.hardCapBytes * config.wallAlertRatio);
  const [breakers, telemetry] = await Promise.all([
    env.DATABASE.prepare(
      `SELECT b.project_id, p.name AS project_name, b.state, b.reason, b.opened_at, b.updated_at
       FROM project_data_archive_circuit_breakers b
       LEFT JOIN projects p ON p.id = b.project_id
       WHERE b.state IN ('open', 'frozen')
       ORDER BY CASE b.state WHEN 'open' THEN 0 ELSE 1 END,
         COALESCE(b.opened_at, b.updated_at) ASC
       LIMIT ?`
    )
      .bind(fetchLimit)
      .all<BreakerRow>(),
    env.DATABASE.prepare(
      `SELECT t.project_id, p.name AS project_name, t.database_size_bytes, t.measured_at,
              t.cleanup_health
       FROM project_data_storage_telemetry t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE t.database_size_bytes >= ? OR t.cleanup_health = 'target_unreachable'
       ORDER BY t.database_size_bytes DESC
       LIMIT ?`
    )
      .bind(wallBytes, fetchLimit)
      .all<TelemetryRow>(),
  ]);
  const telemetryRows = telemetry.results ?? [];
  const nearWall = new Set(
    telemetryRows.filter((row) => row.database_size_bytes >= wallBytes).map((row) => row.project_id)
  );
  const alerts: StorageAlert[] = [
    ...telemetryRows
      .filter((row) => row.database_size_bytes >= wallBytes)
      .map((row) => wallAlert(row, config, now)),
    ...(breakers.results ?? []).map((row) => breakerAlert(row, nearWall.has(row.project_id))),
    ...telemetryRows
      .filter((row) => row.cleanup_health === 'target_unreachable')
      .map((row) => cleanupAlert(row)),
  ];
  const severity = { high: 0, medium: 1, low: 2 } as const;
  alerts.sort((left, right) => severity[left.urgency] - severity[right.urgency]);
  return { alerts: alerts.slice(0, limit), candidates: alerts.length };
}

export async function runProjectDataStorageAlerts(
  env: Env,
  now: number = Date.now()
): Promise<ProjectDataStorageAlertStats> {
  const config = resolveProjectDataStorageAlertConfig(env);
  const { alerts, candidates } = await collectProjectDataStorageAlerts(env, config, now);
  const stats: ProjectDataStorageAlertStats = {
    candidates,
    alerts: alerts.length,
    notificationsSent: 0,
    throttled: 0,
    deliveryFailures: 0,
  };
  if (alerts.length === 0) return stats;

  const recipients = await listRealSuperadmins(env);
  for (const alert of alerts) {
    const result = await notifySuperadminsThrottled(
      env,
      {
        throttleKey: `${config.kvPrefix}:${alert.kind}:${alert.projectId}:${alert.episode}`,
        throttleMs: config.throttleMs,
        notification: {
          type: 'cron_failure',
          urgency: alert.urgency,
          title: alert.title,
          body: alert.body,
          actionUrl: ADMIN_STORAGE_URL,
          metadata: { alertKind: alert.kind, ...alert.metadata },
        },
      },
      recipients
    );
    stats.notificationsSent += result.sent;
    stats.throttled += result.throttled;
    stats.deliveryFailures += result.failed;
  }
  if (candidates > alerts.length) {
    log.warn('project_data_storage_alerts.truncated', {
      candidates,
      sent: alerts.length,
      maxAlertsPerTick: config.maxAlertsPerTick,
    });
  }
  return stats;
}
