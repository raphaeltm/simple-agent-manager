import { readProjectDataEventLogCleanupRecheckAt } from './event-log-cleanup';
import { readProjectDataGroupedFtsCleanupRecheckAt } from './grouped-fts-cleanup';
import { resolveStorageSafetyConfig } from './storage-safety';
import {
  META_LAST_MEASURED_AT,
  readStorageSafetyMeta as readMeta,
  readStorageSafetyMetaNumber as readMetaNumber,
} from './storage-safety-meta';
import {
  readProjectDataToolPayloadArchiveLastRunAt,
  readProjectDataToolPayloadCleanupRecheckAt,
} from './tool-payload-cleanup';
import { isProjectInToolPayloadCleanupScope } from './tool-payload-cleanup-config-refusal';
import type { Env } from './types';

/**
 * Minimum spacing between storage-safety alarms, applied to every cleanup-derived time.
 *
 * Deliberately NOT env-configurable. This is a safety invariant, not a cadence: its only job is
 * to stop the schedule from re-arming at or before `now`, which is what produced the 2026-09-14
 * hot alarm loop. Exposing it as a knob would let an operator set it to 0 and reintroduce the
 * incident. Real cleanup cadences (recheck 24h, archive interval 24h, measure 1h) are all orders
 * of magnitude larger, so this never governs when work actually happens — it only bounds the
 * worst case to one wasted alarm per minute instead of several per second.
 */
export const STORAGE_SAFETY_MIN_ALARM_SPACING_MS = 60_000;

export function computeStorageSafetyAlarmTime(
  sql: SqlStorage,
  env: Env,
  now: number = Date.now()
): number | null {
  const config = resolveStorageSafetyConfig(env);
  if (!config.enabled) return null;
  if (!readMeta(sql, 'projectId')) return null;
  const lastMeasuredAt = readMetaNumber(sql, META_LAST_MEASURED_AT);
  const measureAt = lastMeasuredAt === null ? now : lastMeasuredAt + config.measureIntervalMs;
  // Scope, not just the global flag. `runProjectDataToolPayloadCleanup` refuses any project
  // outside PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PROJECT_IDS one call later, so scheduling a
  // cleanup alarm for one is scheduling work that cannot happen. On 2026-09-14 that put every
  // ProjectData object in the installation into a hot alarm loop: ~20 objects the allowlist
  // excluded each ran 200-380x their normal read volume. Sharing one predicate with the
  // executor is what stops the two drifting apart again.
  const cleanupInScope =
    config.toolPayloadCleanupEnabled &&
    isProjectInToolPayloadCleanupScope(
      readMeta(sql, 'projectId') ?? '',
      config.toolPayloadCleanupProjectIds,
      false
    );
  // Every cleanup-derived time below is a timestamp that only a pass which RUNS TO COMPLETION
  // advances. `createToolPayloadCleanupPlan` has eight distinct `return null` refusal paths, and
  // `writeProjectDataToolPayloadArchiveLastRunAt` sits behind `!shouldContinue` deep in the
  // success path, reachable from none of them. So a cleanup timestamp that falls into the past
  // STAYS there, `Math.min` keeps returning it, and the object re-arms on every tick.
  //
  // Measured in production 2026-09-14: ~5.6 alarm firings per second per object, a ~50x
  // invocation increase with per-invocation cost unchanged, across ~21 objects. There is no
  // platform backoff bounding this — the loop runs through a SUCCESSFUL `alarm()` whose
  // `finally { recalculateAlarm() }` re-arms with a time still <= now, so Cloudflare's
  // throw/retry mechanism is never involved and nothing throttles it but round-trip latency.
  //
  // Clamping here is deliberately structural rather than per-refusal: enumerating which refusals
  // can leave which marker stale is exactly the reasoning that produced the incident. Whatever
  // the executor decides, the schedule must move forward.
  const notBefore = (at: number | null): number | null =>
    at === null ? null : Math.max(at, now + STORAGE_SAFETY_MIN_ALARM_SPACING_MS);

  const cleanupRecheckAt = cleanupInScope
    ? notBefore(readProjectDataToolPayloadCleanupRecheckAt(sql))
    : null;
  const archiveLastRunAt = cleanupInScope ? readProjectDataToolPayloadArchiveLastRunAt(sql) : null;
  let archiveRunAt: number | null = null;
  if (cleanupInScope) {
    // `null` here means "never run", which the original code turned into `now` — a condition a
    // refused pass cannot clear. `notBefore` covers both that case and the subtler one the
    // scope gate does not: a project that DID complete an archive pass once, then regressed into
    // a refusal, whose `archiveLastRunAt + interval` is a fixed point that real time walks past.
    // Two different jobs here, and both are needed.
    //   - The `null` branch is SEMANTIC: "never run" means due one interval from now, not now.
    //     Letting the generic clamp handle it would schedule every never-run in-scope object a
    //     minute out, which is no longer a spin but is still ~60 wasted alarms an hour each.
    //   - `notBefore` is the SAFETY NET for the non-null branch: a project that completed a pass
    //     and then regressed into a refusal has a fixed `archiveLastRunAt + interval` that real
    //     time simply walks past, and nothing will ever advance it.
    archiveRunAt = notBefore(
      archiveLastRunAt === null
        ? now + config.toolPayloadArchiveIntervalMs
        : archiveLastRunAt + config.toolPayloadArchiveIntervalMs
    );
  }
  // Same clamp for the sibling cleaners. Neither has a project-scope allowlist today, so neither
  // can reproduce the scheduler/executor scope divergence above — but both are gated flags slated
  // to be enabled, and both read a marker only their own successful pass advances. If a scope
  // allowlist is ever added to either, `cleanupInScope`'s treatment must be extended to it in the
  // same change (.claude/rules/74-proxy-signals-must-match-the-condition.md).
  const groupedFtsCleanupRecheckAt = config.groupedFtsCleanupEnabled
    ? notBefore(readProjectDataGroupedFtsCleanupRecheckAt(sql))
    : null;
  const eventLogCleanupRecheckAt = config.eventLogCleanupEnabled
    ? notBefore(readProjectDataEventLogCleanupRecheckAt(sql))
    : null;
  return Math.min(
    measureAt,
    ...[
      cleanupRecheckAt,
      archiveRunAt,
      groupedFtsCleanupRecheckAt,
      eventLogCleanupRecheckAt,
    ].filter((value): value is number => value !== null)
  );
}
