/**
 * Which ProjectData storage conditions the superadmin alert step considers on one tick.
 *
 * Each condition query first reads the most severe rows, bounded by `scanLimit` (open breakers
 * and freezes whose own project is near the wall before routine freezes; larger objects first).
 * When a query has more qualifying rows than that, a fixed severity prefix would never reach the
 * rest, so the tick also reads a rotating window: the next `scanLimit` rows by project id after a
 * cursor kept in KV, wrapping to the start once it runs out. Every qualifying condition is
 * therefore considered within a bounded number of ticks, while the most severe ones are
 * considered on every tick (rule 65: rank by purpose, disclose what was dropped). Nothing extra
 * is read while every qualifying row fits in one window.
 */
import { isJsonRecord } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';

export interface BreakerRow {
  project_id: string;
  project_name: string | null;
  state: 'open' | 'frozen';
  reason: string | null;
  opened_at: number | null;
  updated_at: number;
  /** The project's own last exported size, joined so escalation ranks before the LIMIT. */
  database_size_bytes: number | null;
}

export interface TelemetryRow {
  project_id: string;
  project_name: string | null;
  database_size_bytes: number;
  measured_at: number;
  cleanup_health: string | null;
}

interface ScanCursor {
  breakers: string;
  telemetry: string;
}

const BREAKER_SELECT = `SELECT b.project_id, p.name AS project_name, b.state, b.reason, b.opened_at,
         b.updated_at, t.database_size_bytes
       FROM project_data_archive_circuit_breakers b
       LEFT JOIN projects p ON p.id = b.project_id
       LEFT JOIN project_data_storage_telemetry t ON t.project_id = b.project_id
       WHERE b.state IN ('open', 'frozen')`;

/** Binds the wall threshold. */
const TELEMETRY_SELECT = `SELECT t.project_id, p.name AS project_name, t.database_size_bytes,
         t.measured_at, t.cleanup_health
       FROM project_data_storage_telemetry t
       LEFT JOIN projects p ON p.id = t.project_id
       WHERE (t.database_size_bytes >= ? OR t.cleanup_health = 'target_unreachable')`;

function cursorKey(kvPrefix: string): string {
  // Outside the `${kvPrefix}:` namespace, so the throttle snapshot never lists it.
  return `${kvPrefix}-scan-cursor`;
}

async function readCursor(env: Env, kvPrefix: string): Promise<ScanCursor> {
  try {
    const raw = await env.KV.get(cursorKey(kvPrefix));
    const parsed: unknown = raw ? (JSON.parse(raw) as unknown) : null;
    const record = isJsonRecord(parsed) ? parsed : {};
    return {
      breakers: typeof record.breakers === 'string' ? record.breakers : '',
      telemetry: typeof record.telemetry === 'string' ? record.telemetry : '',
    };
  } catch (error) {
    // Restarting the rotation from the first project costs one window, never a condition.
    log.warn('project_data_storage_alerts.scan_cursor_read_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { breakers: '', telemetry: '' };
  }
}

/** The cursor after a window: its last row, or the start again once the window came up short. */
function nextCursor(rows: Array<{ project_id: string }>, limit: number): string {
  return rows.length < limit ? '' : (rows[rows.length - 1]?.project_id ?? '');
}

function mergeByProject<T extends { project_id: string }>(first: T[], second: T[]): T[] {
  const seen = new Set(first.map((row) => row.project_id));
  return [...first, ...second.filter((row) => !seen.has(row.project_id))];
}

export async function scanStorageAlertConditions(
  env: Env,
  input: { scanLimit: number; kvPrefix: string; wallBytes: number }
): Promise<{ breakers: BreakerRow[]; telemetry: TelemetryRow[]; scanTruncated: boolean }> {
  const { scanLimit, wallBytes } = input;
  // One extra row per query tells the tick that more qualifying rows exist.
  const [severeBreakers, severeTelemetry] = await Promise.all([
    env.DATABASE.prepare(
      `${BREAKER_SELECT}
       ORDER BY CASE
           WHEN b.state = 'open' THEN 0
           WHEN COALESCE(t.database_size_bytes, 0) >= ? THEN 1
           ELSE 2
         END,
         COALESCE(b.opened_at, b.updated_at) ASC,
         b.project_id ASC
       LIMIT ?`
    )
      .bind(wallBytes, scanLimit + 1)
      .all<BreakerRow>(),
    env.DATABASE.prepare(
      `${TELEMETRY_SELECT}
       ORDER BY t.database_size_bytes DESC, t.project_id ASC
       LIMIT ?`
    )
      .bind(wallBytes, scanLimit + 1)
      .all<TelemetryRow>(),
  ]);
  const breakerRows = severeBreakers.results ?? [];
  const telemetryRows = severeTelemetry.results ?? [];
  const breakersTruncated = breakerRows.length > scanLimit;
  const telemetryTruncated = telemetryRows.length > scanLimit;
  let breakers = breakerRows.slice(0, scanLimit);
  let telemetry = telemetryRows.slice(0, scanLimit);
  if (!breakersTruncated && !telemetryTruncated) {
    return { breakers, telemetry, scanTruncated: false };
  }

  const cursor = await readCursor(env, input.kvPrefix);
  const [rotatingBreakers, rotatingTelemetry] = await Promise.all([
    breakersTruncated
      ? env.DATABASE.prepare(
          `${BREAKER_SELECT}
             AND b.project_id > ?
           ORDER BY b.project_id ASC
           LIMIT ?`
        )
          .bind(cursor.breakers, scanLimit)
          .all<BreakerRow>()
          .then((result) => result.results ?? [])
      : Promise.resolve([] as BreakerRow[]),
    telemetryTruncated
      ? env.DATABASE.prepare(
          `${TELEMETRY_SELECT}
             AND t.project_id > ?
           ORDER BY t.project_id ASC
           LIMIT ?`
        )
          .bind(wallBytes, cursor.telemetry, scanLimit)
          .all<TelemetryRow>()
          .then((result) => result.results ?? [])
      : Promise.resolve([] as TelemetryRow[]),
  ]);
  breakers = mergeByProject(breakers, rotatingBreakers);
  telemetry = mergeByProject(telemetry, rotatingTelemetry);
  const next: ScanCursor = {
    breakers: breakersTruncated ? nextCursor(rotatingBreakers, scanLimit) : '',
    telemetry: telemetryTruncated ? nextCursor(rotatingTelemetry, scanLimit) : '',
  };
  await env.KV.put(cursorKey(input.kvPrefix), JSON.stringify(next)).catch((error: unknown) => {
    log.warn('project_data_storage_alerts.scan_cursor_write_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return { breakers, telemetry, scanTruncated: true };
}
