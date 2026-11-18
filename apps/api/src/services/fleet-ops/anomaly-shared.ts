/**
 * Types and helpers shared by the `ops_find_anomalies` classes (`./anomalies.ts`,
 * `./anomalies-sessions.ts`).
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import type { FleetOpsSettings } from './settings';

export const ANOMALY_CLASSES = [
  'empty_node_past_warm_grace',
  'stale_node_heartbeat',
  'node_destroying_too_long',
  'running_workspace_for_terminal_task',
  'idle_in_progress_task',
  'session_snapshot_failure',
  'session_wake_stalled',
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

export type Row = Record<string, unknown>;


export function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function int(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function minutesSince(iso: string | null, now: number): number | null {
  const at = iso ? Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`) : NaN;
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 60_000)) : null;
}

export function isoMinus(now: number, ms: number): string {
  return new Date(now - ms).toISOString();
}

/** Every class query selects `COUNT(*) OVER () AS total` so the cap is disclosed in one read. */
export function result(
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

export interface SweepContext {
  readonly env: Env;
  readonly now: number;
  readonly cap: number;
  readonly emptyNodeIdleMs: number;
  readonly settings: FleetOpsSettings;
}
