-- Inbox slice H1 (ideas 01M7G03ZCQ6TM6CMEYDRKQ8ST9, 01M6MFVAJF20DZK8NJ97VAXC7A): human tasks.
--
-- A human task is one `asks` row of kind 'task'. Two additions:
--   asks.steps_checked_json  JSON array of the indexes of steps the person ticked. steps_json
--                            keeps the agent's step texts unchanged; NULL means none ticked.
--   ask_activity             one lifecycle row per change (created, step ticked, claimed,
--                            reassigned, done, reopened, archived, cancelled, commented). It
--                            holds no discussion text: discussion is the anchored comment core
--                            in the project's Durable Object (anchor kind inbox_item).
--
-- Additive only: one nullable column and one new table whose parent is asks (ON DELETE
-- CASCADE: activity has no meaning without its ask, and asks itself cascades from projects).
-- Existing rows keep NULL and read as "no step ticked"; nothing else changes for them.
ALTER TABLE asks ADD COLUMN steps_checked_json TEXT;

CREATE TABLE ask_activity (
  id TEXT PRIMARY KEY,
  ask_id TEXT NOT NULL REFERENCES asks(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  kind TEXT NOT NULL,
  detail_json TEXT,
  created_at INTEGER NOT NULL
);

-- A task's activity in order (the task view and inbox_read get).
CREATE INDEX idx_ask_activity_ask_created ON ask_activity (ask_id, created_at, id);
