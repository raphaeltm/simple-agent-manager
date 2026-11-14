-- ProjectData archive: record in D1 whether a flipped session's root rows are known reclaimed.
--
-- The flip no longer deletes root rows; they are reclaimed afterwards in bounded pages, and a
-- pass at the start of every tick finishes reclaims an earlier tick left unfinished. Without a
-- D1 record of completion that pass had to wake every recently published project's root
-- object (two RPCs each, up to 50 projects) on every tick, only to find nothing pending.
--
-- 1 means "reclaim not confirmed". The default covers every existing row and any row an older
-- coordinator writes during a deploy: the pass visits such a project once, and a complete
-- listing that finds no leftover rows clears the flag. Cleared (0) only after a reclaim is
-- confirmed complete, or after a complete listing of the root object shows nothing pending.
ALTER TABLE project_data_archive_migrations ADD COLUMN reclaim_pending INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_archive_migrations_reclaim_pending
  ON project_data_archive_migrations (project_id, state)
  WHERE reclaim_pending = 1;
