-- Inbox slice I (idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9, section 4.3): the generated brief on the
-- Project Overview. One row per project, the only home of the brief (no copies).
--   Writer: refreshProjectBriefIfDue() (apps/api/src/services/project-brief/refresh.ts).
--   Reader: readProjectBrief() (packages/operations/src/project-brief-read.ts), one statement in
--           the Overview's aggregated read.
-- It lives in D1 beside the Overview's other reads because it is read per project with them, and
-- every fact it is built from is in D1.
--
-- brief_json is NULL when the project was quiet at the last check (nothing to say). The ref_*
-- columns list the asks, running chats, automations and accounts the brief names, so the read can
-- drop a claim that is no longer true (or no longer visible to every member). Times are epoch milliseconds. generation_day/count is the
-- per-UTC-day generation budget (a daily cap by design: it resets on a new day, not on success).
--
-- Additive only (rule 31): a new table and two indexes. Deleting a project deletes its brief (it
-- has no meaning without the project and nothing references it).
CREATE TABLE IF NOT EXISTS project_briefs (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  brief_json TEXT,
  ref_asks_json TEXT NOT NULL DEFAULT '[]',
  ref_chats_json TEXT NOT NULL DEFAULT '[]',
  ref_automations_json TEXT NOT NULL DEFAULT '[]',
  ref_accounts_json TEXT NOT NULL DEFAULT '[]',
  fingerprint TEXT,
  generated_at INTEGER,
  checked_at INTEGER,
  stale INTEGER NOT NULL DEFAULT 0,
  pending_since INTEGER,
  generation_day TEXT,
  generation_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_at INTEGER,
  updated_at INTEGER NOT NULL
);

-- The brief's facts read each trigger's newest finished runs and a project's failed tasks' chats
-- on every check (readBriefFacts, packages/operations/src/project-brief-facts.ts). Without these,
-- the first walks and sorts every execution of every trigger (90 days of history), and the second
-- walks the project's whole chat history.
CREATE INDEX IF NOT EXISTS idx_trigger_executions_trigger_sequence
  ON trigger_executions(trigger_id, sequence_number, created_at);
CREATE INDEX IF NOT EXISTS idx_session_summaries_task
  ON session_summaries(task_id);
