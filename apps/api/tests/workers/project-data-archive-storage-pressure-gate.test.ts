/**
 * The unscoped archive sweep leaves projects with no storage pressure alone.
 *
 * Archiving costs billed Durable Object row writes on the root object and on its shard, and all
 * it buys is room in the root object. On 2026-11-13 production archived 177,407 messages from a
 * project at 11% of its storage limit because selection was largest-first across every project.
 *
 * Every case drives the real `runProjectDataArchiveSharding` against real DO SQLite, real D1 and
 * the real R2 binding, and none tells the sweep which candidate to take (`.claude/rules/62`).
 * The quiet project always holds the LARGEST session, so the pre-gate largest-first ordering
 * would have taken it first: with the gate removed, the "stays in root" assertions fail.
 */
import {
  DEFAULT_PROJECT_DATA_ARCHIVE_MIN_STORAGE_USAGE_PERCENT,
  runProjectDataArchiveSharding,
  runScopedProjectDataArchiveCanary,
} from '@simple-agent-manager/project-data/internal/scheduled/project-data-archive-sharding';
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import type { Env as WorkerEnv } from '../../src/env';
import { projectDataStub, readLocation, withArchiveEnv } from './helpers/archive-fixtures';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

const testEnv = env as unknown as WorkerEnv;
const OWNER = 'archive-pressure-owner';
const INSTALLATION = 'archive-pressure-installation';
const HOUR_MS = 60 * 60 * 1000;
const QUIET_MESSAGES = 60;
const OTHER_MESSAGES = 12;

const SWEEP_ENV = {
  PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
  PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
  PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
  PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
  PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS: '1',
  PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '10',
  PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR: '2',
  PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: '2400000',
};

type Fixture = { projectId: string; sessionId: string };

async function seedProjectWithTerminalSession(label: string, messages: number): Promise<Fixture> {
  const projectId = `pressure-${label}-${crypto.randomUUID()}`;
  await seedUser(OWNER);
  await seedInstallation(INSTALLATION, OWNER);
  await seedProject(projectId, OWNER, INSTALLATION, { name: `Pressure ${label} ${projectId}` });
  const source = projectDataStub(projectId);
  await source.ensureProjectId(projectId);
  const sessionId = await source.createSession(null, `${label} session`);
  await source.persistMessageBatch(
    sessionId,
    Array.from({ length: messages }, (_, index) => ({
      messageId: `${projectId}-m-${String(index).padStart(4, '0')}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `${label} message ${index}`,
      toolMetadata: null,
      timestamp: new Date(2_000_000 + index * 1_000).toISOString(),
      sequence: index + 1,
    }))
  );
  await source.stopSession(sessionId);
  await source.runSummarySyncForTest();
  return { projectId, sessionId };
}

/**
 * Written the way the storage alarm writes it (`upsertStorageTelemetry`): one row per project.
 * `REPLACE` because that alarm may already have measured the fixture project for real.
 */
async function setTelemetry(projectId: string, usageRatio: number, measuredAt: number) {
  await env.DATABASE.prepare(
    `INSERT OR REPLACE INTO project_data_storage_telemetry
       (project_id, measured_at, database_size_bytes, limit_bytes, usage_ratio, status,
        created_at, updated_at)
     VALUES (?, ?, ?, 10000000000, ?, 'ok', ?, ?)`
  )
    .bind(projectId, measuredAt, Math.round(usageRatio * 1e10), usageRatio, measuredAt, measuredAt)
    .run();
}

async function clearTelemetry(projectId: string) {
  await env.DATABASE.prepare('DELETE FROM project_data_storage_telemetry WHERE project_id = ?')
    .bind(projectId)
    .run();
}

/** Every selection input is global, and the workers pool does not reset D1 between files. */
async function isolateTo(projectIds: string[]) {
  const marks = projectIds.map(() => '?').join(', ');
  await env.DATABASE.batch([
    env.DATABASE.prepare(`DELETE FROM session_summaries WHERE project_id NOT IN (${marks})`).bind(
      ...projectIds
    ),
    env.DATABASE.prepare(
      `DELETE FROM project_data_archive_migrations WHERE project_id NOT IN (${marks})`
    ).bind(...projectIds),
    env.DATABASE.prepare(
      `DELETE FROM project_data_session_locations WHERE project_id NOT IN (${marks})`
    ).bind(...projectIds),
    env.DATABASE.prepare('DELETE FROM project_data_archive_write_budget'),
    env.DATABASE.prepare(
      `DELETE FROM project_data_archive_global_sweep_cadence
       WHERE sweep_name = 'archive_sharding_global_sweep'`
    ),
  ]);
}

async function isArchived(fixture: Fixture): Promise<boolean> {
  const location = await readLocation(fixture.projectId, fixture.sessionId);
  return location?.location_state === 'archive_shard';
}

type TelemetryFixture =
  | { projectId: string; usageRatio: number; measuredAt: number }
  | {
      projectId: string;
      absent: true;
    };

/**
 * Fixture projects are real ProjectData objects, and their own storage alarm writes a fresh
 * near-zero telemetry row whenever it measures. Re-applying the fixture before every tick, and
 * reading it back, means the sweep always sees exactly the telemetry the case describes.
 */
async function applyTelemetry(fixtures: TelemetryFixture[]) {
  for (const fixture of fixtures) {
    if ('absent' in fixture) await clearTelemetry(fixture.projectId);
    else await setTelemetry(fixture.projectId, fixture.usageRatio, fixture.measuredAt);
  }
  for (const fixture of fixtures) {
    const row = await env.DATABASE.prepare(
      'SELECT usage_ratio, measured_at FROM project_data_storage_telemetry WHERE project_id = ?'
    )
      .bind(fixture.projectId)
      .first<{ usage_ratio: number; measured_at: number }>();
    if ('absent' in fixture) expect(row).toBeNull();
    else expect(row).toEqual({ usage_ratio: fixture.usageRatio, measured_at: fixture.measuredAt });
  }
}

/** Runs real ticks until every fixture in `until` is archived, or the tick bound is reached. */
async function runTicks(
  options: Parameters<typeof runProjectDataArchiveSharding>[2],
  until: Fixture[],
  startClock: number,
  telemetry: TelemetryFixture[] = []
) {
  let clock = startClock;
  await applyTelemetry(telemetry);
  let last = await runProjectDataArchiveSharding(testEnv, new Date(clock), options);
  for (let tick = 0; tick < 8; tick += 1) {
    expect(last).toMatchObject({ skipped: false, failed: 0 });
    const done = await Promise.all(until.map(isArchived));
    if (done.every(Boolean)) break;
    clock += 60_000;
    await applyTelemetry(telemetry);
    last = await runProjectDataArchiveSharding(testEnv, new Date(clock), options);
  }
  return { stats: last, clock };
}

async function journalStates(projectId: string): Promise<string[]> {
  const rows = await env.DATABASE.prepare(
    'SELECT state FROM project_data_archive_migrations WHERE project_id = ? ORDER BY created_at'
  )
    .bind(projectId)
    .all<{ state: string }>();
  return rows.results.map((row) => row.state);
}

describe('archive sweep storage-pressure gate', () => {
  it('archives pressured, unmeasured and stale-telemetry projects and leaves a quiet one in root', async () => {
    const quiet = await seedProjectWithTerminalSession('quiet', QUIET_MESSAGES);
    const pressured = await seedProjectWithTerminalSession('pressured', OTHER_MESSAGES);
    const boundary = await seedProjectWithTerminalSession('boundary', OTHER_MESSAGES);
    const unmeasured = await seedProjectWithTerminalSession('unmeasured', OTHER_MESSAGES);
    const stale = await seedProjectWithTerminalSession('stale', OTHER_MESSAGES);
    const all = [quiet, pressured, boundary, unmeasured, stale];
    await isolateTo(all.map((fixture) => fixture.projectId));

    // Sessions ended a moment ago; ticks run on a clock safely past the 1 ms grace.
    const start = Date.now() + 1_000;
    const telemetry: TelemetryFixture[] = [
      { projectId: quiet.projectId, usageRatio: 0.11, measuredAt: start },
      { projectId: pressured.projectId, usageRatio: 0.92, measuredAt: start },
      {
        projectId: boundary.projectId,
        usageRatio: DEFAULT_PROJECT_DATA_ARCHIVE_MIN_STORAGE_USAGE_PERCENT / 100,
        measuredAt: start,
      },
      { projectId: unmeasured.projectId, absent: true },
      // Same low reading as the quiet project, but older than the default 24 h max age.
      { projectId: stale.projectId, usageRatio: 0.11, measuredAt: start - 30 * HOUR_MS },
    ];

    await withArchiveEnv(SWEEP_ENV, async () => {
      // Default options: the gate the cron handler runs with when no admin override exists.
      const eligible = [pressured, boundary, unmeasured, stale];
      const { stats, clock } = await runTicks({}, eligible, start, telemetry);

      // Liveness beside the absence assertion: the sweep really ran and archived the others.
      for (const fixture of eligible) expect(await isArchived(fixture)).toBe(true);
      expect(await isArchived(quiet)).toBe(false);
      expect(await readLocation(quiet.projectId, quiet.sessionId)).toBeNull();

      // The refusal is recorded, with what it held back.
      expect(stats.storagePressureMinUsageRatio).toBe(
        DEFAULT_PROJECT_DATA_ARCHIVE_MIN_STORAGE_USAGE_PERCENT / 100
      );
      expect(stats.storagePressureHeldSessions).toBe(1);
      expect(stats.storagePressureHeldProjects).toBe(1);
      expect(stats.storagePressureHeldMessages).toBe(QUIET_MESSAGES);

      // An operator who names the project still gets it: the scoped canary is not gated.
      const dryRun = await runScopedProjectDataArchiveCanary(testEnv, {
        projectId: quiet.projectId,
        dryRun: true,
        nowDate: new Date(clock + 60_000),
      });
      expect(dryRun.selected.map((candidate) => candidate.sessionId)).toContain(quiet.sessionId);
      expect(await isArchived(quiet)).toBe(false);

      // Control: the gate, and nothing else, was holding the quiet session. Turned off, the
      // same sweep archives it.
      const off = await runTicks(
        { minStorageUsagePercent: 0 },
        [quiet],
        clock + 120_000,
        telemetry
      );
      expect(await isArchived(quiet)).toBe(true);
      expect(off.stats.storagePressureMinUsageRatio).toBe(0);
      expect(off.stats.storagePressureHeldSessions).toBe(0);
    });
  });

  it('starts archiving a quiet project once its storage reaches the threshold', async () => {
    const project = await seedProjectWithTerminalSession('growing', OTHER_MESSAGES);
    await isolateTo([project.projectId]);
    const start = Date.now() + 1_000;

    await withArchiveEnv(SWEEP_ENV, async () => {
      const held = await runTicks({ minStorageUsagePercent: 40 }, [project], start, [
        { projectId: project.projectId, usageRatio: 0.3, measuredAt: start },
      ]);
      expect(await isArchived(project)).toBe(false);
      expect(held.stats.storagePressureHeldSessions).toBe(1);

      // The next measurement reports the project above the threshold.
      const released = await runTicks(
        { minStorageUsagePercent: 40 },
        [project],
        held.clock + 60_000,
        [{ projectId: project.projectId, usageRatio: 0.41, measuredAt: held.clock }]
      );
      expect(await isArchived(project)).toBe(true);
      expect(released.stats.storagePressureHeldSessions).toBe(0);
    });
  });

  it('decides the threshold and the telemetry age at their exact boundaries', async () => {
    const justBelow = await seedProjectWithTerminalSession('just-below', OTHER_MESSAGES);
    const atThreshold = await seedProjectWithTerminalSession('at-threshold', OTHER_MESSAGES);
    const exactlyMaxAge = await seedProjectWithTerminalSession('exactly-max-age', OTHER_MESSAGES);
    const pastMaxAge = await seedProjectWithTerminalSession('past-max-age', OTHER_MESSAGES);
    const all = [justBelow, atThreshold, exactlyMaxAge, pastMaxAge];
    await isolateTo(all.map((fixture) => fixture.projectId));
    const tickAt = Date.now() + 1_000;
    const maxAgeHours = 6;

    await withArchiveEnv(SWEEP_ENV, async () => {
      await applyTelemetry([
        { projectId: justBelow.projectId, usageRatio: 0.4999, measuredAt: tickAt },
        { projectId: atThreshold.projectId, usageRatio: 0.5, measuredAt: tickAt },
        // A reading exactly as old as the max age is still trusted; one millisecond older is not.
        {
          projectId: exactlyMaxAge.projectId,
          usageRatio: 0.1,
          measuredAt: tickAt - maxAgeHours * HOUR_MS,
        },
        {
          projectId: pastMaxAge.projectId,
          usageRatio: 0.1,
          measuredAt: tickAt - maxAgeHours * HOUR_MS - 1,
        },
      ]);

      // One tick at one instant, so "exactly" means exactly.
      const stats = await runProjectDataArchiveSharding(testEnv, new Date(tickAt), {
        minStorageUsagePercent: 50,
        storageTelemetryMaxAgeHours: maxAgeHours,
      });

      expect(stats).toMatchObject({ skipped: false, failed: 0 });
      expect(stats.storagePressureHeldSessions).toBe(2);
      expect(stats.storagePressureHeldProjects).toBe(2);
      expect(await journalStates(justBelow.projectId)).toEqual([]);
      expect(await journalStates(exactlyMaxAge.projectId)).toEqual([]);
      // Liveness: the same tick did take the two projects on the other side of each boundary.
      expect(await journalStates(atThreshold.projectId)).toHaveLength(1);
      expect(await journalStates(pastMaxAge.projectId)).toHaveLength(1);
    });
  });

  it('finishes a migration already in flight for a project the gate now holds', async () => {
    const LARGE_MESSAGES = 600;
    const project = await seedProjectWithTerminalSession('in-flight', LARGE_MESSAGES);
    await isolateTo([project.projectId]);
    const start = Date.now() + 1_000;
    const inFlightEnv = { ...SWEEP_ENV, PROJECT_DATA_ARCHIVE_CHUNK_ROWS: '7' };

    await withArchiveEnv(inFlightEnv, async () => {
      // Tick 1: the project is unmeasured, so the session is selected. The clock is controlled so
      // the yield does not depend on runner speed: time stands still except that every chunk
      // written to R2 advances it 25 ms, so the 150 ms wall budget is spent by six chunk writes,
      // long before 600 rows in 7-row chunks are copied, and never before the journal exists.
      await applyTelemetry([{ projectId: project.projectId, absent: true }]);
      const realR2 = testEnv.PROJECT_DATA_ARCHIVE_R2 as R2Bucket;
      vi.useFakeTimers({ toFake: ['Date'] });
      testEnv.PROJECT_DATA_ARCHIVE_R2 = new Proxy(realR2, {
        get(target, property, receiver) {
          if (property === 'put') {
            return async (...args: unknown[]) => {
              vi.setSystemTime(Date.now() + 25);
              return (target.put as (...putArgs: unknown[]) => Promise<unknown>)(...args);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      let first: Awaited<ReturnType<typeof runProjectDataArchiveSharding>>;
      try {
        first = await withArchiveEnv({ PROJECT_DATA_ARCHIVE_WALL_TIME_MS: '150' }, () =>
          runProjectDataArchiveSharding(testEnv, new Date(start), {})
        );
      } finally {
        testEnv.PROJECT_DATA_ARCHIVE_R2 = realR2;
        vi.useRealTimers();
      }
      expect(first).toMatchObject({ skipped: false, failed: 0 });
      expect(first.yielded ?? 0).toBe(1);
      // Fixture precondition: genuinely in flight, neither finished nor back in root.
      expect((await readLocation(project.projectId, project.sessionId))?.location_state).toBe(
        'migrating'
      );

      // The project is now measured and far below the threshold, and it has a second ended
      // session that was never selected.
      const source = projectDataStub(project.projectId);
      const laterSessionId = await source.createSession(null, 'later session');
      await source.persistMessageBatch(laterSessionId, [
        {
          messageId: `${project.projectId}-later-0`,
          role: 'user',
          content: 'later message',
          toolMetadata: null,
          timestamp: new Date(9_000_000).toISOString(),
          sequence: 1,
        },
      ]);
      await source.stopSession(laterSessionId);
      await source.runSummarySyncForTest();
      const later = { projectId: project.projectId, sessionId: laterSessionId };
      const lowTelemetry: TelemetryFixture[] = [
        { projectId: project.projectId, usageRatio: 0.11, measuredAt: start + 120_000 },
      ];

      // The flip publishes the session; its root rows are then reclaimed in pages on later
      // ticks. Both must keep going for a project the gate holds.
      let clock = start + 120_000;
      let stats = first;
      const finished = async () =>
        (await isArchived(project)) && (await source.getMessageCount(project.sessionId)) === 0;
      for (let tick = 0; tick < 60 && !(await finished()); tick += 1) {
        clock += 60_000;
        await applyTelemetry(lowTelemetry);
        stats = await runProjectDataArchiveSharding(testEnv, new Date(clock), {});
        expect(stats).toMatchObject({ skipped: false, failed: 0 });
      }

      // The in-flight migration ran to completion under the gate, reclaim included...
      expect(await isArchived(project)).toBe(true);
      expect(await source.getMessageCount(project.sessionId)).toBe(0);
      // ...while the never-selected session of the same held project stayed in root.
      expect(await readLocation(later.projectId, later.sessionId)).toBeNull();
      expect(await source.getMessageCount(later.sessionId)).toBe(1);
      expect(stats.storagePressureHeldSessions).toBe(1);
    });
  });
});
