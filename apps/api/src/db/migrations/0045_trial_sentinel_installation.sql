-- Trial sentinel GitHub installation (spec: trial-onboarding-mvp).
--
-- `projects.installation_id` is NOT NULL and FKs into `github_installations`
-- with ON DELETE CASCADE. Anonymous trial projects own no real GitHub App
-- installation, so we seed a sentinel row that lets the FK pass while making
-- its "system-ness" explicit via the account_type / account_name values.
--
-- The sentinel id is a well-known constant referenced by the TrialOrchestrator
-- DO (see apps/api/src/durable-objects/trial-orchestrator/). The id is also
-- override-able via TRIAL_ANONYMOUS_INSTALLATION_ID env var — if operators
-- choose to override, they are responsible for seeding the target row.

INSERT INTO github_installations (
  id,
  user_id,
  installation_id,
  account_type,
  account_name
)
VALUES (
  'system_anonymous_trials_installation',
  'system_anonymous_trials',
  '0',
  'User',
  'anonymous-trials'
)
ON CONFLICT(id) DO NOTHING;
