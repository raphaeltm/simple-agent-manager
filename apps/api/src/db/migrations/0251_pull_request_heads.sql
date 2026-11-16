-- Insights slice F (idea 01M7HTS38KX2G78JD0ESAGMKKH): make "CI passed on the first try" and
-- "flaky checks" derivable at read time (`projectFlow`, packages/operations/src/insights-flow.ts).
--
-- Additive only (rule 31): one new table, one new nullable column. Nothing references the new
-- table, so it is not a CASCADE parent.
--
-- 1. pull_request_heads: every head commit SAM saw for a pull request, written by
--    `upsertPullRequestSnapshot` (webhook lifecycle events and GitHub refreshes). `first_seen_at`
--    is GitHub's `updated_at` of the observation that carried the head, so a late delivery cannot
--    move it later. `from_open` is 1 only for the head GitHub's `pull_request.opened` event carried:
--    the commit the pull request opened with. Pull requests opened before this migration (or whose
--    `opened` event SAM missed) never get a `from_open` row, so their first try reads "not
--    recorded" rather than being estimated from a later head. One small row per push; deleted with
--    the project (ON DELETE CASCADE, like pull_requests).
--    Existing rows: none are backfilled; there is no history to backfill from (old heads' check rows
--    were already deleted). Nothing that worked before depends on this table.
--
-- 2. pull_request_checks.first_failed_at: when this check first reported a failure on this commit.
--    Never cleared, so a failed check that passes on a rerun keeps the evidence. NULL on every
--    existing row (no failure history was kept), which reads as "no failure recorded".
CREATE TABLE IF NOT EXISTS pull_request_heads (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  from_open INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, repository, pr_number, head_sha)
);

-- Old-head check deletes ask "is this commit a recorded head of some pull request?".
CREATE INDEX IF NOT EXISTS idx_pull_request_heads_project_repo_head
  ON pull_request_heads (project_id, repository, head_sha);

ALTER TABLE pull_request_checks ADD COLUMN first_failed_at TEXT;
