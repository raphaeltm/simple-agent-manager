-- Session lists order by actual message activity, falling back to the stable
-- session creation/start timestamp for empty sessions. Keep the activity-key
-- reads indexed so larger projects do not need a temporary sort on every page.
CREATE INDEX IF NOT EXISTS idx_session_summaries_project_activity
  ON session_summaries(
    project_id,
    COALESCE(last_message_at, created_at, started_at) DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_session_summaries_project_creator_activity
  ON session_summaries(
    project_id,
    created_by_user_id,
    COALESCE(last_message_at, created_at, started_at) DESC,
    id DESC
  );

CREATE INDEX IF NOT EXISTS idx_session_summaries_user_activity
  ON session_summaries(
    user_id,
    COALESCE(last_message_at, created_at, started_at) DESC,
    id DESC
  );
