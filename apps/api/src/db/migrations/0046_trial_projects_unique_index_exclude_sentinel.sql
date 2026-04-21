-- Exclude the trial-sentinel owner from the (user_id, installation_id, repository)
-- uniqueness invariant so multiple trials can explore the same public repo.
--
-- Context: trial-onboarding-mvp spec provisions one projects row per trial, all
-- owned by the sentinel user `system_anonymous_trials` and the sentinel
-- installation `system_anonymous_trials_installation` (migrations 0043 + 0045).
-- The original `idx_projects_user_installation_repository` unique index was
-- designed for real users (one user + one GitHub installation + one repo = one
-- project). Applied to the sentinel, it permits at most ONE lifetime trial per
-- repository — the second trial on `octocat/Hello-World` hits a UNIQUE
-- constraint failure inside handleProjectCreation and the TrialOrchestrator DO
-- gives up after 6 alarm retries (user sees "Creating your project 10%" repeat
-- then a generic step_failed error).
--
-- Fix: keep the uniqueness invariant for real users (defensive against dup
-- project rows) but carve out the sentinel user explicitly. Trial rows are
-- still isolated by `projectId` (enforced in all trial-aware query paths —
-- see helpers.ts:resolveAnonymousUserId security note).

DROP INDEX IF EXISTS idx_projects_user_installation_repository;

CREATE UNIQUE INDEX idx_projects_user_installation_repository
  ON projects (user_id, installation_id, repository)
  WHERE user_id != 'system_anonymous_trials';
