/**
 * ProjectOrchestrator DO — internal SQLite migrations.
 *
 * Tables:
 *  - orchestrator_missions: active missions tracked by this orchestrator
 *  - scheduling_queue: tasks queued for dispatch
 *  - decision_log: audit trail of orchestrator decisions
 */
export const ORCHESTRATOR_MIGRATIONS = [
  {
    name: '001_initial',
    sql: `
      CREATE TABLE IF NOT EXISTS orchestrator_missions (
        mission_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        last_checked_at INTEGER NOT NULL,
        last_dispatch_at INTEGER,
        registered_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduling_queue (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        dispatched_at INTEGER,
        reason TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_queue_mission ON scheduling_queue(mission_id);
      CREATE INDEX IF NOT EXISTS idx_queue_pending ON scheduling_queue(dispatched_at) WHERE dispatched_at IS NULL;

      CREATE TABLE IF NOT EXISTS decision_log (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        task_id TEXT,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_mission ON decision_log(mission_id);
      CREATE INDEX IF NOT EXISTS idx_decisions_created ON decision_log(created_at);
    `,
  },
] as const;

/**
 * Run pending migrations for the ProjectOrchestrator DO.
 */
export function runOrchestratorMigrations(sql: SqlStorage): void {
  // Create tracking table
  sql.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  for (const migration of ORCHESTRATOR_MIGRATIONS) {
    const applied = sql.exec('SELECT 1 FROM _migrations WHERE name = ?', migration.name).toArray();
    if (applied.length === 0) {
      sql.exec(migration.sql);
      sql.exec('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)', migration.name, Date.now());
    }
  }
}
