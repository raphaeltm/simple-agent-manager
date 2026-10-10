/**
 * The archive-breaker opening alert on the real runtime: Miniflare D1 for the batched pre-upsert
 * `SELECT` that detects the closed → open transition, `persistError` into the real observability
 * D1, and the real NotificationService Durable Object for the per-operator claim and delivery.
 * The node unit suite proves the sweep-driven paths on better-sqlite3; this one proves the
 * production bindings honour the same contract.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { NotificationService } from '../../src/durable-objects/notification';
import type { Env as WorkerEnv } from '../../src/env';
import { PROJECT_DATA_ARCHIVE_BREAKER_OPENED_ALERT } from '../../src/scheduled/project-data-archive-breaker-alerts';
import { poisonProjectDataArchiveMigration } from '../../src/scheduled/project-data-archive-sharding';
import { seedInstallation, seedProject, seedUser } from './helpers/seed-d1';

const testEnv = env as unknown as WorkerEnv;
const OWNER = 'breaker-alert-owner';
const OPERATOR = 'breaker-alert-operator';
const INSTALLATION = 'breaker-alert-installation';
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

async function seedPoisonableMigration(projectId: string, migrationId: string): Promise<void> {
  const sessionId = `session-${migrationId}`;
  const targetOwner = `${projectId}:archive:g1:s7`;
  await testEnv.DATABASE.prepare(
    `INSERT INTO project_data_archive_migrations
       (migration_id, project_id, session_id, state, source_owner_name, target_owner_name,
        target_generation, attempt_count, created_at, updated_at)
     VALUES (?, ?, ?, 'failed', ?, ?, 1, 3, ?, ?)`
  )
    .bind(migrationId, projectId, sessionId, projectId, targetOwner, NOW - 1000, NOW - 1000)
    .run();
  await testEnv.DATABASE.prepare(
    `INSERT INTO project_data_session_locations
       (project_id, session_id, location_state, owner_kind, owner_name, generation, migration_id,
        source_owner_name, target_owner_name, updated_at)
     VALUES (?, ?, 'migrating', 'archive_shard', ?, 1, ?, ?, ?, ?)`
  )
    .bind(projectId, sessionId, targetOwner, migrationId, projectId, targetOwner, NOW - 1000)
    .run();
}

async function breakerAlertRows(projectId: string) {
  const result = await testEnv.OBSERVABILITY_DATABASE.prepare(
    `SELECT message, context FROM platform_errors`
  ).all<{ message: string; context: string | null }>();
  return (result.results ?? []).filter((row) => {
    const context = JSON.parse(row.context ?? '{}') as Record<string, unknown>;
    return (
      context.alertKind === PROJECT_DATA_ARCHIVE_BREAKER_OPENED_ALERT &&
      context.projectId === projectId
    );
  });
}

async function operatorNotifications(projectId: string) {
  const stub = testEnv.NOTIFICATION.get(
    testEnv.NOTIFICATION.idFromName(OPERATOR)
  ) as unknown as DurableObjectStub<NotificationService>;
  const page = await stub.listNotifications(OPERATOR, { type: 'cron_failure' });
  return page.notifications.filter(
    (notification) => notification.metadata?.projectId === projectId
  );
}

describe('ProjectData archive breaker alert on the Workers runtime', () => {
  it('notifies the operator once when poisoning opens the breaker, not again while it stays open', async () => {
    const projectId = `breaker-alert-${crypto.randomUUID()}`;
    await seedUser(OWNER);
    await seedUser(OPERATOR);
    await testEnv.DATABASE.prepare(
      "UPDATE users SET role = 'superadmin', status = 'active' WHERE id = ?"
    )
      .bind(OPERATOR)
      .run();
    await seedInstallation(INSTALLATION, OWNER);
    await seedProject(projectId, OWNER, INSTALLATION, { name: 'Breaker alert project' });
    await seedPoisonableMigration(projectId, `${projectId}-m1`);
    await seedPoisonableMigration(projectId, `${projectId}-m2`);

    for (const migrationId of [`${projectId}-m1`, `${projectId}-m2`]) {
      expect(
        await poisonProjectDataArchiveMigration(testEnv, {
          migrationId,
          projectId,
          reason: 'attempts_exhausted:CompactArchiveTimeoutError',
          message: 'Compact archive R2 deadline exceeded (head_pending)',
          now: NOW,
        })
      ).toBe(true);
    }

    const breaker = await testEnv.DATABASE.prepare(
      'SELECT state FROM project_data_archive_circuit_breakers WHERE project_id = ?'
    )
      .bind(projectId)
      .first<{ state: string }>();
    expect(breaker?.state).toBe('open');

    const rows = await breakerAlertRows(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toContain('Breaker alert project');

    const notifications = await operatorNotifications(projectId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      type: 'cron_failure',
      urgency: 'high',
      title: 'Archiving stopped for Breaker alert project',
      actionUrl: '/admin/storage',
    });
    expect(notifications[0]!.metadata).toMatchObject({ migrationId: `${projectId}-m1` });
  });
});
