/**
 * Archive drain relief (2026-11-12): fill the tick, stop false refusals, end dead sleepers.
 *
 * Production published exactly one session per 18-minute tick: a largest-first candidate the
 * root refused at prepare still consumed the tick's cumulative message budget and kept its write
 * reservation, and the 10 s wall budget held one small session. Refusal invariants froze
 * sessions behind terminal `error` activity and attention markers nothing would ever resolve,
 * and expired degraded sleepers whose task had finished stayed `sleeping` forever.
 *
 * Every case enters through the production trigger: the unscoped scheduled sweep
 * (`runProjectDataArchiveSharding`) or the snapshot purge (`runSessionSnapshotPurge`), against
 * real ProjectData SQLite, real D1 and the real R2 binding. Refusal conditions are produced by
 * the real writers (`reportActivity`, `failSession`, `createAttentionMarker`), never seeded into
 * `session_state` directly (`.claude/rules/62`).
 */
import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { Env as WorkerEnv } from '../../src/env';
import { runProjectDataArchiveSharding } from '../../src/scheduled/project-data-archive-sharding';
import { runSessionSnapshotPurge } from '../../src/scheduled/session-snapshot-purge';
import {
  isolateSweepFixture,
  projectDataStub,
  readLocation,
  seedMessages,
  withArchiveEnv,
} from './helpers/archive-fixtures';
import {
  seedInstallation,
  seedNode,
  seedProject,
  seedTask,
  seedUser,
  seedWorkspace,
} from './helpers/seed-d1';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const testEnv = env as unknown as WorkerEnv;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The shipped shape, minus the grace period and cadence a test cannot wait for. */
function sweepEnv(overrides: Record<string, string> = {}) {
  return {
    PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_COMPACT_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: '1',
    PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS: '1',
    PROJECT_DATA_ARCHIVE_SWEEP_PROJECTS: '1',
    PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '50',
    PROJECT_DATA_ARCHIVE_WALL_TIME_MS: '60000',
    PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET: '2400000',
    ...overrides,
  };
}

async function seedArchiveProject(prefix: string): Promise<{
  projectId: string;
  source: DurableObjectStub<ProjectDataTestDouble>;
}> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userId = `${prefix}-user-${suffix}`;
  const installationId = `${prefix}-install-${suffix}`;
  const projectId = `${prefix}-project-${suffix}`;
  await seedUser(userId);
  await seedInstallation(installationId, userId);
  await seedProject(projectId, userId, installationId, { name: `${prefix} ${suffix}` });
  const source = projectDataStub(projectId);
  await source.ensureProjectId(projectId);
  return { projectId, source };
}

async function seedSession(
  source: DurableObjectStub<ProjectDataTestDouble>,
  label: string,
  count: number,
  end: 'stop' | 'fail' = 'stop'
): Promise<string> {
  const sessionId = await source.createSession(null, label);
  const messages = seedMessages(count).map((message) => ({
    ...message,
    messageId: `${label}-${message.messageId}`,
  }));
  await source.persistMessageBatch(sessionId, messages);
  if (end === 'stop') await source.stopSession(sessionId);
  else await source.failSession(sessionId, 'agent crashed');
  return sessionId;
}

async function journalFor(projectId: string, sessionId: string) {
  return env.DATABASE.prepare(
    `SELECT state, error_code, error_message FROM project_data_archive_migrations
     WHERE project_id = ? AND session_id = ? ORDER BY created_at DESC LIMIT 1`
  )
    .bind(projectId, sessionId)
    .first<{ state: string; error_code: string | null; error_message: string | null }>();
}

async function reservedWrites(): Promise<number> {
  const row = await env.DATABASE.prepare(
    `SELECT reserved_writes FROM project_data_archive_write_budget WHERE id = 'global'`
  ).first<{ reserved_writes: number }>();
  return Number(row?.reserved_writes ?? 0);
}

async function runTick(offsetMs: number) {
  return runProjectDataArchiveSharding(testEnv, new Date(Date.now() + offsetMs));
}

describe('archive drain relief: fill the tick', () => {
  it('publishes the smaller sessions behind a refused largest candidate in the same tick', async () => {
    const { projectId, source } = await seedArchiveProject('drain-fill');
    // Largest-first selection puts the refused session first, exactly as production's 16:46Z
    // tick did. Its refusal comes from the real activity writer.
    const refusedId = await seedSession(source, 'refused-large', 60);
    await source.reportActivity(refusedId, 'prompting', { promptStartedAt: Date.now() });
    const small = [
      await seedSession(source, 'small-a', 20),
      await seedSession(source, 'small-b', 19),
      await seedSession(source, 'small-c', 18),
    ];
    await source.runSummarySyncForTest();
    await isolateSweepFixture(projectId, { clearCadence: true });

    // A cumulative message budget of 70 is what made the old loop stop: the 60-message refusal
    // was charged 60 before it was refused, leaving room for none of the small sessions.
    const stats = await withArchiveEnv(
      sweepEnv({ PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET: '70' }),
      () => runTick(60_000)
    );

    expect(stats).toMatchObject({ refused: 1, migrated: 3, failed: 0, poisoned: 0 });
    for (const sessionId of small) {
      expect(await readLocation(projectId, sessionId)).toMatchObject({
        location_state: 'archive_shard',
      });
    }
    expect(await readLocation(projectId, refusedId)).toMatchObject({ location_state: 'root' });
    expect(await journalFor(projectId, refusedId)).toMatchObject({
      state: 'frozen',
      error_code: 'precopy_refused',
    });
  });

  it("a refused candidate does not take one of the tick's session slots", async () => {
    const { projectId, source } = await seedArchiveProject('drain-slots');
    const refusedId = await seedSession(source, 'refused-slot', 60);
    await source.reportActivity(refusedId, 'prompting', { promptStartedAt: Date.now() });
    await seedSession(source, 'slot-a', 20);
    await seedSession(source, 'slot-b', 19);
    await seedSession(source, 'slot-c', 18);
    await source.runSummarySyncForTest();
    await isolateSweepFixture(projectId, { clearCadence: true });

    // Two slots. If the refusal took one, the tick would copy a single session.
    const stats = await withArchiveEnv(sweepEnv({ PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS: '2' }), () =>
      runTick(60_000)
    );

    expect(stats).toMatchObject({ refused: 1, migrated: 2, failed: 0 });
  });

  it('releases the write reservation of a candidate the root refuses before copying', async () => {
    const { projectId, source } = await seedArchiveProject('drain-release');
    const refusedId = await seedSession(source, 'refused-only', 40);
    await source.reportActivity(refusedId, 'prompting', { promptStartedAt: Date.now() });
    await source.runSummarySyncForTest();
    await isolateSweepFixture(projectId, { clearCadence: true });

    const stats = await withArchiveEnv(sweepEnv(), () => runTick(60_000));

    expect(stats).toMatchObject({ refused: 1, migrated: 0 });
    // Before the fix the 40-message estimate stayed reserved for the rest of the UTC day.
    expect(await reservedWrites()).toBe(0);
  });

  it('control: a session that archives keeps its reservation', async () => {
    const { projectId, source } = await seedArchiveProject('drain-keep');
    await seedSession(source, 'archives', 40);
    await source.runSummarySyncForTest();
    await isolateSweepFixture(projectId, { clearCadence: true });

    const stats = await withArchiveEnv(sweepEnv(), () => runTick(60_000));

    expect(stats).toMatchObject({ refused: 0, migrated: 1 });
    expect(await reservedWrites()).toBeGreaterThan(0);
  });
});

describe('archive drain relief: refusals that describe no live work', () => {
  it('archives a session that ended through failSession (terminal error activity)', async () => {
    const { projectId, source } = await seedArchiveProject('drain-failed');
    // A real session has reported activity before it fails; `failSession` then rewrites that
    // row to the terminal `error` mirror.
    const sessionId = await source.createSession(null, 'failed');
    await source.persistMessageBatch(sessionId, seedMessages(12));
    await source.reportActivity(sessionId, 'prompting', { promptStartedAt: Date.now() });
    await source.failSession(sessionId, 'agent crashed');
    const activity = await runInDurableObject(source, async (_instance, state) =>
      state.storage.sql
        .exec('SELECT activity FROM session_state WHERE session_id = ?', sessionId)
        .toArray()
    );
    // The real writer left the mirror the old invariant refused on.
    expect(activity).toEqual([{ activity: 'error' }]);
    await source.runSummarySyncForTest();
    await isolateSweepFixture(projectId, { clearCadence: true });

    const stats = await withArchiveEnv(sweepEnv(), () => runTick(60_000));

    expect(stats).toMatchObject({ refused: 0, migrated: 1, failed: 0 });
    expect(await readLocation(projectId, sessionId)).toMatchObject({
      location_state: 'archive_shard',
    });
  });

  it('control: a session still prompting is refused', async () => {
    const { projectId, source } = await seedArchiveProject('drain-prompting');
    const sessionId = await seedSession(source, 'prompting', 12);
    await source.reportActivity(sessionId, 'prompting', { promptStartedAt: Date.now() });
    await source.runSummarySyncForTest();
    await isolateSweepFixture(projectId, { clearCadence: true });

    const stats = await withArchiveEnv(sweepEnv(), () => runTick(60_000));

    expect(stats).toMatchObject({ refused: 1, migrated: 0 });
    expect((await journalFor(projectId, sessionId))?.error_message).toContain(
      'active_session_state'
    );
  });

  it.each([
    {
      name: 'a non-expiring marker raised before the session grace',
      createdAgeMs: 3 * DAY_MS,
      expiresInMs: null,
      refused: false,
    },
    {
      name: 'an expiring marker that expired before the session grace',
      createdAgeMs: 5 * DAY_MS,
      expiresInMs: -2 * DAY_MS,
      refused: false,
    },
    {
      name: 'control: a non-expiring marker raised inside the session grace',
      createdAgeMs: 60_000,
      expiresInMs: null,
      refused: true,
    },
    {
      name: 'control: an old marker that has not expired yet',
      createdAgeMs: 3 * DAY_MS,
      expiresInMs: DAY_MS,
      refused: true,
    },
    {
      name: 'control: a marker that expired inside the grace, before the expiry alarm ran',
      createdAgeMs: 3 * DAY_MS,
      expiresInMs: -60_000,
      refused: true,
    },
  ])('attention: $name', async ({ createdAgeMs, expiresInMs, refused }) => {
    const { projectId, source } = await seedArchiveProject('drain-marker');
    const sessionId = await seedSession(source, 'marker', 12);
    // Ages are relative to the tick's own clock, which runs two days ahead so the session's
    // one-day grace has passed.
    const tickOffsetMs = 2 * DAY_MS;
    const tickNow = Date.now() + tickOffsetMs;
    const marker = await source.createAttentionMarker({
      sessionId,
      kind: 'wake_failed',
      source: 'system',
      reason: 'wake failed',
      expiresAt: expiresInMs === null ? null : tickNow + expiresInMs,
    });
    // `created_at` is stamped by the writer at wall-clock now; age it to the case's creation
    // time. This is the one column the test sets: no writer back-dates a marker.
    await runInDurableObject(source, async (_instance, state) => {
      state.storage.sql.exec(
        'UPDATE session_attention_markers SET created_at = ? WHERE id = ?',
        tickNow - createdAgeMs,
        marker.id
      );
    });
    await source.runSummarySyncForTest();
    await isolateSweepFixture(projectId, { clearCadence: true });

    // One day of session grace: the shipped grace is 7 days, a test cannot wait for it.
    const stats = await withArchiveEnv(
      sweepEnv({ PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS: String(DAY_MS) }),
      () => runTick(tickOffsetMs)
    );

    if (refused) {
      expect(stats).toMatchObject({ refused: 1, migrated: 0 });
      expect((await journalFor(projectId, sessionId))?.error_message).toContain(
        'unresolved_attention'
      );
    } else {
      expect(stats).toMatchObject({ refused: 0, migrated: 1 });
      expect(await readLocation(projectId, sessionId)).toMatchObject({
        location_state: 'archive_shard',
      });
    }
  });
});

describe('archive drain relief: expired degraded sleepers', () => {
  async function seedDegradedSleeper(
    label: string,
    expiresAt: string,
    taskStatuses: string[]
  ): Promise<{ projectId: string; sessionId: string; snapshotId: string }> {
    const { projectId, source } = await seedArchiveProject(`sleeper-${label}`);
    const userId = (
      await env.DATABASE.prepare('SELECT user_id FROM projects WHERE id = ?')
        .bind(projectId)
        .first<{ user_id: string }>()
    )?.user_id as string;
    const sessionId = await source.createSession(null, label);
    expect(await source.sleepSession(sessionId)).toBe(true);
    for (const [index, status] of taskStatuses.entries()) {
      await seedTask(`${projectId}-task-${index}`, projectId, userId, {
        status,
        chatSessionId: sessionId,
      });
    }
    const nodeId = `${projectId}-node`;
    const workspaceId = `${projectId}-ws`;
    await seedNode(nodeId, userId, { status: 'deleted' });
    await seedWorkspace(workspaceId, nodeId, userId, {
      projectId,
      status: 'deleted',
      chatSessionId: sessionId,
    });
    const snapshotId = `${projectId}-snap`;
    await env.DATABASE.prepare(
      `INSERT INTO session_snapshots (id, project_id, workspace_id, node_id, user_id,
         chat_session_id, runtime, status, degradation, manifest_r2_key, expires_at,
         sleep_status, sleeping_at)
       VALUES (?, ?, ?, ?, ?, ?, 'vm', 'degraded', 'partial', ?, ?, 'sleeping', ?)`
    )
      .bind(
        snapshotId,
        projectId,
        workspaceId,
        nodeId,
        userId,
        sessionId,
        `snapshots/${projectId}/manifest.json`,
        expiresAt,
        '2026-01-01T00:00:00.000Z'
      )
      .run();
    return { projectId, sessionId, snapshotId };
  }

  async function snapshotStatus(snapshotId: string): Promise<string | undefined> {
    return (
      await env.DATABASE.prepare('SELECT status FROM session_snapshots WHERE id = ?')
        .bind(snapshotId)
        .first<{ status: string }>()
    )?.status;
  }

  async function sessionStatus(projectId: string, sessionId: string): Promise<unknown> {
    const session = await projectDataStub(projectId).getSession(sessionId);
    return (session as { status?: string } | null)?.status;
  }

  it('stops an expired degraded sleeper whose task already completed', async () => {
    const sleeper = await seedDegradedSleeper('completed', '2026-02-01T00:00:00.000Z', [
      'completed',
    ]);

    await withArchiveEnv({ SESSION_SNAPSHOT_PURGE_ENABLED: 'true' }, () =>
      runSessionSnapshotPurge(testEnv, new Date())
    );

    expect(await snapshotStatus(sleeper.snapshotId)).toBe('expired');
    expect(await sessionStatus(sleeper.projectId, sleeper.sessionId)).toBe('stopped');

    // Bounded escape (`.claude/rules/47`): an expired row is not selected again.
    await withArchiveEnv({ SESSION_SNAPSHOT_PURGE_ENABLED: 'true' }, () =>
      runSessionSnapshotPurge(testEnv, new Date())
    );
    expect(await snapshotStatus(sleeper.snapshotId)).toBe('expired');
  });

  it('a sleeper with a queued task neither moves nor blocks valid rows behind it', async () => {
    // The queued sleeper expires first, so expiry order puts it at the head of a one-row batch.
    const zombie = await seedDegradedSleeper('queued', '2026-01-15T00:00:00.000Z', [
      'queued',
      'in_progress',
    ]);
    const valid = await seedDegradedSleeper('valid', '2026-02-02T00:00:00.000Z', ['completed']);

    await withArchiveEnv(
      { SESSION_SNAPSHOT_PURGE_ENABLED: 'true', SESSION_SNAPSHOT_PURGE_BATCH_SIZE: '1' },
      () => runSessionSnapshotPurge(testEnv, new Date())
    );

    expect(await snapshotStatus(valid.snapshotId)).toBe('expired');
    expect(await sessionStatus(valid.projectId, valid.sessionId)).toBe('stopped');
    // The queued conversation is left exactly as it was: its task may still start.
    expect(await snapshotStatus(zombie.snapshotId)).toBe('degraded');
    expect(await sessionStatus(zombie.projectId, zombie.sessionId)).toBe('sleeping');
  });

  it('expires the snapshot of a sleeper whose transcript the archive already moved', async () => {
    // Staging, 2026-11-12: 8 expired degraded sleepers whose sessions had been archived failed
    // every sweep, because `stopSession` is refused by the archive write fence.
    const { projectId, source } = await seedArchiveProject('sleeper-archived');
    const sessionId = await seedSession(source, 'archived', 12);
    await source.runSummarySyncForTest();
    await isolateSweepFixture(projectId, { clearCadence: true });
    await withArchiveEnv(sweepEnv(), () => runTick(60_000));
    expect(await readLocation(projectId, sessionId)).toMatchObject({
      location_state: 'archive_shard',
    });
    const userId = (
      await env.DATABASE.prepare('SELECT user_id FROM projects WHERE id = ?')
        .bind(projectId)
        .first<{ user_id: string }>()
    )?.user_id as string;
    await seedTask(`${projectId}-task`, projectId, userId, {
      status: 'failed',
      chatSessionId: sessionId,
    });
    const nodeId = `${projectId}-node`;
    await seedNode(nodeId, userId, { status: 'deleted' });
    await seedWorkspace(`${projectId}-ws`, nodeId, userId, { projectId, status: 'deleted' });
    const snapshotId = `${projectId}-snap`;
    await env.DATABASE.prepare(
      `INSERT INTO session_snapshots (id, project_id, workspace_id, node_id, user_id,
         chat_session_id, runtime, status, degradation, manifest_r2_key, expires_at,
         sleep_status, sleeping_at, recovery_status)
       VALUES (?, ?, ?, ?, ?, ?, 'vm', 'degraded', 'partial', ?, '2026-02-01T00:00:00.000Z',
         'sleeping', '2026-01-01T00:00:00.000Z', 'failed')`
    )
      .bind(
        snapshotId,
        projectId,
        `${projectId}-ws`,
        nodeId,
        userId,
        sessionId,
        `snapshots/${projectId}/manifest.json`
      )
      .run();

    // Exact archive routing on, as in production: that is what fences `stopSession`.
    await withArchiveEnv(
      { SESSION_SNAPSHOT_PURGE_ENABLED: 'true', PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true' },
      () => runSessionSnapshotPurge(testEnv, new Date())
    );

    expect(await snapshotStatus(snapshotId)).toBe('expired');
    // The archive location is untouched.
    expect(await readLocation(projectId, sessionId)).toMatchObject({
      location_state: 'archive_shard',
    });
  });

  it('leaves a sleeper alone while its archive fence is unverified, without blocking rows behind it, and expires it once it unwinds', async () => {
    // The fenced sleeper expires first, so a one-row batch ordered by expiry would pick it first.
    const sleeper = await seedDegradedSleeper('fenced', '2026-01-10T00:00:00.000Z', ['completed']);
    const valid = await seedDegradedSleeper('behind-fence', '2026-01-11T00:00:00.000Z', [
      'completed',
    ]);
    // The fence `createCandidateJournal` writes before the root has checked eligibility. The
    // migration id is left NULL so the fixture needs no journal row; routing parses a
    // `migrating` location without one, and the location state is what this case is about.
    await env.DATABASE.prepare(
      `INSERT INTO project_data_session_locations (
         project_id, session_id, location_state, owner_kind, owner_name, generation,
         migration_id, source_owner_name, target_owner_name, routing_schema_version, updated_at
       ) VALUES (?, ?, 'migrating', 'archive_shard', ?, 1, NULL, ?, ?, 1, ?)`
    )
      .bind(
        sleeper.projectId,
        sleeper.sessionId,
        `${sleeper.projectId}:archive:g1:s0`,
        sleeper.projectId,
        `${sleeper.projectId}:archive:g1:s0`,
        Date.now()
      )
      .run();
    const purge = () =>
      withArchiveEnv(
        {
          SESSION_SNAPSHOT_PURGE_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          SESSION_SNAPSHOT_PURGE_BATCH_SIZE: '1',
        },
        () => runSessionSnapshotPurge(testEnv, new Date())
      );

    await purge();
    expect(await snapshotStatus(sleeper.snapshotId)).toBe('degraded');
    expect(await sessionStatus(sleeper.projectId, sleeper.sessionId)).toBe('sleeping');
    // The fenced row did not take the only slot.
    expect(await snapshotStatus(valid.snapshotId)).toBe('expired');

    // The root refused the candidate and the fence unwound to `root`.
    await env.DATABASE.prepare(
      `UPDATE project_data_session_locations
       SET location_state = 'root', owner_kind = 'root', owner_name = ?, generation = 0,
           migration_id = NULL
       WHERE project_id = ? AND session_id = ?`
    )
      .bind(sleeper.projectId, sleeper.projectId, sleeper.sessionId)
      .run();
    await purge();
    expect(await snapshotStatus(sleeper.snapshotId)).toBe('expired');
    expect(await sessionStatus(sleeper.projectId, sleeper.sessionId)).toBe('stopped');
  });

  it('control: an unexpired degraded sleeper is left asleep', async () => {
    const sleeper = await seedDegradedSleeper('unexpired', '2099-01-01T00:00:00.000Z', [
      'completed',
    ]);

    await withArchiveEnv({ SESSION_SNAPSHOT_PURGE_ENABLED: 'true' }, () =>
      runSessionSnapshotPurge(testEnv, new Date())
    );

    expect(await snapshotStatus(sleeper.snapshotId)).toBe('degraded');
    expect(await sessionStatus(sleeper.projectId, sleeper.sessionId)).toBe('sleeping');
  });
});
