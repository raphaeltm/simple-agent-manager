-- The Project Overview's "Recently" lists a project's most recently merged pull requests
-- (`projectOverviewGet`, packages/operations/src/project-overview.ts):
--   WHERE project_id = ? AND state = 'merged' ORDER BY merged_at DESC LIMIT ?
-- Without this index the only usable prefix is (project_id, repository, number), so every read
-- visited and sorted the project's whole pull request history to keep three rows.
--
-- Additive only: a new index on an existing table. Numbered 0246 to stay clear of 0242-0245
-- proposed by open PRs #2721, #2772 and #2776.
CREATE INDEX IF NOT EXISTS idx_pull_requests_project_state_merged
  ON pull_requests (project_id, state, merged_at);
