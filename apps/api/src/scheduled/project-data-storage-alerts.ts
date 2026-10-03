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
 *
 * The per-tick budget is spent only on alerts that are due: throttled conditions are skipped
 * first (a paged `KV.list` snapshot of live stamps), so a persistent severe condition cannot hold a slot it
 * is not using and starve the conditions ranked after it.
 */
import type { NotificationUrgency } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import {
  type BreakerRow,
  scanStorageAlertConditions,
  type TelemetryRow,
} from './project-data-storage-alert-scan';
import {
  deliverOpsAlert,
  listLiveThrottleStamps,
  listRealSuperadmins,
} from './superadmin-ops-alerts';

/** Cloudflare's per-object SQLite cap (10 GiB); the configured storage limit is lower. */
export const DEFAULT_PROJECT_DATA_STORAGE_HARD_CAP_BYTES = 10 * 1024 * 1024 * 1024;
export const DEFAULT_PROJECT_DATA_STORAGE_WALL_ALERT_RATIO = 0.95;
export const DEFAULT_PROJECT_DATA_STORAGE_ALERT_NOTIFICATION_THROTTLE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_PROJECT_DATA_STORAGE_ALERT_STALE_AFTER_MS = 3 * 60 * 60 * 1000;
/**
 * Due alerts attempted per tick. Worst-case I/O per tick (rules 47/60): 3 D1 reads, 2 more and a
 * KV cursor read and write only when a condition query is truncated, one KV list page per
 * `throttleListMaxPages`, and per attempted alert and superadmin one Notification DO RPC plus one
 * KV write: `3 + 4 + pages + maxAlertsPerTick x superadmins x 2`, i.e. 24 with one page and two
 * superadmins. Throttled and backed-off conditions cost no I/O beyond the list.
 */
export const DEFAULT_PROJECT_DATA_STORAGE_ALERT_MAX_ALERTS_PER_TICK = 4;
/** After a failed delivery, a recipient is not retried for that alert for this long. */
export const DEFAULT_PROJECT_DATA_STORAGE_ALERT_FAILURE_BACKOFF_MS = 15 * 60 * 1000;
/** Rows each condition query reads per tick; more qualifying rows are disclosed, not read. */
export const DEFAULT_PROJECT_DATA_STORAGE_ALERT_SCAN_LIMIT = 50;
const MAX_PROJECT_DATA_STORAGE_ALERT_SCAN_LIMIT = 500;
/** KV list pages (1,000 keys each) read for the throttle snapshot before failing closed. */
export const DEFAULT_PROJECT_DATA_STORAGE_ALERT_THROTTLE_LIST_MAX_PAGES = 5;
export const DEFAULT_PROJECT_DATA_STORAGE_ALERT_KV_PREFIX = 'project-data-storage-alert';
const ADMIN_STORAGE_URL = '/admin/storage';

export interface ProjectDataStorageAlertConfig {
  hardCapBytes: number;
  wallAlertRatio: number;
  throttleMs: number;
  staleAfterMs: number;
  maxAlertsPerTick: number;
  failureBackoffMs: number;
  scanLimit: number;
  throttleListMaxPages: number;
  kvPrefix: string;
}

export interface ProjectDataStorageAlertStats {
  /** Conditions found this tick; a lower bound when `scanTruncated`. */
  candidates: number;
  /** Due alerts attempted this tick (at most `maxAlertsPerTick`); `notificationsSent` counts deliveries. */
  alerts: number;
  /** Due alerts left for a later tick by the per-tick budget. */
  deferred: number;
  /** A condition query found more rows than `scanLimit`. */
  scanTruncated: boolean;
  notificationsSent: number;
  throttled: number;
  deliveryFailures: number;
}

type AlertKind =
  'breaker_open' | 'breaker_frozen' | 'near_wall' | 'near_wall_stale' | 'cleanup_unreachable';

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
    failureBackoffMs: parsePositiveInt(
      env.PROJECT_DATA_STORAGE_ALERT_FAILURE_BACKOFF_MS,
      DEFAULT_PROJECT_DATA_STORAGE_ALERT_FAILURE_BACKOFF_MS
    ),
    scanLimit: Math.min(
      parsePositiveInt(
        env.PROJECT_DATA_STORAGE_ALERT_SCAN_LIMIT,
        DEFAULT_PROJECT_DATA_STORAGE_ALERT_SCAN_LIMIT
      ),
      MAX_PROJECT_DATA_STORAGE_ALERT_SCAN_LIMIT
    ),
    throttleListMaxPages: parsePositiveInt(
      env.PROJECT_DATA_STORAGE_ALERT_THROTTLE_LIST_MAX_PAGES,
      DEFAULT_PROJECT_DATA_STORAGE_ALERT_THROTTLE_LIST_MAX_PAGES
    ),
    kvPrefix:
      env.PROJECT_DATA_STORAGE_ALERT_KV_PREFIX || DEFAULT_PROJECT_DATA_STORAGE_ALERT_KV_PREFIX,
  };
}

function gigabytes(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

const GIB = 1024 * 1024 * 1024;

/** The configured hard cap, as Cloudflare states it ("10 GiB"), never a hardcoded label. */
function capLabel(config: ProjectDataStorageAlertConfig): string {
  const gib = config.hardCapBytes / GIB;
  return `${Number.isInteger(gib) ? gib : gib.toFixed(2)} GiB`;
}

function label(row: { project_id: string; project_name: string | null }): string {
  return row.project_name ? `${row.project_name} (${row.project_id})` : row.project_id;
}

function iso(ms: number | null): string {
  return ms === null ? 'an unknown time' : new Date(ms).toISOString();
}

function breakerAlert(
  row: BreakerRow,
  wallBytes: number,
  config: ProjectDataStorageAlertConfig
): StorageAlert {
  const nearWall = (row.database_size_bytes ?? 0) >= wallBytes;
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
      nearWall ? ` Its storage is near the ${capLabel(config)} hard cap.` : ''
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
    title: `${row.project_name ?? row.project_id} storage is near the ${capLabel(config)} hard cap${stale ? ' (telemetry stale)' : ''}`,
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

/** Order within one urgency: the stopped drain first, the routine freeze last. */
const KIND_RANK: Record<AlertKind, number> = {
  breaker_open: 0,
  near_wall: 1,
  near_wall_stale: 2,
  breaker_frozen: 3,
  cleanup_unreachable: 4,
};
const URGENCY_RANK: Record<NotificationUrgency, number> = { high: 0, medium: 1, low: 2 };

/**
 * Collect current alert conditions, most severe first (`project-data-storage-alert-scan.ts`
 * decides which rows a tick reads).
 */
export async function collectProjectDataStorageAlerts(
  env: Env,
  config: ProjectDataStorageAlertConfig,
  now: number
): Promise<{ alerts: StorageAlert[]; scanTruncated: boolean }> {
  const wallBytes = Math.floor(config.hardCapBytes * config.wallAlertRatio);
  const scan = await scanStorageAlertConditions(env, {
    scanLimit: config.scanLimit,
    kvPrefix: config.kvPrefix,
    wallBytes,
  });
  const alerts: StorageAlert[] = [
    ...scan.breakers.map((row) => breakerAlert(row, wallBytes, config)),
    ...scan.telemetry
      .filter((row) => row.database_size_bytes >= wallBytes)
      .map((row) => wallAlert(row, config, now)),
    ...scan.telemetry
      .filter((row) => row.cleanup_health === 'target_unreachable')
      .map((row) => cleanupAlert(row)),
  ];
  // Stable: ties keep each query's own order.
  alerts.sort(
    (left, right) =>
      URGENCY_RANK[left.urgency] - URGENCY_RANK[right.urgency] ||
      KIND_RANK[left.kind] - KIND_RANK[right.kind]
  );
  return { alerts, scanTruncated: scan.scanTruncated };
}

export async function runProjectDataStorageAlerts(
  env: Env,
  now: number = Date.now()
): Promise<ProjectDataStorageAlertStats> {
  const config = resolveProjectDataStorageAlertConfig(env);
  const { alerts, scanTruncated } = await collectProjectDataStorageAlerts(env, config, now);
  const stats: ProjectDataStorageAlertStats = {
    candidates: alerts.length,
    alerts: 0,
    deferred: 0,
    scanTruncated,
    notificationsSent: 0,
    throttled: 0,
    deliveryFailures: 0,
  };
  if (alerts.length === 0) return stats;

  const recipients = await listRealSuperadmins(env);
  if (recipients.length === 0) return stats;
  const live = await listLiveThrottleStamps(env, config.kvPrefix, now, config.throttleListMaxPages);
  if (!live) {
    stats.deliveryFailures = alerts.length;
    return stats;
  }
  // First deliveries before retries: a recipient whose deliveries keep failing gets only the
  // budget the healthy deliveries leave, so it can never keep a condition from anyone else.
  const firstDeliveries: Array<{ alert: StorageAlert; throttleKey: string; due: string[] }> = [];
  const retries: Array<{ alert: StorageAlert; throttleKey: string; due: string[] }> = [];
  for (const alert of alerts) {
    const throttleKey = `${config.kvPrefix}:${alert.kind}:${alert.projectId}:${alert.episode}`;
    const fresh: string[] = [];
    const retryDue: string[] = [];
    for (const userId of recipients) {
      const stamp = live.get(`${throttleKey}:${userId}`);
      if (!stamp) fresh.push(userId);
      else if (stamp.kind === 'failed' && (stamp.retryAt ?? 0) <= now) retryDue.push(userId);
      else stats.throttled++;
    }
    if (fresh.length > 0)
      firstDeliveries.push({ alert, throttleKey, due: [...fresh, ...retryDue] });
    else if (retryDue.length > 0) retries.push({ alert, throttleKey, due: retryDue });
  }
  for (const { alert, throttleKey, due } of [...firstDeliveries, ...retries]) {
    if (stats.alerts >= config.maxAlertsPerTick) {
      stats.deferred++;
      continue;
    }
    stats.alerts++;
    const result = await deliverOpsAlert(
      env,
      {
        throttleKey,
        throttleMs: config.throttleMs,
        failureBackoffMs: config.failureBackoffMs,
        now,
        notification: {
          type: 'cron_failure',
          urgency: alert.urgency,
          title: alert.title,
          body: alert.body,
          actionUrl: ADMIN_STORAGE_URL,
          metadata: { alertKind: alert.kind, ...alert.metadata },
        },
      },
      due
    );
    stats.notificationsSent += result.sent;
    stats.deliveryFailures += result.failed;
  }
  if (stats.deferred > 0 || scanTruncated) {
    log.warn('project_data_storage_alerts.truncated', {
      candidates: stats.candidates,
      sent: stats.alerts,
      deferred: stats.deferred,
      scanTruncated,
      maxAlertsPerTick: config.maxAlertsPerTick,
      scanLimit: config.scanLimit,
    });
  }
  return stats;
}
