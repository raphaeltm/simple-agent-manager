/**
 * Durable state of the storage alarm's grouped/FTS cleanup (`grouped-fts-cleanup.ts`), kept in
 * `do_meta`: the run-in-progress marker, the recheck time, why it last paused, and the
 * sessions it must leave alone for a while.
 *
 * Every write here is best-effort. Near the per-object cap a `do_meta` write can fail with the
 * storage-full error, and losing a marker only costs a recheck or one retried session, while a
 * throw would discard the result of pages that already freed space.
 */
import { isJsonRecord } from '@simple-agent-manager/shared';

import { createModuleLogger, serializeError } from '../../lib/logger';
import {
  readStorageSafetyMeta,
  readStorageSafetyMetaNumber,
  truncateStorageSafetyMetaValue,
  writeStorageSafetyMeta,
} from './storage-safety-meta';
import type { Env } from './types';

const log = createModuleLogger('project_data.grouped_fts_cleanup');

export const META_GROUPED_FTS_CLEANUP_CURSOR_SESSION_ID =
  'storageSafetyGroupedFtsCleanupCursorSessionId';
const META_GROUPED_FTS_CLEANUP_RECHECK_AT = 'storageSafetyGroupedFtsCleanupRecheckAt';
const META_GROUPED_FTS_CLEANUP_DISABLED_REASON = 'storageSafetyGroupedFtsCleanupDisabledReason';
const META_GROUPED_FTS_CLEANUP_EXCLUSIONS = 'storageSafetyGroupedFtsCleanupExclusions';

/** Off by default: near the cap the alarm reports `wall_unsafe`, as before this mode existed. */
export const DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_NEAR_WALL_ENABLED = false;
/** How long a session whose page failed or grew the database is left alone. */
export const DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_EXCLUSION_MS = 24 * 60 * 60 * 1000;
/** Excluded sessions remembered at once; the oldest exclusion is dropped first. */
export const DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_MAX_EXCLUSIONS = 50;

export interface GroupedFtsCleanupModeConfig {
  nearWallEnabled: boolean;
  exclusionMs: number;
  maxExclusions: number;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveGroupedFtsCleanupModeConfig(env: Env): GroupedFtsCleanupModeConfig {
  const flag = (env.PROJECT_DATA_GROUPED_FTS_CLEANUP_NEAR_WALL_ENABLED ?? '').trim().toLowerCase();
  return {
    nearWallEnabled:
      flag === '' ? DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_NEAR_WALL_ENABLED : flag === 'true',
    exclusionMs: positiveInteger(
      env.PROJECT_DATA_GROUPED_FTS_CLEANUP_EXCLUSION_MS,
      DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_EXCLUSION_MS
    ),
    maxExclusions: positiveInteger(
      env.PROJECT_DATA_GROUPED_FTS_CLEANUP_MAX_EXCLUSIONS,
      DEFAULT_PROJECT_DATA_GROUPED_FTS_CLEANUP_MAX_EXCLUSIONS
    ),
  };
}

function bestEffort(key: string, write: () => void): void {
  try {
    write();
  } catch (error) {
    log.warn('state_write_failed', { key, ...serializeError(error) });
  }
}

export function readGroupedFtsCleanupRecheckAt(sql: SqlStorage): number | null {
  return readStorageSafetyMetaNumber(sql, META_GROUPED_FTS_CLEANUP_RECHECK_AT);
}

export function readGroupedFtsCleanupInProgressSessionId(sql: SqlStorage): string | null {
  return readStorageSafetyMeta(sql, META_GROUPED_FTS_CLEANUP_CURSOR_SESSION_ID);
}

/** Ends a run: no in-progress marker, no recheck, no pause reason. Exclusions stay. */
export function clearGroupedFtsCleanupRun(sql: SqlStorage): void {
  bestEffort('run', () =>
    sql.exec(
      `DELETE FROM do_meta WHERE key IN (?, ?, ?)`,
      META_GROUPED_FTS_CLEANUP_CURSOR_SESSION_ID,
      META_GROUPED_FTS_CLEANUP_RECHECK_AT,
      META_GROUPED_FTS_CLEANUP_DISABLED_REASON
    )
  );
}

/** Keeps a run going: it resumes at `recheckAt` even below the trigger ratio. */
export function writeGroupedFtsCleanupRun(
  sql: SqlStorage,
  input: { lastSessionId: string | null; recheckAt: number; pausedReason?: string | null }
): void {
  clearGroupedFtsCleanupRun(sql);
  bestEffort('run', () => {
    writeStorageSafetyMeta(
      sql,
      META_GROUPED_FTS_CLEANUP_CURSOR_SESSION_ID,
      input.lastSessionId ?? 'started'
    );
    writeStorageSafetyMeta(sql, META_GROUPED_FTS_CLEANUP_RECHECK_AT, String(input.recheckAt));
    if (input.pausedReason) {
      writeStorageSafetyMeta(
        sql,
        META_GROUPED_FTS_CLEANUP_DISABLED_REASON,
        truncateStorageSafetyMetaValue(input.pausedReason, 500)
      );
    }
  });
}

/** Session id -> time until which the alarm leaves it alone; expired entries are dropped. */
export function readGroupedFtsCleanupExclusions(sql: SqlStorage, now: number): Map<string, number> {
  const exclusions = new Map<string, number>();
  const raw = readStorageSafetyMeta(sql, META_GROUPED_FTS_CLEANUP_EXCLUSIONS);
  if (!raw) return exclusions;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return exclusions;
  }
  if (!isJsonRecord(parsed)) return exclusions;
  for (const [sessionId, until] of Object.entries(parsed)) {
    if (typeof until === 'number' && until > now) exclusions.set(sessionId, until);
  }
  return exclusions;
}

/** Adds sessions to the exclusion list, keeping only the newest `maxExclusions`. */
export function excludeGroupedFtsCleanupSessions(
  sql: SqlStorage,
  existing: Map<string, number>,
  sessionIds: string[],
  until: number,
  maxExclusions: number
): void {
  if (sessionIds.length === 0) return;
  const next = new Map(existing);
  for (const sessionId of sessionIds) next.set(sessionId, until);
  const kept = [...next.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, maxExclusions);
  bestEffort('exclusions', () =>
    writeStorageSafetyMeta(
      sql,
      META_GROUPED_FTS_CLEANUP_EXCLUSIONS,
      JSON.stringify(Object.fromEntries(kept))
    )
  );
}
