import { describe, expect, it } from 'vitest';
import { MIGRATIONS, runMigrations } from '../../../src/durable-objects/migrations';

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
      const createStatements = log.filter((q) =>
        q.toUpperCase().includes('CREATE TABLE CHAT_MESSAGES')
      );
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

      // 9 indexes total:
      // chat_sessions: 3 (status, started_at, workspace) + 1 (task_id from migration 002)
      // chat_messages: 1 (session_created)
      // task_status_events: 1 (task)
      // activity_events: 2 (created, type)
      // idle_cleanup_schedule: 1 (cleanup_at from migration 005)
      expect(indexes.length).toBe(9);
    });
  });
});
