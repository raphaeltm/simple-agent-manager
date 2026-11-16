-- Inbox asks (idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9, slice A).
--
-- One row per ask an agent (or SAM) files for a person that has no older home: reviews, human
-- tasks, errors and, from slice G, questions. Questions, permissions, secret requests and
-- Operations approvals keep their current stores; the inbox list reads them in place
-- (`packages/operations/src/inbox-list-core.ts`), so nothing here copies them.
--
-- Routing: assignee_kind 'user' names assignee_user_id; 'team' is any active member of the
-- project, claimable through claimed_by_user_id. status is validated in the application (no
-- CHECK), so a later status needs no table rebuild. Every status change is a compare-and-set
-- on the previous status with project_id in the predicate (`apps/api/src/services/inbox/`).
--
-- notified_at: when the filing agent's notice that the ask closed (answered, done, archived,
-- expired) was queued. NULL on a closed row means a cron sweep retries it for a bounded window,
-- the pattern runtime_secret_requests.notified_at uses.
--
-- session_summaries gains a partial index for the inbox's question read (chats a person created
-- that hold an open attention marker), so the read does not walk the person's whole chat history.
--
-- Additive only: one new table with no FK children and one new index. Numbered 0245 to stay clear of 0242/0243
-- proposed by open PRs (#2721, #2753, #2772, #2691).
CREATE TABLE asks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  assignee_kind TEXT NOT NULL DEFAULT 'user',
  assignee_user_id TEXT,
  claimed_by_user_id TEXT,
  kind TEXT NOT NULL,
  blocking INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  body_md TEXT,
  answer_spec_json TEXT,
  steps_json TEXT,
  links_json TEXT,
  due_hint TEXT,
  due_at INTEGER,
  source_session_id TEXT,
  source_task_id TEXT,
  source_message_id TEXT,
  agent_profile_id TEXT,
  group_key TEXT,
  dedupe_key TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  answer_json TEXT,
  resolved_by_user_id TEXT,
  resolved_at INTEGER,
  expires_at INTEGER,
  notified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- My open items across projects.
CREATE INDEX idx_asks_assignee_status ON asks (assignee_user_id, status, created_at);
-- A project's open items (team items and per-project lists).
CREATE INDEX idx_asks_project_status ON asks (project_id, status, created_at);
-- A chat's open items (stacking, per-chat cap).
CREATE INDEX idx_asks_session_status ON asks (source_session_id, status);
-- Expiry sweep.
CREATE INDEX idx_asks_open_expiry ON asks (expires_at) WHERE status = 'open' AND expires_at IS NOT NULL;
-- Undelivered notices.
CREATE INDEX idx_asks_unnotified ON asks (resolved_at) WHERE notified_at IS NULL AND status IN ('answered', 'done', 'archived', 'expired');
-- One open-or-closed row per dedupe key per project, when a key is set.
CREATE UNIQUE INDEX idx_asks_project_dedupe ON asks (project_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- The inbox reads open questions per (project, creator); only rows holding a marker are indexed.
CREATE INDEX idx_session_summaries_open_attention
  ON session_summaries (project_id, created_by_user_id) WHERE attention_json IS NOT NULL;
