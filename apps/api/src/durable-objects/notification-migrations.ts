/**
 * Notification Durable Object SQLite migration runner.
 *
 * Separate from the ProjectData migrations since the Notification DO
 * is a different Durable Object class with its own SQLite database.
 *
 * Each user's Notification DO maintains its own SQLite database.
 * Migrations are tracked in a `migrations` table and run lazily
 * in the constructor via `blockConcurrencyWhile()`.
 */

export interface NotificationMigration {
  name: string;
  run: (sql: SqlStorage) => void;
}

export const NOTIFICATION_MIGRATIONS: NotificationMigration[] = [
  {
    name: '001-initial-schema',
    run: (sql) => {
      // Core notifications table
      sql.exec(`
        CREATE TABLE notifications (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          project_id TEXT,
          task_id TEXT,
          session_id TEXT,
          type TEXT NOT NULL,
          urgency TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT,
          action_url TEXT,
          metadata TEXT,
          read_at INTEGER,
          dismissed_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
        )
      `);
      sql.exec(
        `CREATE INDEX idx_notifications_user_unread ON notifications(user_id, created_at DESC) WHERE read_at IS NULL AND dismissed_at IS NULL`
      );
      sql.exec(
        `CREATE INDEX idx_notifications_user_created ON notifications(user_id, created_at DESC)`
      );
      sql.exec(
        `CREATE INDEX idx_notifications_type ON notifications(user_id, type, created_at DESC)`
      );
      sql.exec(
        `CREATE INDEX idx_notifications_task ON notifications(user_id, type, task_id, created_at DESC)`
      );

      // User notification preferences
      // Use empty string '' instead of NULL for global (no project) preferences
      // to allow a simple UNIQUE constraint without expressions
      sql.exec(`
        CREATE TABLE notification_preferences (
          user_id TEXT NOT NULL,
          notification_type TEXT NOT NULL,
          project_id TEXT NOT NULL DEFAULT '',
          channel TEXT NOT NULL DEFAULT 'in_app',
          enabled INTEGER NOT NULL DEFAULT 1,
          UNIQUE (user_id, notification_type, project_id, channel)
        )
      `);
    },
  },
];

/**
 * Run pending notification migrations inside a transaction.
 * Call this from `blockConcurrencyWhile()` in the DO constructor.
 */
export function runNotificationMigrations(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set<string>();
  const rows = sql.exec('SELECT name FROM migrations').toArray();
  for (const row of rows) {
    applied.add(row.name as string);
  }

  for (const migration of NOTIFICATION_MIGRATIONS) {
    if (!applied.has(migration.name)) {
      migration.run(sql);
      sql.exec(
        'INSERT INTO migrations (name, applied_at) VALUES (?, ?)',
        migration.name,
        Date.now()
      );
    }
  }
}
