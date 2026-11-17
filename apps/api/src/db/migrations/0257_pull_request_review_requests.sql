-- Insights slice P (idea 01M7HTS38KX2G78JD0ESAGMKKH): "review pickup time" on Insights · People,
-- the time from a review being requested to the first review, per project (`projectPeople`,
-- packages/operations/src/insights-people.ts). Nothing stored it: `pull_requests` is one row per
-- pull request and `pull_request_heads` one row per head commit, and a pull request can ask several
-- reviewers, more than once.
--
-- Additive only (rule 31): one new table. It is a CASCADE child of projects (its rows mean nothing
-- without the project, like pull_request_heads) and nothing references it, so it is not a parent.
--
-- pull_request_review_requests: one row per request cycle, written by the GitHub webhook ingest
-- (`apps/api/src/services/github-pull-request-reviews.ts`):
--   - `pull_request.review_requested` opens a cycle for that reviewer unless one is already open.
--     `requested_at` is GitHub's `pull_request.updated_at` from that delivery, so a redelivery
--     cannot move it.
--   - `pull_request.review_request_removed` stamps `removed_at` on the open cycle (not a pickup).
--   - `pull_request_review.submitted` stamps `first_review_at` on the reviewer's open user cycle and
--     on the pull request's open team cycles.
-- `reviewer_kind` is 'user' (a GitHub login) or 'team' (a team slug); `reviewer_key` is lowercase.
-- The key exists only to match a review to its request. Insights reports per project, never per
-- reviewer.
-- Existing rows: none. Requests made before this deploy were never recorded, and Insights says so
-- ("not recorded") rather than estimating them.
CREATE TABLE IF NOT EXISTS pull_request_review_requests (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  reviewer_kind TEXT NOT NULL CHECK (reviewer_kind IN ('user', 'team')),
  reviewer_key TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  first_review_at TEXT,
  removed_at TEXT,
  PRIMARY KEY (project_id, repository, pr_number, reviewer_kind, reviewer_key, requested_at)
);

-- Insights reads a project's cycles requested in a range, newest first.
CREATE INDEX IF NOT EXISTS idx_pull_request_review_requests_project_requested
  ON pull_request_review_requests (project_id, requested_at);
