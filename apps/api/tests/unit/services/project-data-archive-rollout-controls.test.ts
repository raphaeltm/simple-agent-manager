import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  freezeProjectDataArchiveProject,
  getProjectDataArchiveRolloutState,
  listProjectDataArchiveProblemMigrations,
  setProjectDataArchiveCircuitBreaker,
} from '../../../src/services/project-data-archive-rollout-controls';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

function makeEnv(sqlite: Database.Database, overrides: Partial<Env> = {}): Env {
  return {
    DATABASE: createSqliteD1(sqlite),
    ...overrides,
  } as Env;
}

function createTables(sqlite: Database.Database): void {
  createSchemaTables(sqlite, [
    schema.projectDataArchiveCircuitBreakers,
    schema.projectDataArchiveMigrations,
    schema.projectDataSessionLocations,
  ]);
}

function seedMigration(
  sqlite: Database.Database,
  input: {
    projectId?: string;
    sessionId?: string;
    migrationId?: string;
    state?: string;
    locationState?: string;
    updatedAt?: number;
  } = {}
): void {
  const projectId = input.projectId ?? 'project-archive';
  const sessionId = input.sessionId ?? 'session-archive';
  const migrationId = input.migrationId ?? `migration-${projectId}-${sessionId}`;
  const state = input.state ?? 'failed';
  const locationState = input.locationState ?? 'migrating';
  const updatedAt = input.updatedAt ?? 1000;
  sqlite
    .prepare(
      `INSERT INTO project_data_archive_migrations
         (migration_id, project_id, session_id, state, source_owner_name,
          target_owner_name, target_generation, lease_epoch, attempt_count,
          error_code, error_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, 1, 'test_error', 'test message', 900, ?)`
    )
    .run(migrationId, projectId, sessionId, state, projectId, `${projectId}:archive:g1:s1`, updatedAt);
  sqlite
    .prepare(
      `INSERT INTO project_data_session_locations
         (project_id, session_id, location_state, owner_kind, owner_name,
          generation, migration_id, source_owner_name, target_owner_name,
          routing_schema_version, updated_at)
       VALUES (?, ?, ?, 'archive_shard', ?, 1, ?, ?, ?, 1, ?)`
    )
    .run(
      projectId,
      sessionId,
      locationState,
      `${projectId}:archive:g1:s1`,
      migrationId,
      projectId,
      `${projectId}:archive:g1:s1`,
      updatedAt
    );
}

describe('ProjectData archive rollout controls service', () => {
  it('summarizes D1 journal, location, and breaker state with project/session filters', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      seedMigration(sqlite, {
        projectId: 'project-a',
        sessionId: 'session-a',
        migrationId: 'migration-a',
        state: 'failed',
        updatedAt: 1000,
      });
      seedMigration(sqlite, {
        projectId: 'project-a',
        sessionId: 'session-b',
        migrationId: 'migration-b',
        state: 'poisoned',
        locationState: 'frozen',
        updatedAt: 2000,
      });
      seedMigration(sqlite, {
        projectId: 'project-b',
        sessionId: 'session-a',
        migrationId: 'migration-c',
        state: 'failed',
        updatedAt: 3000,
      });
      sqlite
        .prepare(
          `INSERT INTO project_data_archive_circuit_breakers
             (project_id, state, reason, opened_at, updated_at)
           VALUES ('project-a', 'open', 'operator hold', 2500, 2500)`
        )
        .run();

      const state = await getProjectDataArchiveRolloutState(makeEnv(sqlite), {
        projectId: 'project-a',
        sessionId: 'session-b',
        limit: 10,
      });

      expect(state.filters).toEqual({ projectId: 'project-a', sessionId: 'session-b', limit: 10 });
      expect(state.config.globalCronEnabled).toBe(false);
      expect(state.migrationStateCounts).toEqual([
        {
          projectId: 'project-a',
          state: 'poisoned',
          count: 1,
          oldestUpdatedAt: 2000,
          newestUpdatedAt: 2000,
        },
      ]);
      expect(state.locationStateCounts).toEqual([
        {
          projectId: 'project-a',
          state: 'frozen',
          count: 1,
          oldestUpdatedAt: 2000,
          newestUpdatedAt: 2000,
        },
      ]);
      expect(state.circuitBreakers).toEqual([
        {
          projectId: 'project-a',
          state: 'open',
          reason: 'operator hold',
          openedAt: 2500,
          updatedAt: 2500,
        },
      ]);
      expect(state.recentMigrations.map((migration) => migration.migrationId)).toEqual([
        'migration-b',
      ]);
      expect(state.locations.map((location) => location.sessionId)).toEqual(['session-b']);
    } finally {
      sqlite.close();
    }
  });

  it('lists only failed, poisoned, or frozen problem migrations with bounded limits', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      seedMigration(sqlite, {
        migrationId: 'migration-failed',
        sessionId: 'session-failed',
        state: 'failed',
        updatedAt: 1000,
      });
      seedMigration(sqlite, {
        migrationId: 'migration-poisoned',
        sessionId: 'session-poisoned',
        state: 'poisoned',
        updatedAt: 2000,
      });
      seedMigration(sqlite, {
        migrationId: 'migration-copying',
        sessionId: 'session-copying',
        state: 'copying',
        locationState: 'migrating',
        updatedAt: 3000,
      });
      seedMigration(sqlite, {
        migrationId: 'migration-location-frozen',
        sessionId: 'session-location-frozen',
        state: 'copying',
        locationState: 'frozen',
        updatedAt: 4000,
      });

      const migrations = await listProjectDataArchiveProblemMigrations(makeEnv(sqlite), {
        projectId: 'project-archive',
        limit: 2,
      });

      expect(migrations.map((migration) => migration.migrationId)).toEqual([
        'migration-failed',
        'migration-poisoned',
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('keeps state aggregates complete when recent row lists are limited', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      seedMigration(sqlite, {
        migrationId: 'migration-source-deleted',
        sessionId: 'session-source-deleted',
        state: 'source_deleted',
        locationState: 'archive_shard',
        updatedAt: 1000,
      });
      seedMigration(sqlite, {
        migrationId: 'migration-poisoned',
        sessionId: 'session-poisoned',
        state: 'poisoned',
        locationState: 'frozen',
        updatedAt: 2000,
      });
      seedMigration(sqlite, {
        migrationId: 'migration-failed',
        sessionId: 'session-failed',
        state: 'failed',
        updatedAt: 3000,
      });

      const state = await getProjectDataArchiveRolloutState(makeEnv(sqlite), {
        projectId: 'project-archive',
        limit: 1,
      });

      expect(state.recentMigrations.map((migration) => migration.migrationId)).toEqual([
        'migration-failed',
      ]);
      expect(state.recentMigrationsHasMore).toBe(true);
      expect(state.locations).toHaveLength(1);
      expect(state.locationsHasMore).toBe(true);
      expect(state.migrationStateCounts.map((count) => count.state).sort()).toEqual([
        'failed',
        'poisoned',
        'source_deleted',
      ]);
      expect(state.locationStateCounts.map((count) => count.state).sort()).toEqual([
        'archive_shard',
        'frozen',
        'migrating',
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('freezes project archive work and closes the circuit without thawing frozen rows', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);
      seedMigration(sqlite, {
        migrationId: 'migration-copying',
        sessionId: 'session-copying',
        state: 'copying',
      });
      seedMigration(sqlite, {
        migrationId: 'migration-published',
        sessionId: 'session-published',
        state: 'published',
        locationState: 'archive_shard',
      });

      const frozen = await freezeProjectDataArchiveProject(makeEnv(sqlite), {
        projectId: 'project-archive',
        reason: 'operator freeze',
        now: 5000,
      });

      expect(frozen).toMatchObject({
        projectId: 'project-archive',
        state: 'frozen',
        reason: 'operator freeze',
        frozenMigrations: 1,
        frozenLocations: 1,
        updatedAt: 5000,
      });
      expect(
        sqlite
          .prepare(
            `SELECT state, reason FROM project_data_archive_circuit_breakers WHERE project_id = ?`
          )
          .get('project-archive')
      ).toEqual({ state: 'frozen', reason: 'operator freeze' });

      const closed = await setProjectDataArchiveCircuitBreaker(makeEnv(sqlite), {
        projectId: 'project-archive',
        state: 'closed',
        reason: 'operator unfreeze',
        now: 6000,
      });

      expect(closed).toMatchObject({
        projectId: 'project-archive',
        state: 'closed',
        reason: 'operator unfreeze',
        frozenMigrations: 0,
        frozenLocations: 0,
        updatedAt: 6000,
      });
      expect(closed.note).toContain('remain frozen');
      expect(
        sqlite
          .prepare(
            `SELECT state, reason, opened_at FROM project_data_archive_circuit_breakers
             WHERE project_id = ?`
          )
          .get('project-archive')
      ).toEqual({ state: 'closed', reason: 'operator unfreeze', opened_at: null });
      expect(
        sqlite
          .prepare(
            `SELECT state FROM project_data_archive_migrations WHERE migration_id = 'migration-copying'`
          )
          .get()
      ).toEqual({ state: 'frozen' });
    } finally {
      sqlite.close();
    }
  });

  it('preserves circuit breaker openedAt when refreshing an active breaker', async () => {
    const sqlite = new Database(':memory:');
    try {
      createTables(sqlite);

      await setProjectDataArchiveCircuitBreaker(makeEnv(sqlite), {
        projectId: 'project-archive',
        state: 'open',
        reason: 'initial incident',
        now: 5000,
      });
      await setProjectDataArchiveCircuitBreaker(makeEnv(sqlite), {
        projectId: 'project-archive',
        state: 'frozen',
        reason: 'operator freeze',
        now: 6000,
      });

      expect(
        sqlite
          .prepare(
            `SELECT state, reason, opened_at, updated_at
             FROM project_data_archive_circuit_breakers
             WHERE project_id = ?`
          )
          .get('project-archive')
      ).toEqual({
        state: 'frozen',
        reason: 'operator freeze',
        opened_at: 5000,
        updated_at: 6000,
      });
    } finally {
      sqlite.close();
    }
  });
});
