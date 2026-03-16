import { describe, expect, it } from 'vitest';
import { NOTIFICATION_MIGRATIONS, runNotificationMigrations } from '../../../src/durable-objects/notification-migrations';

/**
 * In-memory mock of SqlStorage for testing notification migration logic.
 */
class MockSqlStorage {
  private tables = new Map<string, Record<string, unknown>[]>();
  private execLog: string[] = [];

  exec(query: string, ...params: unknown[]): { toArray: () => Record<string, unknown>[] } {
    this.execLog.push(query.trim());

    const normalized = query.trim().toUpperCase();

    if (normalized.startsWith('CREATE TABLE IF NOT EXISTS MIGRATIONS')) {
      if (!this.tables.has('migrations')) {
        this.tables.set('migrations', []);
      }
      return { toArray: () => [] };
    }

    if (normalized.startsWith('CREATE TABLE') || normalized.startsWith('CREATE INDEX')) {
      const tableMatch = query.match(/CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i);
      if (tableMatch) {
        this.tables.set(tableMatch[1]!, []);
      }
      return { toArray: () => [] };
    }

    if (normalized.includes('SELECT NAME FROM MIGRATIONS')) {
      const rows = this.tables.get('migrations') || [];
      return { toArray: () => rows };
    }

    if (normalized.startsWith('INSERT INTO MIGRATIONS')) {
      const rows = this.tables.get('migrations') || [];
      rows.push({ name: params[0] as string, applied_at: params[1] as number });
      return { toArray: () => [] };
    }

    return { toArray: () => [] };
  }

  getExecLog(): string[] {
    return this.execLog;
  }

  getMigrationsTable(): Record<string, unknown>[] {
    return this.tables.get('migrations') || [];
  }
}

describe('Notification DO Migrations', () => {
  it('should have at least one migration', () => {
    expect(NOTIFICATION_MIGRATIONS.length).toBeGreaterThan(0);
  });

  it('should have unique migration names', () => {
    const names = NOTIFICATION_MIGRATIONS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('should run all migrations on a fresh database', () => {
    const sql = new MockSqlStorage();
    runNotificationMigrations(sql as any);

    const applied = sql.getMigrationsTable();
    expect(applied.length).toBe(NOTIFICATION_MIGRATIONS.length);
    expect(applied[0]?.name).toBe('001-initial-schema');
  });

  it('should skip already-applied migrations', () => {
    const sql = new MockSqlStorage();

    // Run once
    runNotificationMigrations(sql as any);
    const firstRunLog = sql.getExecLog().length;

    // Run again — should be fewer queries (only checking, not running)
    runNotificationMigrations(sql as any);
    const secondRunLog = sql.getExecLog().length;

    // Second run should add fewer statements than the first
    // (just CREATE TABLE IF NOT EXISTS migrations + SELECT + INSERT INTO migrations tracking)
    expect(secondRunLog - firstRunLog).toBeLessThan(firstRunLog);
  });

  it('001-initial-schema creates notifications and preferences tables', () => {
    const sql = new MockSqlStorage();
    runNotificationMigrations(sql as any);

    const log = sql.getExecLog().join('\n');
    expect(log).toContain('CREATE TABLE notifications');
    expect(log).toContain('CREATE TABLE notification_preferences');
    expect(log).toContain('CREATE INDEX idx_notifications_user_unread');
    expect(log).toContain('CREATE INDEX idx_notifications_user_created');
    expect(log).toContain('CREATE INDEX idx_notifications_type');
  });
});
