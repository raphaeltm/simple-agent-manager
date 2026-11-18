-- The chat sidebar also reads every awake and sleeping session in scope, ranked by
-- activity within each status (`include=live`, session-summary-index.ts). Index that
-- shape so it seeks the project's rows of one status instead of scanning all of them.
CREATE INDEX IF NOT EXISTS idx_session_summaries_project_status_activity
  ON session_summaries(
    project_id,
    status,
    COALESCE(last_message_at, created_at, started_at) DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_session_summaries_project_creator_status_activity
  ON session_summaries(
    project_id,
    created_by_user_id,
    status,
    COALESCE(last_message_at, created_at, started_at) DESC,
    id DESC
  );
