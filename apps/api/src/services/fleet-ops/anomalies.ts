/**
 * `ops_find_anomalies`: a cheap, read-only SQL sweep for "what is broken right now" across
 * every user of the installation. Each class returns IDs plus a reason, its total count, and
 * whether the list was capped (`.claude/rules/65`).
 *
 * Thresholds come from the same configuration the reapers use, plus an Operations grace on
 * top, so a finding means "the cleanup that owns this should already have handled it":
 * - empty nodes: the warm-node cleanup grace (`resolveCleanupConfig().gracePeriodMs`) and the
 *   active-workspace statuses that hold a reservation (`ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL`),
 *   as in `scheduled/node-cleanup/empty-node-warm-handoff.ts` and `node-phases.ts`;
 * - stale heartbeats: each node's own `heartbeat_stale_after_seconds`, as in
 *   `services/node-health.ts deriveNodeHealth`.
 *
 * Each class is isolated: one failing query reports an error for that class only.
 */
import { WORKSPACE_DELETION_QUARANTINE_MESSAGE } from '../../durable-objects/node-lifecycle-workspace-deletion';
import type { Env } from '../../env';
import { chunk, D1_MAX_BOUND_PARAMETERS } from '../../lib/d1-limits';
import { log } from '../../lib/logger';
import { neutralizeUntrustedText } from '../../operations/untrusted-text';
import { resolveCleanupConfig } from '../../scheduled/node-cleanup/config';
import { deriveNodeHealth } from '../node-health';
import { ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL } from '../workspace-resource-capacity';
import type { FleetOpsSettings } from './settings';

export const ANOMALY_CLASSES = [
  'empty_node_past_warm_grace',
  'stale_node_heartbeat',
  'running_workspace_for_terminal_task',
  'idle_in_progress_task',
  'session_snapshot_failure',
  'workspace_deletion_quarantine',
  'pending_incident',
] as const;
export type AnomalyClass = (typeof ANOMALY_CLASSES)[number];

export interface AnomalyFinding {
  readonly ids: Readonly<Record<string, string | null>>;
  readonly reason: string;
  readonly observedAt: string | null;
}

export interface AnomalyClassResult {
  readonly class: AnomalyClass;
  readonly total: number;
  readonly returned: number;
  readonly truncated: boolean;
  readonly findings: readonly AnomalyFinding[];
  readonly error?: string;
  /** Set when `total` may count reported items that a full scan would have dropped. */
  readonly totalIsUpperBound?: boolean;
}

export interface AnomalyReport {
  readonly generatedAt: string;
  readonly thresholds: Readonly<Record<string, number>>;
  readonly classes: readonly AnomalyClassResult[];
}

type Row = Record<string, unknown>;

const TERMINAL_TASK_STATUS_SQL = "'completed', 'failed', 'cancelled'";
const ACTIVE_TASK_STATUS_SQL = "'queued', 'delegated', 'in_progress'";

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function int(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function minutesSince(iso: string | null, now: number): number | null {
  const at = iso ? Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`) : NaN;
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60_000)) : null;
}

function isoMinus(now: number, ms: number): string {
  return new Date(now - ms).toISOString();
}

/** Every class query selects `COUNT(*) OVER () AS total` so the cap is disclosed in one read. */
function result(
  cls: AnomalyClass,
  rows: Row[],
  toFinding: (row: Row) => AnomalyFinding
): AnomalyClassResult {
  const findings: AnomalyFinding[] = [];
  for (const row of rows) {
    try {
      findings.push(toFinding(row));
    } catch (error) {
      log.warn('fleet_ops.anomaly_row_skipped', {
        anomalyClass: cls,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const total = rows.length > 0 ? int(rows[0]?.total) : 0;
  return { class: cls, total, returned: findings.length, truncated: total > rows.length, findings };
}

/**
 * Quarantine reports are read up to this many times the per-class cap, so reports for
 * workspaces deleted since can be dropped without hiding open ones behind them.
 */
const QUARANTINE_SCAN_MULTIPLIER = 4;

interface SweepContext {
  readonly env: Env;
  readonly now: number;
  readonly cap: number;
  readonly emptyNodeIdleMs: number;
  readonly settings: FleetOpsSettings;
}

async function emptyNodes(ctx: SweepContext): Promise<AnomalyClassResult> {
  const rows = await ctx.env.DATABASE.prepare(
    `SELECT n.id, n.user_id, n.cloud_provider, n.warm_since,
            COALESCE(MAX(w.updated_at), n.created_at) AS last_activity,
            COUNT(*) OVER () AS total
     FROM nodes n
     LEFT JOIN workspaces w ON w.node_id = n.id
     WHERE n.status = 'running'
       AND n.node_role = 'workspace'
       AND n.node_class != 'user-owned'
       AND NOT EXISTS (
         SELECT 1 FROM workspaces live
         WHERE live.node_id = n.id AND live.status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL})
       )
     GROUP BY n.id, n.user_id, n.cloud_provider, n.warm_since, n.created_at
     HAVING julianday(COALESCE(MAX(w.updated_at), n.created_at)) < julianday(?)
     ORDER BY julianday(last_activity) ASC, n.id ASC
     LIMIT ?`
  )
    .bind(isoMinus(ctx.now, ctx.emptyNodeIdleMs), ctx.cap)
    .all<Row>();
  return result('empty_node_past_warm_grace', rows.results ?? [], (row) => {
    const lastActivity = text(row.last_activity);
    return {
      ids: { nodeId: text(row.id), userId: text(row.user_id) },
      reason:
        `Running ${text(row.cloud_provider) ?? 'unknown-provider'} node has had no active ` +
        `workspace for ${minutesSince(lastActivity, ctx.now) ?? '?'} min ` +
        `(warm since ${text(row.warm_since) ?? 'never'}); warm-node cleanup should have released it.`,
      observedAt: lastActivity,
    };
  });
}

async function staleHeartbeats(ctx: SweepContext): Promise<AnomalyClassResult> {
  const nowIso = new Date(ctx.now).toISOString();
  const rows = await ctx.env.DATABASE.prepare(
    `SELECT n.id, n.user_id, n.status, n.health_status, n.created_at, n.last_heartbeat_at,
            n.heartbeat_stale_after_seconds, n.node_role, n.runtime,
            COUNT(*) OVER () AS total
     FROM nodes n
     WHERE n.status = 'running'
       AND (julianday(?) - julianday(COALESCE(n.last_heartbeat_at, n.created_at))) * 86400.0
           > MAX(1, n.heartbeat_stale_after_seconds)
     ORDER BY julianday(COALESCE(n.last_heartbeat_at, n.created_at)) ASC, n.id ASC
     LIMIT ?`
  )
    .bind(nowIso, ctx.cap)
    .all<Row>();
  return result('stale_node_heartbeat', rows.results ?? [], (row) => {
    const lastHeartbeat = text(row.last_heartbeat_at);
    const health = deriveNodeHealth(
      {
        status: String(row.status),
        healthStatus: text(row.health_status) ?? 'stale',
        lastHeartbeatAt: lastHeartbeat,
        createdAt: String(row.created_at),
        heartbeatStaleAfterSeconds: int(row.heartbeat_stale_after_seconds),
      },
      ctx.now
    );
    return {
      ids: { nodeId: text(row.id), userId: text(row.user_id) },
      reason:
        `Running ${text(row.runtime) ?? 'vm'} ${text(row.node_role) ?? 'workspace'} node is ${health}: ` +
        `last heartbeat ${lastHeartbeat ?? 'never'} ` +
        `(${minutesSince(lastHeartbeat ?? text(row.created_at), ctx.now) ?? '?'} min ago, ` +
        `stale after ${int(row.heartbeat_stale_after_seconds)} s).`,
      observedAt: lastHeartbeat,
    };
  });
}

async function runningWorkspacesForTerminalTasks(ctx: SweepContext): Promise<AnomalyClassResult> {
  const rows = await ctx.env.DATABASE.prepare(
    `SELECT w.id AS workspace_id, w.node_id, w.user_id, w.status AS workspace_status,
            t.id AS task_id, t.status AS task_status,
            COALESCE(t.completed_at, t.updated_at) AS ended_at,
            COUNT(*) OVER () AS total
     FROM workspaces w
     JOIN tasks t ON t.workspace_id = w.id
     WHERE w.status IN (${ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL})
       AND t.status IN (${TERMINAL_TASK_STATUS_SQL})
       AND julianday(COALESCE(t.completed_at, t.updated_at)) < julianday(?)
       AND NOT EXISTS (
         SELECT 1 FROM tasks active
         WHERE active.workspace_id = w.id AND active.status IN (${ACTIVE_TASK_STATUS_SQL})
       )
     ORDER BY julianday(ended_at) ASC, w.id ASC
     LIMIT ?`
  )
    .bind(isoMinus(ctx.now, ctx.settings.terminalTaskGraceMs), ctx.cap)
    .all<Row>();
  return result('running_workspace_for_terminal_task', rows.results ?? [], (row) => {
    const endedAt = text(row.ended_at);
    return {
      ids: {
        workspaceId: text(row.workspace_id),
        taskId: text(row.task_id),
        nodeId: text(row.node_id),
        userId: text(row.user_id),
      },
      reason:
        `Workspace is ${text(row.workspace_status)} but its task ended as ${text(row.task_status)} ` +
        `${minutesSince(endedAt, ctx.now) ?? '?'} min ago and no other task is active on it.`,
      observedAt: endedAt,
    };
  });
}

/**
 * `tasks.updated_at` moves on task status and step writes, and `workspaces.last_activity_at`
 * on recorded workspace activity; neither is a heartbeat (`.claude/rules/53`).
 */
async function idleInProgressTasks(ctx: SweepContext): Promise<AnomalyClassResult> {
  const cutoff = isoMinus(ctx.now, ctx.settings.idleTaskMinutes * 60_000);
  const rows = await ctx.env.DATABASE.prepare(
    `SELECT t.id AS task_id, t.project_id, t.user_id, t.workspace_id, t.chat_session_id,
            t.execution_step, t.updated_at, w.last_activity_at, w.status AS workspace_status,
            COUNT(*) OVER () AS total
     FROM tasks t
     LEFT JOIN workspaces w ON w.id = t.workspace_id
     WHERE t.status = 'in_progress'
       AND julianday(t.updated_at) < julianday(?)
       AND (w.last_activity_at IS NULL OR julianday(w.last_activity_at) < julianday(?))
     ORDER BY julianday(COALESCE(w.last_activity_at, t.updated_at)) ASC, t.id ASC
     LIMIT ?`
  )
    .bind(cutoff, cutoff, ctx.cap)
    .all<Row>();
  return result('idle_in_progress_task', rows.results ?? [], (row) => {
    const lastSeen = text(row.last_activity_at) ?? text(row.updated_at);
    return {
      ids: {
        taskId: text(row.task_id),
        projectId: text(row.project_id),
        chatSessionId: text(row.chat_session_id),
        workspaceId: text(row.workspace_id),
        userId: text(row.user_id),
      },
      reason:
        `Task is in_progress (step ${text(row.execution_step) ?? 'unknown'}, workspace ` +
        `${text(row.workspace_status) ?? 'none'}) with no recorded activity for ` +
        `${minutesSince(lastSeen, ctx.now) ?? '?'} min.`,
      observedAt: lastSeen,
    };
  });
}

async function snapshotFailures(ctx: SweepContext): Promise<AnomalyClassResult> {
  const rows = await ctx.env.DATABASE.prepare(
    `SELECT s.id, s.project_id, s.chat_session_id, s.workspace_id, s.node_id, s.user_id,
            s.status, s.sleep_status, s.recovery_status, s.restore_status,
            s.sleep_attempts, s.recovery_attempts,
            (s.capture_error IS NOT NULL) AS has_capture_error,
            (s.sleep_error IS NOT NULL) AS has_sleep_error,
            (s.recovery_error IS NOT NULL) AS has_recovery_error,
            s.updated_at, COUNT(*) OVER () AS total
     FROM session_snapshots s
     WHERE julianday(s.updated_at) >= julianday(?)
       AND (s.sleep_status IN ('failed', 'terminal_failed')
            OR s.recovery_status = 'failed'
            OR s.restore_status = 'failed'
            OR s.status = 'failed'
            OR s.capture_error IS NOT NULL)
     ORDER BY julianday(s.updated_at) DESC, s.id ASC
     LIMIT ?`
  )
    .bind(isoMinus(ctx.now, ctx.settings.lookbackHours * 3_600_000), ctx.cap)
    .all<Row>();
  return result('session_snapshot_failure', rows.results ?? [], (row) => {
    const parts = [
      `status ${text(row.status)}`,
      `sleep ${text(row.sleep_status) ?? 'none'} (${int(row.sleep_attempts)} attempts)`,
      `recovery ${text(row.recovery_status) ?? 'none'} (${int(row.recovery_attempts)} attempts)`,
      `restore ${text(row.restore_status) ?? 'none'}`,
    ];
    const errors = [
      int(row.has_capture_error) ? 'capture_error' : null,
      int(row.has_sleep_error) ? 'sleep_error' : null,
      int(row.has_recovery_error) ? 'recovery_error' : null,
    ].filter(Boolean);
    return {
      ids: {
        snapshotId: text(row.id),
        chatSessionId: text(row.chat_session_id),
        projectId: text(row.project_id),
        workspaceId: text(row.workspace_id),
        nodeId: text(row.node_id),
        userId: text(row.user_id),
      },
      reason:
        `Session snapshot failed: ${parts.join(', ')}` +
        (errors.length ? `; recorded ${errors.join(', ')} (read with ops_get_session_story)` : '') +
        '.',
      observedAt: text(row.updated_at),
    };
  });
}

/**
 * Dead-lettered deletions live in NodeLifecycle DO storage; each one also writes a
 * `platform_errors` row (`node-lifecycle-workspace-deletion.ts deadLetterExact`), which is the
 * cheap SQL signal. Workspaces already deleted since are dropped from the report.
 */
async function deletionQuarantine(ctx: SweepContext): Promise<AnomalyClassResult> {
  // Reports for workspaces deleted since are dropped after reading, so read past the cap.
  const scanLimit = ctx.cap * QUARANTINE_SCAN_MULTIPLIER;
  const rows = await ctx.env.OBSERVABILITY_DATABASE.prepare(
    `SELECT workspace_id, MAX(node_id) AS node_id, MAX(user_id) AS user_id,
            MAX(timestamp) AS last_at, COUNT(*) AS reports, COUNT(*) OVER () AS total
     FROM platform_errors
     WHERE message = ? AND timestamp >= ? AND workspace_id IS NOT NULL
     GROUP BY workspace_id
     ORDER BY last_at DESC, workspace_id ASC
     LIMIT ?`
  )
    .bind(
      WORKSPACE_DELETION_QUARANTINE_MESSAGE,
      ctx.now - ctx.settings.lookbackHours * 3_600_000,
      scanLimit
    )
    .all<Row>();
  const reported = rows.results ?? [];
  const ids = reported.map((row) => text(row.workspace_id)).filter((id): id is string => !!id);
  const statuses = new Map<string, string>();
  // The scan may exceed D1's bound-parameter ceiling, so look statuses up in chunks.
  const lookups = await Promise.all(
    chunk(ids, D1_MAX_BOUND_PARAMETERS).map((part) =>
      ctx.env.DATABASE.prepare(
        `SELECT id, status FROM workspaces WHERE id IN (${part.map(() => '?').join(', ')})`
      )
        .bind(...part)
        .all<Row>()
    )
  );
  for (const current of lookups) {
    for (const row of current.results ?? []) statuses.set(String(row.id), String(row.status));
  }
  const open = reported.filter((row) => statuses.get(String(row.workspace_id)) !== 'deleted');
  const base = result('workspace_deletion_quarantine', open.slice(0, ctx.cap), (row) => {
    const lastAt = int(row.last_at);
    return {
      ids: {
        workspaceId: text(row.workspace_id),
        nodeId: text(row.node_id),
        userId: text(row.user_id),
      },
      reason:
        `Workspace deletion entered operator quarantine ${int(row.reports)} time(s); workspace is ` +
        `${statuses.get(String(row.workspace_id)) ?? 'missing'}.`,
      observedAt: lastAt ? new Date(lastAt).toISOString() : null,
    };
  });
  // Exact when the scan read every reported workspace; otherwise unread ones count as open.
  const reportedTotal = reported.length > 0 ? int(reported[0]?.total) : 0;
  const scannedAll = reported.length >= reportedTotal;
  const total = reportedTotal - (reported.length - open.length);
  return {
    ...base,
    total,
    truncated: total > base.returned,
    ...(scannedAll ? {} : { totalIsUpperBound: true }),
  };
}

async function pendingIncidents(ctx: SweepContext): Promise<AnomalyClassResult> {
  const rows = await ctx.env.DATABASE.prepare(
    `SELECT signature, source, severity, occurrence_count, last_seen_at,
            COUNT(*) OVER () AS total
     FROM platform_feedback_triages
     WHERE queue_state = 'pending'
     ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END ASC,
       last_seen_at DESC, signature ASC
     LIMIT ?`
  )
    .bind(ctx.cap)
    .all<Row>();
  return result('pending_incident', rows.results ?? [], (row) => {
    const lastSeen = int(row.last_seen_at);
    return {
      // Signatures derive from reported error text; strip control characters and markers.
      ids: { signature: neutralizeUntrustedText(text(row.signature) ?? '') || null },
      reason:
        `Pending ${text(row.severity) ?? 'unknown'} incident from ${text(row.source) ?? 'unknown'} ` +
        `seen ${int(row.occurrence_count)} time(s) (read with get_incident).`,
      observedAt: lastSeen ? new Date(lastSeen).toISOString() : null,
    };
  });
}

const SWEEPS: Record<AnomalyClass, (ctx: SweepContext) => Promise<AnomalyClassResult>> = {
  empty_node_past_warm_grace: emptyNodes,
  stale_node_heartbeat: staleHeartbeats,
  running_workspace_for_terminal_task: runningWorkspacesForTerminalTasks,
  idle_in_progress_task: idleInProgressTasks,
  session_snapshot_failure: snapshotFailures,
  workspace_deletion_quarantine: deletionQuarantine,
  pending_incident: pendingIncidents,
};

export async function findAnomalies(
  env: Env,
  settings: FleetOpsSettings,
  options: { now?: number; classes?: readonly AnomalyClass[] } = {}
): Promise<AnomalyReport> {
  const now = options.now ?? Date.now();
  const cleanup = resolveCleanupConfig(env);
  const ctx: SweepContext = {
    env,
    now,
    cap: settings.anomalyMaxPerClass,
    emptyNodeIdleMs: cleanup.gracePeriodMs + settings.emptyNodeGraceMs,
    settings,
  };
  const selected = options.classes?.length ? options.classes : ANOMALY_CLASSES;
  const settled = await Promise.allSettled(selected.map((cls) => SWEEPS[cls](ctx)));
  const classes = settled.map((outcome, index): AnomalyClassResult => {
    const cls = selected[index] as AnomalyClass;
    if (outcome.status === 'fulfilled') return outcome.value;
    const error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    log.error('fleet_ops.anomaly_class_failed', { anomalyClass: cls, error });
    return { class: cls, total: 0, returned: 0, truncated: false, findings: [], error };
  });
  return {
    generatedAt: new Date(now).toISOString(),
    thresholds: {
      emptyNodeIdleMs: ctx.emptyNodeIdleMs,
      terminalTaskGraceMs: settings.terminalTaskGraceMs,
      idleTaskMinutes: settings.idleTaskMinutes,
      lookbackHours: settings.lookbackHours,
      maxPerClass: ctx.cap,
    },
    classes,
  };
}
