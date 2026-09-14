/**
 * `computeStorageSafetyAlarmTime` must never schedule an alarm the firing pass cannot clear.
 *
 * ## The incident these cases exist to prevent
 *
 * Enabling `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED` in production on 2026-09-14 put every
 * ProjectData Durable Object into a hot alarm loop. Measured over 40 minutes on namespace
 * fb36fe21: invocations went from ~600-950 per 5 minutes to 33,000-37,000 — a ~50x increase —
 * while per-invocation cost stayed flat (~770 rows read vs ~890 at baseline). The read volume
 * everyone noticed (23-30M rows per 5 minutes) was a symptom; the disease was alarms firing
 * roughly 5.6 times per second per object. ~21 objects were affected, and ~20 of those were
 * excluded by the single-project allowlist, each running 200-380x its normal read volume.
 *
 * Two independent defects produced it, and either one alone still loops:
 *
 * 1. `archiveLastRunAt === null ? now` treated "never run" as "overdue now", and the only writer
 *    of that value (`writeProjectDataToolPayloadArchiveLastRunAt`, called from one place in
 *    `tool-payload-cleanup.ts`, in the success path, only when a pass both built a plan AND
 *    finished it) is unreachable from every refusal path. So the condition could never clear and
 *    the object rescheduled immediately, forever.
 * 2. The scheduler consulted the global `toolPayloadCleanupEnabled` flag but never
 *    `toolPayloadCleanupProjectIds`, so it scheduled work `runProjectDataToolPayloadCleanup`
 *    refuses one call later, on every object in the installation.
 *
 * There was no test on this function at all, which is why it survived from the original feature
 * commit `702a86e94` through the 2026-09-03 "fix" (`684f99d60`) — that commit relaxed
 * `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS`, which is not what drives the loop, and never
 * touched the scheduler.
 *
 * @see .claude/rules/74-proxy-signals-must-match-the-condition.md — a gate keyed on a signal
 *      (feature enabled globally) strictly broader than its condition (this object has work due).
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeStorageSafetyAlarmTime } from '../../../src/durable-objects/project-data/storage-safety';
import { writeStorageSafetyMeta } from '../../../src/durable-objects/project-data/storage-safety-meta';
import { writeProjectDataToolPayloadArchiveLastRunAt } from '../../../src/durable-objects/project-data/tool-payload-cleanup-state';
import type { Env } from '../../../src/env';
import { createSqlStorage } from './sql-storage-test-utils';

const NOW = Date.UTC(2026, 8, 14, 16, 20, 0);
const IN_SCOPE = '01KHRJGANBBWGDY1NZ0KVF0D4J';
const OUT_OF_SCOPE = '01KJNR9R3TEN3KX1ETE33852R8';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * The production Environment as it stood when the loop was observed: cleanup enabled, the
 * approved-manifest plan fully wired, and exactly one project in the allowlist.
 */
function productionEnv(overrides: Partial<Env> = {}): Env {
  return {
    PROJECT_DATA_STORAGE_TELEMETRY_ENABLED: 'true',
    PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS: String(HOUR),
    PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'true',
    PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PROJECT_IDS: IN_SCOPE,
    PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS: String(DAY),
    ...overrides,
  } as unknown as Env;
}

describe('computeStorageSafetyAlarmTime', () => {
  let db: Database.Database;
  let sql: SqlStorage;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE do_meta (key TEXT PRIMARY KEY, value TEXT)');
    sql = createSqlStorage(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedProject(projectId: string, lastMeasuredAt: number | null): void {
    writeStorageSafetyMeta(sql, 'projectId', projectId);
    if (lastMeasuredAt !== null) {
      writeStorageSafetyMeta(sql, 'storageSafetyLastMeasuredAt', String(lastMeasuredAt));
    }
  }

  it('never schedules an alarm at or before now for a project that has never run cleanup', () => {
    // The loop, reduced to one assertion. A pass that refuses does not write
    // `archiveLastRunAt`, so if this returns `now` the object re-arms immediately and spins.
    // The measurement is fresh, so nothing else is due either — the only candidate time here is
    // the archive run.
    seedProject(IN_SCOPE, NOW);

    const at = computeStorageSafetyAlarmTime(sql, productionEnv(), NOW);

    expect(at).not.toBeNull();
    expect(at).toBeGreaterThan(NOW);
  });

  it('still gives a never-run project a prompt first pass, bounded by the measure interval', () => {
    // Liveness beside the absence assertion (.claude/rules/62). Flooring the never-run case must
    // not push the first archive pass a whole day out: the return is a Math.min against
    // `measureAt`, and that alarm itself drives a cleanup attempt through `allowStart`. Here the
    // last measurement is already an hour old, so the object is due immediately for measurement
    // and the first cleanup attempt rides along with it.
    seedProject(IN_SCOPE, NOW - HOUR);

    const at = computeStorageSafetyAlarmTime(sql, productionEnv(), NOW);

    expect(at).toBe(NOW);
    // ...and that is the measurement's doing, not the archive's: one interval, not zero.
    expect(at).toBeLessThan(NOW + DAY);
  });

  it('ignores a stale cleanup recheck marker left on a project the allowlist excludes', () => {
    // ~20 of the 21 objects that spun were out of scope. A first draft of this case seeded only
    // `projectId` and asserted `NOW + HOUR`, which passes with OR without the scope gate — the
    // floor alone already pushes `archiveRunAt` past the measurement. Deleting the guard reddened
    // nothing, so the case proved nothing (.claude/rules/62).
    //
    // The state that makes the gate load-bearing is a leftover recheck marker. Those exist in
    // production on every project that ran cleanup before the allowlist was introduced: the
    // scheduler reads that marker whenever the global flag is on, and an out-of-scope project is
    // then dragged to an early alarm to do work the executor refuses one call later.
    seedProject(OUT_OF_SCOPE, NOW);
    writeStorageSafetyMeta(sql, 'storageSafetyToolCleanupRecheckAt', String(NOW + 60_000));

    const at = computeStorageSafetyAlarmTime(sql, productionEnv(), NOW);

    // The only thing due for an out-of-scope project is its next measurement. If the marker were
    // honoured this would be NOW + 60_000.
    expect(at).toBe(NOW + HOUR);
  });

  it('still honours a recheck marker for the project the allowlist includes', () => {
    // Owner-path control for the case above: the gate must narrow by scope, not disable the
    // recheck mechanism outright.
    seedProject(IN_SCOPE, NOW);
    writeStorageSafetyMeta(sql, 'storageSafetyToolCleanupRecheckAt', String(NOW + 60_000));

    const at = computeStorageSafetyAlarmTime(sql, productionEnv(), NOW);

    expect(at).toBe(NOW + 60_000);
  });

  it('honours a recorded archive run instead of re-arming immediately', () => {
    // Control for the first case: once a pass genuinely completes and records itself, the
    // scheduler must use that timestamp. If this returned `now` the fix would be "never schedule
    // archiving at all", which would be a different bug.
    //
    // The measure interval is widened here so the archive term is the one `Math.min` returns.
    // With the production 1h interval the measurement legitimately wins and this case would
    // assert nothing about archiving at all — which is how a first draft of this test passed
    // while looking at the wrong number.
    seedProject(IN_SCOPE, NOW);
    writeProjectDataToolPayloadArchiveLastRunAt(sql, NOW - 2 * HOUR);

    const at = computeStorageSafetyAlarmTime(
      sql,
      productionEnv({ PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS: String(30 * DAY) } as Partial<Env>),
      NOW
    );

    expect(at).toBe(NOW - 2 * HOUR + DAY);
  });

  it('schedules nothing when the feature is off, for in-scope and out-of-scope alike', () => {
    // The pre-incident state, which was quiet. Proves the loop is attributable to the flag and
    // that disabling it is a real rollback rather than a coincidence.
    for (const projectId of [IN_SCOPE, OUT_OF_SCOPE]) {
      db.exec('DELETE FROM do_meta');
      seedProject(projectId, NOW);
      const at = computeStorageSafetyAlarmTime(
        sql,
        productionEnv({ PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED: 'false' } as Partial<Env>),
        NOW
      );
      expect(at).toBe(NOW + HOUR);
    }
  });

  it('treats an empty allowlist as every project, and still does not spin', () => {
    // An operator who clears PROJECT_IDS means "all projects", which is a legitimate
    // configuration. It must widen scope WITHOUT reintroducing the zero-length backoff.
    seedProject(OUT_OF_SCOPE, NOW);

    const at = computeStorageSafetyAlarmTime(
      sql,
      productionEnv({ PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PROJECT_IDS: '' } as Partial<Env>),
      NOW
    );

    expect(at).toBeGreaterThan(NOW);
  });
});
