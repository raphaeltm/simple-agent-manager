-- Explicit, append-only ownership evidence. Task IDs are historical identifiers,
-- retained after explicit task deletion so cleanup cannot silently clear a hold.
-- Explicit project deletion removes its evidence. Task completion is unchanged.
CREATE TABLE task_pull_request_associations (
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pr_url TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('owned', 'held')),
  reason TEXT NOT NULL,
  previous_task_id TEXT,
  recorded_by_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, pr_url)
);
CREATE INDEX idx_task_pr_associations_project_url ON task_pull_request_associations(project_id, pr_url);
