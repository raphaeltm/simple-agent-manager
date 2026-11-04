-- Server-side approval records for Operations-project actions (idea 01M6GGY1QPGG4D40HG0PVGQS3R).
-- An agent requests an action with ops_request_action; a superadmin approves or denies it in
-- the admin UI; the agent then runs it once with ops_execute_action. The single-use guarantee is
-- one compare-and-set UPDATE (approved -> executed) whose WHERE clause carries every guard.
--
-- Additive. No foreign keys on purpose: like operations_audit_log, the record must outlive the
-- task, user and target it names. Decided and executed rows are purged daily after
-- operations.actionApprovalRetentionDays.
CREATE TABLE operations_action_approvals (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_summary TEXT,
  target_summary_json TEXT,
  requesting_project_id TEXT NOT NULL,
  requesting_task_id TEXT NOT NULL,
  -- The task's stable source-task authority (recovery_source_task_id ?? id): a session woken
  -- from sleep runs under a successor task, which must still be able to execute its own approval.
  requesting_authority_task_id TEXT NOT NULL,
  requesting_session_id TEXT,
  requester_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired', 'executed')),
  auto_approved INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT,
  executed_at TEXT,
  execution_result_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_operations_action_approvals_status_created
  ON operations_action_approvals(status, created_at);
CREATE INDEX idx_operations_action_approvals_task
  ON operations_action_approvals(requesting_task_id, created_at);
CREATE INDEX idx_operations_action_approvals_created
  ON operations_action_approvals(created_at);
