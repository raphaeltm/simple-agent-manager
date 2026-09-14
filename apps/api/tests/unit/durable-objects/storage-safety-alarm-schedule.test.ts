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

import {
  computeStorageSafetyAlarmTime,
  STORAGE_SAFETY_MIN_ALARM_SPACING_MS,
} from '../../../src/durable-objects/project-data/storage-safety-alarm-time';
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
    writeStorageSafetyMeta(sql, 'storageSafetyToolCleanupRecheckAt', String(NOW + 30 * 60_000));

    const at = computeStorageSafetyAlarmTime(sql, productionEnv(), NOW);

    // The only thing due for an out-of-scope project is its next measurement. If the marker were
    // honoured this would be NOW + 30 minutes.
    expect(at).toBe(NOW + HOUR);
  });

  it('still honours a recheck marker for the project the allowlist includes', () => {
    // Owner-path control for the case above: the gate must narrow by scope, not disable the
    // recheck mechanism outright.
    seedProject(IN_SCOPE, NOW);
    // Half an hour, comfortably past STORAGE_SAFETY_MIN_ALARM_SPACING_MS and comfortably inside
    // the 1h measure interval, so this value is the one Math.min returns and the assertion can
    // only pass if the term participated.
    writeStorageSafetyMeta(sql, 'storageSafetyToolCleanupRecheckAt', String(NOW + 30 * 60_000));

    const at = computeStorageSafetyAlarmTime(sql, productionEnv(), NOW);

    expect(at).toBe(NOW + 30 * 60_000);
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

  it('does not spin on a stale recheck marker left by a pass that can no longer complete', () => {
    // THE CRITICAL CASE, and the one the first cut of this fix missed. Found by review, not by me.
    //
    // `createToolPayloadCleanupPlan` has eight distinct `return null` refusal paths and
    // `writeProjectDataToolPayloadArchiveLastRunAt` is reachable from none of them. So the scope
    // gate alone closes only one door: a project that is IN scope, was mid-continuation (a normal
    // outcome — batches cap at 500 rows / 20s), and then regressed into a config refusal leaves a
    // recheck marker nothing will ever advance. Once real time walks past it, an unclamped
    // scheduler returns it on every call and the object re-arms forever — the identical mechanism
    // as the incident, reached through a different meta key.
    //
    // This is exactly the production config of 2026-09-14: a fixed cutoff armed with a blank
    // manifest.
    seedProject(IN_SCOPE, NOW);
    writeStorageSafetyMeta(sql, 'storageSafetyToolCleanupRecheckAt', String(NOW - 6 * HOUR));

    const at = computeStorageSafetyAlarmTime(
      sql,
      productionEnv({
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_CUTOFF_CREATED_AT: String(NOW - 30 * DAY),
      } as Partial<Env>),
      NOW
    );

    expect(at).toBeGreaterThan(NOW);
  });

  it('does not spin on a completed archive whose next run has already fallen into the past', () => {
    // The second symptom the scope gate does not cover. A project that DID complete an archive
    // pass has a non-null `archiveLastRunAt`; if it later refuses, `archiveLastRunAt + interval`
    // is a fixed point that real time simply walks past. Flooring only the null branch would
    // leave this one spinning.
    seedProject(IN_SCOPE, NOW);
    writeProjectDataToolPayloadArchiveLastRunAt(sql, NOW - 10 * DAY);

    const at = computeStorageSafetyAlarmTime(sql, productionEnv(), NOW);

    expect(at).toBeGreaterThan(NOW);
  });

  it('does not spin on a stale grouped-FTS or event-log recheck marker either', () => {
    // Both flags are gated today but slated to be enabled, and both read a marker only their own
    // successful pass advances. Before this, two of the five Math.min terms had no coverage at
    // all — so a regression reintroducing the loop through either would have shipped green.
    for (const [flag, metaKey] of [
      ['PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED', 'storageSafetyGroupedFtsCleanupRecheckAt'],
      ['PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED', 'storageSafetyEventLogCleanupRecheckAt'],
    ] as const) {
      db.exec('DELETE FROM do_meta');
      seedProject(IN_SCOPE, NOW);
      writeStorageSafetyMeta(sql, metaKey, String(NOW - 6 * HOUR));

      const at = computeStorageSafetyAlarmTime(
        sql,
        productionEnv({ [flag]: 'true' } as unknown as Partial<Env>),
        NOW
      );

      expect(at, `${flag} must not schedule at or before now`).toBeGreaterThan(NOW);
    }
  });

  it('pins the magnitude of the never-run floor, not just its sign', () => {
    // Case 1 asserts only `> NOW`, which a one-millisecond floor would satisfy. Widening the
    // measure interval makes the archive term the one Math.min returns, so the floor's actual
    // value is observable rather than masked by measureAt.
    //
    // It must be a full archive interval, NOT the generic minimum spacing: scheduling every
    // never-run in-scope object a minute out is no longer a spin but is still ~60 wasted alarms
    // an hour each, which is what an earlier draft of this fix did.
    seedProject(IN_SCOPE, NOW);

    const at = computeStorageSafetyAlarmTime(
      sql,
      productionEnv({ PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS: String(30 * DAY) } as Partial<Env>),
      NOW
    );

    expect(at).toBe(NOW + DAY);
    expect(at).toBeGreaterThan(NOW + STORAGE_SAFETY_MIN_ALARM_SPACING_MS);
  });

  it('treats an empty allowlist as every project, and still does not spin', () => {
    // An operator who clears PROJECT_IDS means "all projects", which is a legitimate
    // configuration — and the one staging runs. It must widen scope WITHOUT reintroducing the
    // zero-length backoff.
    //
    // The measure interval is widened so the ARCHIVE term is what Math.min returns. Asserting
    // only `> NOW` (as a first draft did) passes just as well when an empty allowlist wrongly
    // excludes every project, because `measureAt` alone is already NOW + HOUR. Pinning the exact
    // archive deadline is the only form of this assertion that can tell "in scope" from "out of
    // scope" — the second time this same non-discriminating shape appeared in this file.
    seedProject(OUT_OF_SCOPE, NOW);

    const at = computeStorageSafetyAlarmTime(
      sql,
      productionEnv({
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PROJECT_IDS: '',
        PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS: String(30 * DAY),
      } as Partial<Env>),
      NOW
    );

    expect(at).toBe(NOW + DAY);
  });
});
