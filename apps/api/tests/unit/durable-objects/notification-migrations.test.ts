import { describe, expect, it } from 'vitest';

import {
  NOTIFICATION_MIGRATIONS,
  runNotificationMigrations,
  runNotificationMigrationsAtomically,
} from '../../../src/durable-objects/notification-migrations';

/**
 * In-memory mock of SqlStorage for testing notification migration logic.
 */
class MockSqlStorage {
  private tables = new Map<string, Record<string, unknown>[]>();
  private execLog: string[] = [];
  failOn: string | null = null;

  exec(query: string, ...params: unknown[]): { toArray: () => Record<string, unknown>[] } {
    this.execLog.push(query.trim());

    if (this.failOn && query.includes(this.failOn)) {
      throw new Error('injected migration failure');
    }

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

  hasTable(name: string): boolean {
    return this.tables.has(name);
  }

  snapshot(): Map<string, Record<string, unknown>[]> {
    return structuredClone(this.tables);
  }

  restore(snapshot: Map<string, Record<string, unknown>[]>): void {
    this.tables = snapshot;
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
    expect(applied[1]?.name).toBe('002-session-filter-index');
    expect(applied[2]?.name).toBe('003-notification-dedup-claims');
    expect(applied[3]?.name).toBe('004-push-subscriptions');
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
    expect(log).toContain('CREATE INDEX idx_notifications_session_type');
    expect(log).toContain('notifications(user_id, project_id, session_id, type, created_at DESC)');
    expect(log).toContain('CREATE TABLE notification_dedup_claims');
    expect(log).toContain('CREATE TABLE push_subscriptions');
    expect(log).toContain('endpoint TEXT PRIMARY KEY');
    expect(log).toContain('user_agent TEXT');
    expect(log).toContain('ADD COLUMN push_delivered_at INTEGER');
    expect(log).toContain('ADD COLUMN in_app_visible INTEGER NOT NULL DEFAULT 1');
  });

  it('rolls back a partially applied multi-statement upgrade before retry', () => {
    const sql = new MockSqlStorage();
    const storage = {
      sql: sql as unknown as SqlStorage,
      transactionSync<T>(callback: () => T): T {
        const snapshot = sql.snapshot();
        try {
          return callback();
        } catch (error) {
          sql.restore(snapshot);
          throw error;
        }
      },
    };
    sql.failOn = 'ADD COLUMN in_app_visible';

    expect(() => runNotificationMigrationsAtomically(storage)).toThrow(
      'injected migration failure'
    );
    expect(sql.getMigrationsTable().some((row) => row.name === '004-push-subscriptions')).toBe(
      false
    );
    expect(sql.hasTable('push_subscriptions')).toBe(false);

    sql.failOn = null;
    expect(() => runNotificationMigrationsAtomically(storage)).not.toThrow();
    expect(sql.getMigrationsTable().at(-1)?.name).toBe('004-push-subscriptions');
    expect(sql.hasTable('push_subscriptions')).toBe(true);
  });
});
