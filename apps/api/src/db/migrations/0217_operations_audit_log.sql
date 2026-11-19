-- Audit trail for Operations-project debugger tools (idea 01M6GGY1QPGG4D40HG0PVGQS3R,
-- policy a35180d5): one row per call, kept for `operations.auditRetentionDays` and
-- purged daily by `purgeExpiredOperationsAudit`.
--
-- No foreign keys on purpose: the row must outlive the actor, task and target it
-- describes, so deleting a user, task, node or workspace never erases the evidence of
-- who reached into it.
CREATE TABLE operations_audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  outcome TEXT NOT NULL,
  detail TEXT,
  approval_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_operations_audit_log_created_at ON operations_audit_log(created_at);
CREATE INDEX idx_operations_audit_log_task ON operations_audit_log(task_id, created_at);
