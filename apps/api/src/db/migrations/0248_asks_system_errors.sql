-- Inbox slice E (idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9): SAM files system error items as `asks` rows
-- of kind 'error', one per failing thing (dedupe_key error:<source>:<id>), updated in place on a
-- repeat failure (`packages/operations/src/inbox-error-core.ts`).
--
--   failure_count  times the thing failed while its item was open. Default 1: the filing
--                  failure. Read only for kind 'error'; every other row keeps the default and
--                  the API reports null for it.
--
-- Failed tasks are found by a cron step that scans recently failed tasks
-- (`apps/api/src/services/inbox/system-errors.ts`, `automation-errors.ts`); the partial index keeps that scan to the
-- failed rows of the lookback window.
--
-- Two partial indexes on asks keep that step off the rest of the table: error items by task
-- (has this failure been filed?) and error items still holding a dedupe key (which ones can
-- still be closed by recovery).
--
-- Failing automations are found the same way, from recently failed runs; an automation item
-- closes when its newest finished run (one seek on (trigger_id, sequence_number) over finished
-- runs) is no longer a failure.
--
-- A failed chat wake is an open error item (dedupe key error:wake:<sessionId>) instead of a
-- ProjectData wake_failed attention marker; the chat list reads it by its exact dedupe key on the
-- existing unique (project_id, dedupe_key) index (`packages/worker-core/src/question-asks.ts`).
--
-- Additive only: one column with a default and five partial indexes. Existing rows are unaffected.
ALTER TABLE asks ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 1;

CREATE INDEX idx_tasks_failed_updated ON tasks (updated_at) WHERE status = 'failed';

CREATE INDEX idx_asks_error_task ON asks (source_task_id, created_at) WHERE kind = 'error';

CREATE INDEX idx_asks_error_key ON asks (dedupe_key) WHERE kind = 'error' AND dedupe_key IS NOT NULL;

CREATE INDEX idx_trigger_executions_failed_completed ON trigger_executions (completed_at)
  WHERE status = 'failed';

CREATE INDEX idx_trigger_executions_trigger_finished ON trigger_executions (trigger_id, sequence_number)
  WHERE status IN ('completed', 'failed');
