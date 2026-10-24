-- An idea is a tasks row nobody has handed to an agent yet. Until now the only way to
-- recognise one was `status = 'draft'`, which the Ideas redesign breaks: "Mark done" moves an
-- idea to `completed` and "Park" to `cancelled`, and at that moment the row became
-- indistinguishable from an ordinary finished task and disappeared from Ideas entirely.
--
-- The backfill is exactly the old definition, so it loses nothing: every row that Ideas shows
-- today is marked, and every other row keeps the default. Additive only.
--
-- That includes ordinary undispatched tasks, which are also created in `draft`. Marking them is
-- deliberate: they are what the Ideas page lists today, so leaving them out would make items
-- disappear from a page someone is already looking at. Going forward only the flag counts, so
-- no NEW ordinary task joins them — see `ideaTaskPredicateSql` in `operations/idea-identity.ts`.
ALTER TABLE tasks ADD COLUMN is_idea INTEGER NOT NULL DEFAULT 0;

UPDATE tasks SET is_idea = 1 WHERE status = 'draft';

-- The Ideas list reads one project's ideas newest-first.
CREATE INDEX IF NOT EXISTS idx_tasks_project_ideas
ON tasks(project_id, updated_at DESC)
WHERE is_idea = 1;

-- When a person last answered this idea's "a pull request merged — is it done?" question by
-- choosing "Keep open". Without it the question would come back every time the page is read,
-- and dismissing it by watching `updated_at` would let an agent's own note answer it.
ALTER TABLE tasks ADD COLUMN idea_merge_ack_at TEXT;
