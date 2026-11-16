-- Insights slice F (idea 01M7HTS38KX2G78JD0ESAGMKKH): make "CI passed on the first try" and
-- "flaky checks" derivable at read time (`projectFlow`, packages/operations/src/insights-flow.ts).
--
-- Additive only (rule 31): one new table with no foreign keys, one new nullable column.
--
-- 1. pull_request_heads: every head commit SAM saw for a pull request, written by
--    `upsertPullRequestSnapshot` (webhook lifecycle events and GitHub refreshes). `first_seen_at`
--    is GitHub's `updated_at` of the observation that carried the head, so a late delivery cannot
--    move it later. `from_open` is 1 when SAM had no earlier head for the pull request when it
--    recorded this one: SAM saw the pull request from its first commit. Pull requests that existed
--    before this migration never get a `from_open` row, so their first try reads "not recorded"
--    rather than being estimated from a later head.
--    Existing rows: none are backfilled; there is no history to backfill from (old heads' check rows
--    were already deleted). Nothing that worked before depends on this table.
--
-- 2. pull_request_checks.first_failed_at: when this check first reported a failure on this commit.
--    Never cleared, so a failed check that passes on a rerun keeps the evidence. NULL on every
--    existing row (no failure history was kept), which reads as "no failure recorded".
CREATE TABLE IF NOT EXISTS pull_request_heads (
  project_id TEXT NOT NULL,
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
