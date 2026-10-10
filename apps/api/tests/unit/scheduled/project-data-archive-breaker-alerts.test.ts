/**
 * A ProjectData archive circuit breaker that a sweep opens must tell the operators, once per
 * opening. The transition (closed or absent → open) is read on a real SQL engine in the same D1
 * transaction that opens the breaker; poisonings are driven through the real sweep where the
 * production path allows it.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { notificationClaims, sentNotifications, sendNotificationOnceMock } = vi.hoisted(() => {
  const notificationClaims = new Set<string>();
  const sentNotifications: Array<{
    userId: string;
    dedupKey: string;
    notification: Record<string, unknown>;
  }> = [];
  // Mirrors the NotificationService DO contract: a per-user claim on the dedup key, then create.
  const sendNotificationOnceMock = vi.fn(
    async (
      _env: unknown,
      userId: string,
      dedupKey: string,
      _expiresAt: number,
      notification: Record<string, unknown>
    ) => {
      const claim = `${userId}\u0000${dedupKey}`;
      if (notificationClaims.has(claim)) return false;
      notificationClaims.add(claim);
      sentNotifications.push({ userId, dedupKey, notification });
      return true;
    }
  );
  return { notificationClaims, sentNotifications, sendNotificationOnceMock };
});

vi.mock('../../../src/services/notification', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/notification')>()),
  sendNotificationOnce: sendNotificationOnceMock,
}));

import * as observabilitySchema from '../../../src/db/observability-schema';
import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { PROJECT_DATA_ARCHIVE_BREAKER_OPENED_ALERT } from '../../../src/scheduled/project-data-archive-breaker-alerts';
import {
  poisonProjectDataArchiveMigration,
  runProjectDataArchiveSharding,
} from '../../../src/scheduled/project-data-archive-sharding';
import { setProjectDataArchiveCircuitBreaker } from '../../../src/services/project-data-archive-rollout-controls';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const PROJECT_ID = 'project-breaker';
const PROJECT_NAME = 'Breaker Project';
const TARGET_OWNER = `${PROJECT_ID}:archive:g1:s7`;
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const POISON_AFTER_ATTEMPTS = 3;

class CompactArchiveTimeoutError extends Error {
  override name = 'CompactArchiveTimeoutError';
}

interface Harness {
  main: Database.Database;
  observability: Database.Database;
  env: Env;
}

function createHarness(overrides: Partial<Env> = {}): Harness {
  const main = new Database(':memory:');
  const observability = new Database(':memory:');
  createSchemaTables(main, [
    schema.users,
    schema.projects,
    schema.sessionSummaries,
    schema.sessionSnapshots,
    schema.projectDataArchiveCircuitBreakers,
    schema.projectDataArchiveGlobalSweepCadence,
    schema.projectDataArchiveMigrations,
    schema.projectDataArchiveCopyCheckpoints,
    schema.projectDataSessionLocations,
  ]);
  createSchemaTables(observability, [observabilitySchema.platformErrors]);
  main.prepare('INSERT INTO projects (id, name) VALUES (?, ?)').run(PROJECT_ID, PROJECT_NAME);
  const insertUser = main.prepare('INSERT INTO users (id, role, status) VALUES (?, ?, ?)');
  insertUser.run('admin-1', 'superadmin', 'active');
  insertUser.run('admin-2', 'superadmin', 'active');
  // Controls: none of these is an operator.
  insertUser.run('admin-suspended', 'superadmin', 'suspended');
  insertUser.run('member-1', 'user', 'active');
  insertUser.run('system-sentinel', 'superadmin', 'system');

  // Every attempt fails at the source's first call, as a timed-out compact archive does.
  const failingSource = {
    ensureProjectId: vi.fn(async () => undefined),
    archiveSourceInspectIntent: vi.fn(async () => {
      throw new CompactArchiveTimeoutError('Compact archive R2 deadline exceeded (head_pending)');
    }),
  };
  const target = { ensureProjectId: vi.fn(async () => undefined) };
  const owners: Record<string, unknown> = { [PROJECT_ID]: failingSource, [TARGET_OWNER]: target };

  const env = {
    DATABASE: createSqliteD1(main),
    OBSERVABILITY_DATABASE: createSqliteD1(observability),
    NOTIFICATION: {},
    TRIAL_ANONYMOUS_USER_ID: 'system-sentinel',
    PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
    PROJECT_DATA_ARCHIVE_POISON_AFTER_ATTEMPTS: String(POISON_AFTER_ATTEMPTS),
    PROJECT_DATA_ARCHIVE_R2: {},
    PROJECT_DATA: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        const stub = owners[id];
        if (!stub) throw new Error(`Missing fake ProjectData stub ${id}`);
        return stub;
      },
    },
    ...overrides,
  } as unknown as Env;
  return { main, observability, env };
}

/** A `failed` journal old enough to reclaim, with `attempts` attempts already spent. */
function seedFailedMigration(main: Database.Database, migrationId: string, attempts: number): void {
  const sessionId = `session-${migrationId}`;
  main
    .prepare(
      `INSERT INTO project_data_archive_migrations
         (migration_id, project_id, session_id, state, source_owner_name, target_owner_name,
          target_generation, source_intent_token, lease_epoch, lease_expires_at, attempt_count,
          error_code, created_at, updated_at)
       VALUES (?, ?, ?, 'failed', ?, ?, 1, 'token', 0, 1000, ?, 'CompactArchiveTimeoutError', 1000, 1000)`
    )
    .run(migrationId, PROJECT_ID, sessionId, PROJECT_ID, TARGET_OWNER, attempts);
  main
    .prepare(
      `INSERT INTO project_data_session_locations
         (project_id, session_id, location_state, owner_kind, owner_name, generation, migration_id,
          source_owner_name, target_owner_name, routing_schema_version, updated_at)
       VALUES (?, ?, 'migrating', 'archive_shard', ?, 1, ?, ?, ?, 1, 1000)`
    )
    .run(PROJECT_ID, sessionId, TARGET_OWNER, migrationId, PROJECT_ID, TARGET_OWNER);
}

function readBreaker(main: Database.Database) {
  return main
    .prepare('SELECT state, reason FROM project_data_archive_circuit_breakers WHERE project_id = ?')
    .get(PROJECT_ID) as { state: string; reason: string } | undefined;
}

function readMigration(main: Database.Database, migrationId: string) {
  return main
    .prepare(
      'SELECT state, attempt_count, error_code FROM project_data_archive_migrations WHERE migration_id = ?'
    )
    .get(migrationId) as { state: string; attempt_count: number; error_code: string | null };
}

function readBreakerAlertRows(observability: Database.Database) {
  return (
    observability
      .prepare('SELECT level, message, context FROM platform_errors ORDER BY timestamp ASC')
      .all() as Array<{ level: string; message: string; context: string | null }>
  )
    .map((row) => ({ ...row, context: JSON.parse(row.context ?? '{}') as Record<string, unknown> }))
    .filter((row) => row.context.alertKind === PROJECT_DATA_ARCHIVE_BREAKER_OPENED_ALERT);
}

describe('ProjectData archive breaker alerts', () => {
  beforeEach(() => {
    notificationClaims.clear();
    sentNotifications.length = 0;
    sendNotificationOnceMock.mockClear();
  });

  it('alerts every operator once when a poisoning through the sweep opens the breaker', async () => {
    const { main, observability, env } = createHarness();
    seedFailedMigration(main, 'migration-1', POISON_AFTER_ATTEMPTS - 1);

    const stats = await runProjectDataArchiveSharding(env, new Date(NOW));

    expect(stats.poisoned).toBe(1);
    expect(readMigration(main, 'migration-1').state).toBe('poisoned');
    expect(readBreaker(main)).toEqual({
      state: 'open',
      reason: 'attempts_exhausted:CompactArchiveTimeoutError',
    });

    const rows = readBreakerAlertRows(observability);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.level).toBe('error');
    expect(rows[0]!.message).toContain(PROJECT_NAME);
    expect(rows[0]!.message).toContain(PROJECT_ID);
    expect(rows[0]!.context).toMatchObject({
      projectId: PROJECT_ID,
      migrationId: 'migration-1',
      reason: 'attempts_exhausted:CompactArchiveTimeoutError',
      errorMessage: 'Compact archive R2 deadline exceeded (head_pending)',
      openedAt: NOW,
    });

    expect(sentNotifications.map((sent) => sent.userId).sort()).toEqual(['admin-1', 'admin-2']);
    for (const sent of sentNotifications) {
      expect(sent.notification).toMatchObject({
        type: 'cron_failure',
        urgency: 'high',
        title: `Archiving stopped for ${PROJECT_NAME}`,
        actionUrl: '/admin/storage',
        metadata: { projectId: PROJECT_ID, migrationId: 'migration-1' },
      });
      expect(String(sent.notification.body)).toContain('Admin → Storage');
    }
  });

  it('does not alert again while the breaker stays open', async () => {
    const { main, observability, env } = createHarness();
    seedFailedMigration(main, 'migration-1', POISON_AFTER_ATTEMPTS - 1);
    await runProjectDataArchiveSharding(env, new Date(NOW));
    expect(readBreakerAlertRows(observability)).toHaveLength(1);
    expect(sendNotificationOnceMock).toHaveBeenCalledTimes(2);

    // A later sweep skips the project while its breaker is open.
    seedFailedMigration(main, 'migration-2', POISON_AFTER_ATTEMPTS - 1);
    const later = await runProjectDataArchiveSharding(env, new Date(NOW + 2 * DAY));
    expect(later.skipped).toBe(false);
    expect(readMigration(main, 'migration-2').state).toBe('failed');
    // A migration still in flight when the breaker opened can be poisoned afterwards.
    expect(
      await poisonProjectDataArchiveMigration(env, {
        migrationId: 'migration-2',
        projectId: PROJECT_ID,
        reason: 'attempts_exhausted:CompactArchiveTimeoutError',
        now: NOW + 2 * DAY,
      })
    ).toBe(true);
    expect(readMigration(main, 'migration-2').state).toBe('poisoned');
    expect(readBreaker(main)?.state).toBe('open');

    expect(readBreakerAlertRows(observability)).toHaveLength(1);
    // Not even attempted: the opening is detected once, not deduplicated per delivery.
    expect(sendNotificationOnceMock).toHaveBeenCalledTimes(2);
  });

  it('announces one opening when two migrations of the project are poisoned concurrently', async () => {
    const { main, observability, env } = createHarness();
    // Production shape: a breaker closed by raw SQL keeps its old `opened_at`.
    main
      .prepare(
        `INSERT INTO project_data_archive_circuit_breakers (project_id, state, reason, opened_at, updated_at)
         VALUES (?, 'closed', 'reset by operator', ?, ?)`
      )
      .run(PROJECT_ID, NOW - 20 * DAY, NOW - 18 * DAY);
    seedFailedMigration(main, 'migration-a', POISON_AFTER_ATTEMPTS);
    seedFailedMigration(main, 'migration-b', POISON_AFTER_ATTEMPTS);

    await Promise.all(
      ['migration-a', 'migration-b'].map((migrationId) =>
        poisonProjectDataArchiveMigration(env, {
          migrationId,
          projectId: PROJECT_ID,
          reason: 'attempts_exhausted:CompactArchiveTimeoutError',
          now: NOW,
        })
      )
    );

    expect(readBreaker(main)?.state).toBe('open');
    expect(readBreakerAlertRows(observability)).toHaveLength(1);
    expect(sendNotificationOnceMock).toHaveBeenCalledTimes(2);
  });

  it('alerts nobody when a failure stays below the poison threshold', async () => {
    const { main, observability, env } = createHarness();
    seedFailedMigration(main, 'migration-1', 0);

    const stats = await runProjectDataArchiveSharding(env, new Date(NOW));

    // Liveness: the attempt really ran and failed.
    expect(stats.failed).toBe(1);
    expect(stats.poisoned).toBe(0);
    expect(readMigration(main, 'migration-1')).toEqual({
      state: 'failed',
      attempt_count: 1,
      error_code: 'CompactArchiveTimeoutError',
    });
    expect(readBreaker(main)).toBeUndefined();
    expect(readBreakerAlertRows(observability)).toHaveLength(0);
    expect(sendNotificationOnceMock).not.toHaveBeenCalled();
  });

  it('alerts again when the breaker re-opens after an operator closes it', async () => {
    const { main, observability, env } = createHarness();
    seedFailedMigration(main, 'migration-1', POISON_AFTER_ATTEMPTS - 1);
    await runProjectDataArchiveSharding(env, new Date(NOW));

    await setProjectDataArchiveCircuitBreaker(env, {
      projectId: PROJECT_ID,
      state: 'closed',
      reason: 'Closed from admin UI',
      now: NOW + DAY,
    });
    seedFailedMigration(main, 'migration-2', POISON_AFTER_ATTEMPTS - 1);
    await runProjectDataArchiveSharding(env, new Date(NOW + 2 * DAY));

    expect(readBreaker(main)?.state).toBe('open');
    expect(readBreakerAlertRows(observability).map((row) => row.context.migrationId)).toEqual([
      'migration-1',
      'migration-2',
    ]);
    expect(sentNotifications).toHaveLength(4);
  });

  it('does not announce a poisoning in a project an operator already froze', async () => {
    const { main, observability, env } = createHarness();
    await setProjectDataArchiveCircuitBreaker(env, {
      projectId: PROJECT_ID,
      state: 'frozen',
      reason: 'Frozen by operator',
      now: NOW - DAY,
    });
    seedFailedMigration(main, 'migration-1', POISON_AFTER_ATTEMPTS);

    await poisonProjectDataArchiveMigration(env, {
      migrationId: 'migration-1',
      projectId: PROJECT_ID,
      reason: 'attempts_exhausted:CompactArchiveTimeoutError',
      now: NOW,
    });

    expect(readMigration(main, 'migration-1').state).toBe('poisoned');
    expect(readBreakerAlertRows(observability)).toHaveLength(0);
    expect(sendNotificationOnceMock).not.toHaveBeenCalled();
  });

  it('still poisons and reaches the remaining operators when one delivery fails', async () => {
    const { main, observability, env } = createHarness();
    seedFailedMigration(main, 'migration-1', POISON_AFTER_ATTEMPTS - 1);
    sendNotificationOnceMock.mockImplementationOnce(async () => {
      throw new Error('Notification DO unavailable');
    });

    const stats = await runProjectDataArchiveSharding(env, new Date(NOW));

    expect(stats.poisoned).toBe(1);
    expect(readBreaker(main)?.state).toBe('open');
    expect(readBreakerAlertRows(observability)).toHaveLength(1);
    expect(sentNotifications).toHaveLength(1);
  });
});
