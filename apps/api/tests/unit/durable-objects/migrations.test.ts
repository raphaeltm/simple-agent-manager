import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS, runMigrations } from '../../../src/durable-objects/migrations';
import { createSqlStorage } from './sql-storage-test-utils';

/**
 * In-memory mock of SqlStorage for testing migration logic.
 * Implements the subset of SqlStorage used by our migration runner.
 */
class MockSqlStorage {
  private tables = new Map<string, Record<string, unknown>[]>();
  private execLog: string[] = [];

  exec(query: string, ...params: unknown[]): { toArray: () => Record<string, unknown>[] } {
    this.execLog.push(query.trim());

    const normalized = query.trim().toUpperCase();

    // Handle CREATE TABLE IF NOT EXISTS migrations
    if (normalized.startsWith('CREATE TABLE IF NOT EXISTS MIGRATIONS')) {
      if (!this.tables.has('migrations')) {
        this.tables.set('migrations', []);
      }
      return { toArray: () => [] };
    }

    // Handle CREATE TABLE
    if (normalized.startsWith('CREATE TABLE') || normalized.startsWith('CREATE INDEX')) {
      const tableMatch = query.match(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i);
      if (tableMatch) {
        this.tables.set(tableMatch[1], []);
      }
      return { toArray: () => [] };
    }

    // Handle SELECT name FROM migrations
    if (normalized.includes('SELECT NAME FROM MIGRATIONS')) {
      const rows = this.tables.get('migrations') || [];
      return { toArray: () => rows };
    }

    // Handle INSERT INTO migrations
    if (normalized.startsWith('INSERT INTO MIGRATIONS')) {
      const rows = this.tables.get('migrations') || [];
      rows.push({ name: params[0] as string, applied_at: params[1] as number });
      return { toArray: () => [] };
    }

    // Default: return empty
    return { toArray: () => [] };
  }

  getExecLog(): string[] {
    return this.execLog;
  }

  getMigrationsTable(): Record<string, unknown>[] {
    return this.tables.get('migrations') || [];
  }
}

describe('DO Migrations', () => {
  describe('MIGRATIONS array', () => {
    it('has at least one migration defined', () => {
      expect(MIGRATIONS.length).toBeGreaterThanOrEqual(1);
    });

    it('has unique migration names', () => {
      const names = MIGRATIONS.map((m) => m.name);
      const unique = new Set(names);
      expect(unique.size).toBe(names.length);
    });

    it('first migration is 001-initial-schema', () => {
      expect(MIGRATIONS[0].name).toBe('001-initial-schema');
    });

    it('each migration has a name and run function', () => {
      for (const migration of MIGRATIONS) {
        expect(typeof migration.name).toBe('string');
        expect(migration.name.length).toBeGreaterThan(0);
        expect(typeof migration.run).toBe('function');
      }
    });
  });

  describe('runMigrations', () => {
    it('creates migrations tracking table', () => {
      const sql = new MockSqlStorage();
      runMigrations(sql as unknown as SqlStorage);

      const log = sql.getExecLog();
      expect(log[0]).toContain('CREATE TABLE IF NOT EXISTS migrations');
    });

    it('runs all migrations on fresh database', () => {
      const sql = new MockSqlStorage();
      runMigrations(sql as unknown as SqlStorage);

      const applied = sql.getMigrationsTable();
      expect(applied.length).toBe(MIGRATIONS.length);
      expect(applied[0].name).toBe('001-initial-schema');
    });

    it('skips already-applied migrations', () => {
      const sql = new MockSqlStorage();

      // Run once
      runMigrations(sql as unknown as SqlStorage);
      const firstRunCount = sql.getExecLog().length;

      // Run again — should only do SELECT, no new CREATE TABLEs
      runMigrations(sql as unknown as SqlStorage);
      const secondRunLog = sql.getExecLog().slice(firstRunCount);

      // Should have: CREATE TABLE IF NOT EXISTS migrations, SELECT name FROM migrations
      // No INSERT INTO migrations (since all are already applied)
      const insertCount = secondRunLog.filter((q) =>
        q.toUpperCase().startsWith('INSERT INTO MIGRATIONS')
      ).length;
      expect(insertCount).toBe(0);
    });

    it('is idempotent — running twice produces same state', () => {
      const sql1 = new MockSqlStorage();
      runMigrations(sql1 as unknown as SqlStorage);

      const sql2 = new MockSqlStorage();
      runMigrations(sql2 as unknown as SqlStorage);
      runMigrations(sql2 as unknown as SqlStorage);

      expect(sql1.getMigrationsTable().length).toBe(sql2.getMigrationsTable().length);
    });

    it('applies the full SQLite chain on a clean install', () => {
      const db = new Database(':memory:');
      try {
        const sql = createSqlStorage(db);
        runMigrations(sql);

        const applied = db.prepare('SELECT name FROM migrations ORDER BY rowid').all() as Array<{
          name: string;
        }>;
        expect(applied.map((row) => row.name)).toEqual(
          MIGRATIONS.map((migration) => migration.name)
        );
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'checkpoint_episodes'"
            )
            .get()
        ).toEqual({ name: 'checkpoint_episodes' });
        const inboxColumns = db.prepare('PRAGMA table_info(session_inbox)').all() as Array<{
          name: string;
        }>;
        expect(inboxColumns.map((column) => column.name)).toContain('receipt_state');
        expect(inboxColumns.map((column) => column.name)).toContain('next_attempt_at');
        const idleCleanupColumns = db
          .prepare('PRAGMA table_info(idle_cleanup_schedule)')
          .all() as Array<{ name: string }>;
        expect(idleCleanupColumns.map((column) => column.name)).toEqual(
          expect.arrayContaining([
            'terminal_state',
            'terminal_reason',
            'terminal_at',
            'last_error',
            'failure_notified_at',
            'attention_marker_id',
          ])
        );
        const sessionStateColumns = db.prepare('PRAGMA table_info(session_state)').all() as Array<{
          name: string;
        }>;
        expect(sessionStateColumns.map((column) => column.name)).toEqual(
          expect.arrayContaining([
            'runtime_work_state',
            'runtime_work_count',
            'runtime_work_source',
            'runtime_work_updated_at',
            'runtime_work_progress_at',
          ])
        );
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_wait_subscriptions'"
            )
            .get()
        ).toEqual({ name: 'task_wait_subscriptions' });
      } finally {
        db.close();
      }
    });

    it('upgrades a migration-025 database without replacing ProjectData parent tables', () => {
      const db = new Database(':memory:');
      try {
        const sql = createSqlStorage(db);
        sql.exec(`CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
        const promptDeliveryMigrationIndex = MIGRATIONS.findIndex(
          (migration) => migration.name === '027-durable-prompt-delivery-checkpoints'
        );
        expect(promptDeliveryMigrationIndex).toBeGreaterThan(0);
        for (const migration of MIGRATIONS.slice(0, promptDeliveryMigrationIndex)) {
          migration.run(sql);
          sql.exec('INSERT INTO migrations (name, applied_at) VALUES (?, ?)', migration.name, 1);
        }
        sql.exec(
          `INSERT INTO chat_sessions
           (id, topic, status, message_count, started_at, created_at, updated_at)
           VALUES ('chat-upgrade', 'Existing', 'active', 0, 1, 1, 1)`
        );
        sql.exec(
          `INSERT INTO session_state
           (session_id, activity, activity_at, prompt_started_at, restart_count)
           VALUES ('acp-upgrade', 'prompting', 2, 1, 0)`
        );
        sql.exec(
          `INSERT INTO session_inbox
           (id, target_session_id, message_type, content, priority, created_at,
            message_class, delivery_state, sender_type, ack_required, delivery_attempts,
            expires_at)
           VALUES ('mail-upgrade', 'chat-upgrade', 'deliver', 'existing', 'high', 2,
                   'deliver', 'queued', 'agent', 1, 0, 60002)`
        );

        runMigrations(sql);

        expect(
          db
            .prepare(
              "SELECT content, prompt_message_id, next_attempt_at FROM session_inbox WHERE id = 'mail-upgrade'"
            )
            .get()
        ).toEqual({
          content: 'existing',
          prompt_message_id: 'mail-upgrade',
          next_attempt_at: 2,
        });
        expect(
          db
            .prepare(
              "SELECT prompt_started_at, prompt_epoch FROM session_state WHERE session_id = 'acp-upgrade'"
            )
            .get()
        ).toEqual({
          prompt_started_at: 1,
          prompt_epoch: null,
        });
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM chat_sessions WHERE id = 'chat-upgrade'").get()
        ).toEqual({ count: 1 });
        expect(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_wait_children'"
            )
            .get()
        ).toEqual({ name: 'task_wait_children' });
      } finally {
        db.close();
      }
    });

    it('upgrades the originally recorded base task-wait shape additively', () => {
      const db = new Database(':memory:');
      try {
        const sql = createSqlStorage(db);
        sql.exec(`CREATE TABLE migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
        const hardeningIndex = MIGRATIONS.findIndex(
          (migration) => migration.name === '031-task-wait-replay-hardening'
        );
        expect(hardeningIndex).toBeGreaterThan(0);
        for (const migration of MIGRATIONS.slice(0, hardeningIndex)) {
          migration.run(sql);
          sql.exec('INSERT INTO migrations (name, applied_at) VALUES (?, ?)', migration.name, 1);
        }
        sql.exec(
          `INSERT INTO task_wait_subscriptions
           (id, parent_task_id, parent_session_id, wait_condition, state, child_count,
            wake_deadline, next_reconcile_at, wake_delivery_id, created_at, updated_at)
           VALUES ('wait-legacy', 'parent-1', 'chat-1', 'all', 'active', 1,
                   10000, 9000, 'wake-legacy', 1, 1)`
        );

        runMigrations(sql);

        const columns = db.prepare('PRAGMA table_info(task_wait_subscriptions)').all() as Array<{
          name: string;
        }>;
        expect(columns.map((column) => column.name)).toEqual(
          expect.arrayContaining(['idempotency_key', 'wake_content', 'wake_attempts'])
        );
        expect(
          db
            .prepare(
              `SELECT idempotency_key, wake_content, wake_attempts
               FROM task_wait_subscriptions WHERE id = 'wait-legacy'`
            )
            .get()
        ).toEqual({
          idempotency_key: 'legacy-wait-legacy',
          wake_content: null,
          wake_attempts: 0,
        });
      } finally {
        db.close();
      }
    });
  });

  describe('001-initial-schema migration', () => {
    it('creates chat_sessions table', () => {
      const sql = new MockSqlStorage();
      runMigrations(sql as unknown as SqlStorage);

      const log = sql.getExecLog();
      const createStatements = log.filter((q) =>
        q.toUpperCase().includes('CREATE TABLE CHAT_SESSIONS')
      );
      expect(createStatements.length).toBe(1);
    });

    it('creates chat_messages table', () => {
      const sql = new MockSqlStorage();
      runMigrations(sql as unknown as SqlStorage);

      const log = sql.getExecLog();
      const createStatements = log.filter((q) => {
        const upper = q.toUpperCase();
        // Match "CREATE TABLE chat_messages" but not "CREATE TABLE chat_messages_grouped"
        return (
          upper.includes('CREATE TABLE CHAT_MESSAGES') && !upper.includes('CHAT_MESSAGES_GROUPED')
        );
      });
      expect(createStatements.length).toBe(1);
    });

    it('creates task_status_events table', () => {
      const sql = new MockSqlStorage();
      runMigrations(sql as unknown as SqlStorage);

      const log = sql.getExecLog();
      const createStatements = log.filter((q) =>
        q.toUpperCase().includes('CREATE TABLE TASK_STATUS_EVENTS')
      );
      expect(createStatements.length).toBe(1);
    });

    it('creates activity_events table', () => {
      const sql = new MockSqlStorage();
      runMigrations(sql as unknown as SqlStorage);

      const log = sql.getExecLog();
      const createStatements = log.filter((q) =>
        q.toUpperCase().includes('CREATE TABLE ACTIVITY_EVENTS')
      );
      expect(createStatements.length).toBe(1);
    });

    it('creates all expected indexes', () => {
      const sql = new MockSqlStorage();
      runMigrations(sql as unknown as SqlStorage);

      const log = sql.getExecLog();
      const indexes = log.filter((q) => q.toUpperCase().startsWith('CREATE INDEX'));

      // 19 CREATE INDEX statements total (migration 007 drops session_created
      // and creates session_seq, but DROP INDEX doesn't count here):
      // chat_sessions: 3 (status, started_at, workspace) + 1 (task_id from 002) + 1 (updated_at from 009)
      // chat_messages: 1 (session_created from 001) + 1 (session_seq from 007)
      // chat_messages_grouped: 1 (session from 011)
      // chat_session_ideas: 1 (task from 012)
      // task_status_events: 1 (task)
      // activity_events: 2 (created, type)
      // idle_cleanup_schedule: 1 (cleanup_at from migration 005)
      // acp_sessions: 5 (chat, workspace, node, parent, status) from migration 008
      // acp_session_events: 1 (session+created) from migration 008
      // chat_messages: 1 (user content dedup) from migration 014
      // session_inbox: 1 (pending messages) from migration 015
      // knowledge_entities: 2 (entity_type, updated_at) from migration 016
      // knowledge_observations: 3 (entity_id+active, source_type, last_confirmed) from migration 016
      // knowledge_relations: 1 (source_entity, target_entity combined) from migration 016
      // session_inbox: 3 (delivery_sweep, target_state, expires) from migration 017
      // mission_state_entries: 2 (mission_id, type) from migration 018
      // handoff_packets: 3 (mission_id, from_task_id, to_task_id) from migration 018
      // project_policies: 2 (active, category+active) from migration 019
      // session_attention_markers: 2 (active, expiry) from migration 020
      // activity_events: 1 (session_id, created_at partial) from migration 022
      // chat_sessions: 1 (created_by_user_id) from migration 023
      // session_attention_markers: 1 (next_escalation_at partial) from migration 026
      // delivery-aware attention expiry: 1 from migration 026
      // session_inbox: 2 (durable delivery due + claims) from migration 027
      // checkpoint_episodes: 2 (session + state) from migration 027
      // idle_cleanup_schedule: 2 (active cleanup_at + terminal marker) from migration 028
      // session_state: 1 (working-activity staleness scan) from migration 029
      // durable task waits: 2 (due + child) from migration 030; the
      // active-parent (030) and idempotency (031) indexes are CREATE UNIQUE
      // INDEX and are counted separately
      // message-anchored comments: 6 from migration 032
      expect(indexes.length).toBe(57);
    });
  });
});
