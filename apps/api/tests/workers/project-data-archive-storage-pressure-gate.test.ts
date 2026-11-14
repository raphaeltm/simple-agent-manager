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
import { describe, expect, it } from 'vitest';

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

/** Runs real ticks until every fixture in `until` is archived, or the tick bound is reached. */
async function runTicks(
  options: Parameters<typeof runProjectDataArchiveSharding>[2],
  until: Fixture[],
  startClock: number
) {
  let clock = startClock;
  let last = await runProjectDataArchiveSharding(testEnv, new Date(clock), options);
  for (let tick = 0; tick < 8; tick += 1) {
    expect(last).toMatchObject({ skipped: false, failed: 0 });
    const done = await Promise.all(until.map(isArchived));
    if (done.every(Boolean)) break;
    clock += 60_000;
    last = await runProjectDataArchiveSharding(testEnv, new Date(clock), options);
  }
  return { stats: last, clock };
}

describe('archive sweep storage-pressure gate', () => {
  it('archives pressured, unmeasured and stale-telemetry projects and leaves a quiet one in root', async () => {
    const now = Date.now();
    const quiet = await seedProjectWithTerminalSession('quiet', QUIET_MESSAGES);
    const pressured = await seedProjectWithTerminalSession('pressured', OTHER_MESSAGES);
    const boundary = await seedProjectWithTerminalSession('boundary', OTHER_MESSAGES);
    const unmeasured = await seedProjectWithTerminalSession('unmeasured', OTHER_MESSAGES);
    const stale = await seedProjectWithTerminalSession('stale', OTHER_MESSAGES);
    const all = [quiet, pressured, boundary, unmeasured, stale];
    await isolateTo(all.map((fixture) => fixture.projectId));

    await setTelemetry(quiet.projectId, 0.11, now);
    await setTelemetry(pressured.projectId, 0.92, now);
    await setTelemetry(
      boundary.projectId,
      DEFAULT_PROJECT_DATA_ARCHIVE_MIN_STORAGE_USAGE_PERCENT / 100,
      now
    );
    await clearTelemetry(unmeasured.projectId);
    // Same low reading as the quiet project, but older than the default 24 h max age.
    await setTelemetry(stale.projectId, 0.11, now - 30 * HOUR_MS);

    await withArchiveEnv(SWEEP_ENV, async () => {
      // Default options: the gate the cron handler runs with when no admin override exists.
      const eligible = [pressured, boundary, unmeasured, stale];
      const { stats, clock } = await runTicks({}, eligible, now);

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
      const off = await runTicks({ minStorageUsagePercent: 0 }, [quiet], clock + 120_000);
      expect(await isArchived(quiet)).toBe(true);
      expect(off.stats.storagePressureMinUsageRatio).toBe(0);
      expect(off.stats.storagePressureHeldSessions).toBe(0);
    });
  });

  it('starts archiving a quiet project once its storage reaches the threshold', async () => {
    const now = Date.now();
    const project = await seedProjectWithTerminalSession('growing', OTHER_MESSAGES);
    await isolateTo([project.projectId]);
    await setTelemetry(project.projectId, 0.3, now);

    await withArchiveEnv(SWEEP_ENV, async () => {
      const held = await runTicks({ minStorageUsagePercent: 40 }, [project], now);
      expect(await isArchived(project)).toBe(false);
      expect(held.stats.storagePressureHeldSessions).toBe(1);

      // The next hourly measurement reports the project above the threshold.
      await setTelemetry(project.projectId, 0.41, held.clock);
      const released = await runTicks(
        { minStorageUsagePercent: 40 },
        [project],
        held.clock + 60_000
      );
      expect(await isArchived(project)).toBe(true);
      expect(released.stats.storagePressureHeldSessions).toBe(0);
    });
  });
});
