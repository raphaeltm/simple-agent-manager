import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { runProjectDataArchiveSharding } from '../../../src/scheduled/project-data-archive-sharding';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

function makeEnv(sqlite: Database.Database, overrides: Partial<Env> = {}): Env {
  return {
    DATABASE: createSqliteD1(sqlite),
    ...overrides,
  } as Env;
}

function createCoordinatorTables(sqlite: Database.Database): void {
  createSchemaTables(sqlite, [
    schema.sessionSummaries,
    schema.sessionSnapshots,
    schema.projectDataArchiveCircuitBreakers,
    schema.projectDataArchiveMigrations,
    schema.projectDataSessionLocations,
  ]);
}

describe('scheduled ProjectData archive sharding coordinator', () => {
  it('is production-disabled by default', async () => {
    const sqlite = new Database(':memory:');
    try {
      await expect(runProjectDataArchiveSharding(makeEnv(sqlite))).resolves.toMatchObject({
        enabled: false,
        skipped: true,
        skipReason: 'disabled',
        migrated: 0,
      });
    } finally {
      sqlite.close();
    }
  });

  it('fails closed when enabled without the private archive R2 binding', async () => {
    const sqlite = new Database(':memory:');
    try {
      await expect(
        runProjectDataArchiveSharding(
          makeEnv(sqlite, {
            PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          })
        )
      ).resolves.toMatchObject({
        enabled: true,
        skipped: true,
        skipReason: 'missing_r2_binding',
        migrated: 0,
      });
    } finally {
      sqlite.close();
    }
  });

  it('recovers a source_deleted crash gap by publishing the D1 location exactly once', async () => {
    const sqlite = new Database(':memory:');
    try {
      createCoordinatorTables(sqlite);
      sqlite
        .prepare(
          `INSERT INTO project_data_archive_migrations
             (migration_id, project_id, session_id, state, source_owner_name,
              target_owner_name, target_generation, source_intent_token,
              terminal_version_sha256, target_aggregate_sha256, r2_manifest_key,
              created_at, updated_at)
           VALUES ('migration-crash-gap', 'project-archive', 'session-archived',
                   'source_deleted', 'project-archive',
                   'project-archive:archive:g1:s7', 1, 'intent-crash-gap',
                   'terminal-version-sha', 'target-aggregate-sha',
                   'project-data/session-archives/project-archive/session-archived/manifest.json',
                   1000, 1000)`
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO project_data_session_locations
             (project_id, session_id, location_state, owner_kind, owner_name,
              generation, migration_id, source_owner_name, target_owner_name,
              target_aggregate_sha256, routing_schema_version, updated_at)
           VALUES ('project-archive', 'session-archived', 'migrating', 'archive_shard',
                   'project-archive:archive:g1:s7', 1, 'migration-crash-gap',
                   'project-archive', 'project-archive:archive:g1:s7',
                   'target-aggregate-sha', 1, 1000)`
        )
        .run();

      const stats = await runProjectDataArchiveSharding(
        makeEnv(sqlite, {
          PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
          PROJECT_DATA_ARCHIVE_R2: {} as R2Bucket,
        }),
        new Date('2026-09-01T05:00:00.000Z')
      );

      expect(stats).toMatchObject({
        enabled: true,
        skipped: false,
        recoveredCrashGaps: 1,
        migrated: 0,
        failed: 0,
      });
      expect(
        sqlite
          .prepare(
            `SELECT location_state, owner_kind, owner_name, generation, published_at
             FROM project_data_session_locations
             WHERE project_id = 'project-archive' AND session_id = 'session-archived'`
          )
          .get()
      ).toEqual({
        location_state: 'archive_shard',
        owner_kind: 'archive_shard',
        owner_name: 'project-archive:archive:g1:s7',
        generation: 1,
        published_at: Date.parse('2026-09-01T05:00:00.000Z'),
      });
      expect(
        sqlite
          .prepare(
            `SELECT state, published_at
             FROM project_data_archive_migrations
             WHERE migration_id = 'migration-crash-gap'`
          )
          .get()
      ).toEqual({
        state: 'published',
        published_at: Date.parse('2026-09-01T05:00:00.000Z'),
      });
    } finally {
      sqlite.close();
    }
  });
});
