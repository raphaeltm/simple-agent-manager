-- Inbox slice E (idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9): SAM files system error items as `asks` rows
-- of kind 'error', one per failing thing (dedupe_key error:<source>:<id>), updated in place on a
-- repeat failure (`packages/operations/src/inbox-error-core.ts`).
--
--   failure_count  times the thing failed while its item was open. Default 1: the filing
--                  failure. Read only for kind 'error'; every other row keeps the default and
--                  the API reports null for it.
--
-- Failed tasks are found by a cron step that scans recently failed tasks
-- (`apps/api/src/services/inbox/system-error-sweep.ts`); the partial index keeps that scan to the
-- failed rows of the lookback window.
--
-- Two partial indexes on asks keep that step off the rest of the table: error items by task
-- (has this failure been filed?) and error items still holding a dedupe key (which ones can
-- still be closed by recovery).
--
-- Failing automations are found the same way, from recently failed runs.
--
-- Additive only: one column with a default and four partial indexes. Existing rows are unaffected.
ALTER TABLE asks ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_tasks_failed_updated ON tasks (updated_at) WHERE status = 'failed';

CREATE INDEX idx_asks_error_task ON asks (source_task_id, created_at) WHERE kind = 'error';

CREATE INDEX idx_asks_error_key ON asks (dedupe_key) WHERE kind = 'error' AND dedupe_key IS NOT NULL;

CREATE INDEX idx_trigger_executions_failed_completed ON trigger_executions (completed_at)
  WHERE status = 'failed';
