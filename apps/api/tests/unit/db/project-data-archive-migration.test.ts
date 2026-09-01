import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import migrationSql from '../../../src/db/migrations/0132_project_data_terminal_archive_sharding.sql?raw';

describe('0132 ProjectData archive sharding migration', () => {
  it('aborts publication when the transitional location is not the matching source CAS', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)');
      db.exec(migrationSql);
      db.prepare("INSERT INTO projects (id) VALUES ('project-a')").run();
      db.prepare(
        `INSERT INTO project_data_archive_migrations
         (migration_id, project_id, session_id, state, source_owner_name,
          source_generation, target_owner_name, target_generation, terminal_version,
          created_at, updated_at)
         VALUES ('migration-a', 'project-a', 'session-a', 'source_deleted', 'project-a', 0,
                 'project-data-archive:project-a:0', 1, 'version-a', 1, 1)`
      ).run();
      db.prepare(
        `INSERT INTO project_data_session_locations
         (project_id, session_id, state, owner_kind, owner_name, generation,
          migration_id, routing_version, updated_at)
         VALUES ('project-a', 'session-a', 'migrating', 'root', 'project-a', 0,
                 'migration-a', 99, 1)`
      ).run();

      expect(() =>
        db
          .prepare(
            `UPDATE project_data_archive_migrations SET state = 'archived'
             WHERE migration_id = 'migration-a'`
          )
          .run()
      ).toThrow(/publish location CAS mismatch/);
      expect(
        db
          .prepare(
            "SELECT state FROM project_data_archive_migrations WHERE migration_id = 'migration-a'"
          )
          .get()
      ).toEqual({ state: 'source_deleted' });
    } finally {
      db.close();
    }
  });

  it('publishes the location only on the source_deleted -> archived journal transition', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)');
      db.exec(migrationSql);
      db.prepare("INSERT INTO projects (id) VALUES ('project-a')").run();
      db.prepare(
        `INSERT INTO project_data_archive_migrations
         (migration_id, project_id, session_id, state, source_owner_name,
          source_generation, target_owner_name, target_generation, terminal_version,
          created_at, updated_at)
         VALUES ('migration-a', 'project-a', 'session-a', 'sealed', 'project-a', 0,
                 'project-data-archive:project-a:0', 1, 'version-a', 1, 1)`
      ).run();
      db.prepare(
        `INSERT INTO project_data_session_locations
         (project_id, session_id, state, owner_kind, owner_name, generation,
          migration_id, routing_version, updated_at)
         VALUES ('project-a', 'session-a', 'migrating', 'root', 'project-a', 0,
                 'migration-a', 1, 1)`
      ).run();

      db.prepare(
        `UPDATE project_data_archive_migrations SET state = 'source_deleted'
         WHERE migration_id = 'migration-a' AND state = 'sealed'`
      ).run();
      expect(
        db
          .prepare(
            "SELECT state, owner_name, generation FROM project_data_session_locations WHERE session_id = 'session-a'"
          )
          .get()
      ).toEqual({ state: 'migrating', owner_name: 'project-a', generation: 0 });

      db.prepare(
        `UPDATE project_data_archive_migrations SET state = 'archived', updated_at = 2
         WHERE migration_id = 'migration-a' AND state = 'source_deleted'`
      ).run();
      expect(
        db
          .prepare(
            "SELECT state, owner_kind, owner_name, generation, routing_version FROM project_data_session_locations WHERE session_id = 'session-a'"
          )
          .get()
      ).toEqual({
        state: 'archive_shard',
        owner_kind: 'archive_shard',
        owner_name: 'project-data-archive:project-a:0',
        generation: 1,
        routing_version: 1,
      });

      db.prepare(
        `UPDATE project_data_archive_migrations
            SET state = 'copying',
                source_owner_name = target_owner_name,
                source_generation = target_generation,
                target_owner_name = 'project-data-archive:project-a:1',
                target_generation = 2,
                aggregate_hash = NULL,
                manifest_r2_key = NULL,
                updated_at = 3
          WHERE migration_id = 'migration-a' AND state = 'archived'`
      ).run();
      expect(
        db
          .prepare(
            "SELECT state, owner_name, generation FROM project_data_session_locations WHERE session_id = 'session-a'"
          )
          .get()
      ).toEqual({
        state: 'migrating',
        owner_name: 'project-data-archive:project-a:0',
        generation: 1,
      });
      db.prepare(
        `UPDATE project_data_archive_migrations SET state = 'sealed' WHERE migration_id = 'migration-a'`
      ).run();
      db.prepare(
        `UPDATE project_data_archive_migrations SET state = 'source_deleted' WHERE migration_id = 'migration-a'`
      ).run();
      db.prepare(
        `UPDATE project_data_archive_migrations SET state = 'archived', updated_at = 4 WHERE migration_id = 'migration-a'`
      ).run();
      expect(
        db
          .prepare(
            "SELECT state, owner_name, generation FROM project_data_session_locations WHERE session_id = 'session-a'"
          )
          .get()
      ).toEqual({
        state: 'archive_shard',
        owner_name: 'project-data-archive:project-a:1',
        generation: 2,
      });

      db.prepare(
        `UPDATE project_data_archive_migrations
            SET state = 'copying',
                source_owner_name = target_owner_name,
                source_generation = target_generation,
                target_owner_name = 'project-a',
                target_generation = 0,
                aggregate_hash = NULL,
                manifest_r2_key = NULL,
                updated_at = 5
          WHERE migration_id = 'migration-a' AND state = 'archived'`
      ).run();
      db.prepare(
        `UPDATE project_data_archive_migrations SET state = 'sealed' WHERE migration_id = 'migration-a'`
      ).run();
      db.prepare(
        `UPDATE project_data_archive_migrations SET state = 'source_deleted' WHERE migration_id = 'migration-a'`
      ).run();
      db.prepare(
        `UPDATE project_data_archive_migrations SET state = 'archived', updated_at = 6 WHERE migration_id = 'migration-a'`
      ).run();
      expect(
        db
          .prepare(
            "SELECT state, owner_kind, owner_name, generation, migration_id FROM project_data_session_locations WHERE session_id = 'session-a'"
          )
          .get()
      ).toEqual({
        state: 'root',
        owner_kind: 'root',
        owner_name: 'project-a',
        generation: 0,
        migration_id: null,
      });
    } finally {
      db.close();
    }
  });

  it('rejects rehome when the authoritative location routing version drifted', () => {
    const db = new Database(':memory:');
    try {
      db.exec('CREATE TABLE projects (id TEXT PRIMARY KEY)');
      db.exec(migrationSql);
      db.prepare("INSERT INTO projects (id) VALUES ('project-a')").run();
      db.prepare(
        `INSERT INTO project_data_archive_migrations
         (migration_id, project_id, session_id, state, source_owner_name,
          source_generation, target_owner_name, target_generation, terminal_version,
          created_at, updated_at)
         VALUES ('migration-a', 'project-a', 'session-a', 'archived', 'project-a', 0,
                 'project-data-archive:project-a:0', 1, 'version-a', 1, 1)`
      ).run();
      db.prepare(
        `INSERT INTO project_data_session_locations
         (project_id, session_id, state, owner_kind, owner_name, generation,
          migration_id, routing_version, updated_at)
         VALUES ('project-a', 'session-a', 'archive_shard', 'archive_shard',
                 'project-data-archive:project-a:0', 1, 'migration-a', 99, 1)`
      ).run();

      expect(() =>
        db
          .prepare(
            `UPDATE project_data_archive_migrations
                SET state = 'copying',
                    source_owner_name = target_owner_name,
                    source_generation = target_generation,
                    target_owner_name = 'project-data-archive:project-a:1',
                    target_generation = 2
              WHERE migration_id = 'migration-a' AND state = 'archived'`
          )
          .run()
      ).toThrow(/rehome source location mismatch/);
      expect(
        db
          .prepare(
            `SELECT state, routing_version FROM project_data_session_locations
             WHERE session_id = 'session-a'`
          )
          .get()
      ).toEqual({ state: 'archive_shard', routing_version: 99 });
    } finally {
      db.close();
    }
  });
});
