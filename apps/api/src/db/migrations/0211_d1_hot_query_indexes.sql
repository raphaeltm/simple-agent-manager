-- Additive only: retain every lifecycle row, FK child, snapshot and archive proof.
-- The global active-task keyset has no project predicate; project-first indexes scan.
CREATE INDEX IF NOT EXISTS idx_tasks_active_updated_id
  ON tasks(updated_at, id)
  WHERE status IN ('queued', 'delegated', 'in_progress');

-- Wide session metadata pages otherwise choose a project-wide scan over the
-- single-column unique chat index. Also retains project isolation in the lookup.
CREATE INDEX IF NOT EXISTS idx_tasks_project_chat_session
  ON tasks(project_id, chat_session_id)
  WHERE chat_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_node_project_status
  ON workspaces(node_id, project_id, status, id);

-- Rank before correlated eligibility checks. Partial predicate matches both selectors.
CREATE INDEX IF NOT EXISTS idx_session_summaries_archive_rank
  ON session_summaries(message_count DESC, updated_at, id, project_id, ended_at)
  WHERE status IN ('stopped', 'failed') AND ended_at IS NOT NULL;

-- Probe ONE session's recent refusals, not every frozen journal in its project.
CREATE INDEX IF NOT EXISTS idx_archive_migrations_session_refusal
  ON project_data_archive_migrations(project_id, session_id, state, error_code, updated_at);
