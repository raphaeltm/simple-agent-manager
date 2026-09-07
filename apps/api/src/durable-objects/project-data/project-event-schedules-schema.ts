/** Additive DO migration 049. The parent migration runner owns version tracking. */
export function migrateProjectSchedules(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS project_schedules (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    creator_user_id TEXT NOT NULL,
    creator_chat_session_id TEXT,
    target_session_id TEXT,
    reason TEXT,
    action_json TEXT NOT NULL CHECK (json_valid(action_json)),
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending','processing','admitted','cancelled','expired','failed','ambiguous')),
    due_at INTEGER NOT NULL,
    display_timezone TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    idempotency_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    next_attempt_at INTEGER,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error TEXT,
    event_id TEXT,
    delivery_id TEXT,
    result_task_id TEXT,
    result_session_id TEXT,
    claim_token TEXT,
    claim_until INTEGER,
    watch_id TEXT,
    source_event_id TEXT,
    reserved_task_id TEXT,
    reserved_session_id TEXT,
    reserved_message_id TEXT,
    reserved_status_id TEXT,
    execution_finished_at INTEGER,
    submission_completed_at INTEGER,
    UNIQUE(project_id, creator_user_id, idempotency_key)
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_project_schedules_due
    ON project_schedules(project_id, state, next_attempt_at, id)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_project_schedules_recent
    ON project_schedules(project_id, created_at DESC, id DESC)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_project_schedules_creator_session
    ON project_schedules(project_id, creator_chat_session_id, created_at DESC, id DESC)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_project_schedules_target_session
    ON project_schedules(project_id, target_session_id, created_at DESC, id DESC)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_project_schedules_watch_execution
    ON project_schedules(watch_id, execution_finished_at, id)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_project_schedules_active_capacity
    ON project_schedules(project_id, state, id)
    WHERE execution_finished_at IS NULL AND state IN ('pending','processing','admitted')`);

  sql.exec(`CREATE TABLE IF NOT EXISTS project_standing_watches (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    creator_user_id TEXT NOT NULL,
    reason TEXT,
    filter_json TEXT NOT NULL CHECK (json_valid(filter_json)),
    action_json TEXT NOT NULL CHECK (json_valid(action_json)),
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active','paused','revoked')),
    version INTEGER NOT NULL CHECK (version > 0),
    idempotency_key TEXT NOT NULL,
    cooldown_ms INTEGER NOT NULL CHECK (cooldown_ms > 0),
    max_concurrent INTEGER NOT NULL CHECK (max_concurrent > 0),
    max_executions INTEGER NOT NULL CHECK (max_executions > 0),
    execution_count INTEGER NOT NULL DEFAULT 0 CHECK (execution_count >= 0),
    next_eligible_at INTEGER NOT NULL,
    next_attempt_at INTEGER,
    subscription_id TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_error TEXT,
    UNIQUE(project_id, creator_user_id, idempotency_key)
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_project_standing_watches_due
    ON project_standing_watches(project_id, state, next_eligible_at, id)`);
  sql.exec(`CREATE INDEX IF NOT EXISTS idx_project_standing_watches_recent
    ON project_standing_watches(project_id, created_at DESC, id DESC)`);
}
