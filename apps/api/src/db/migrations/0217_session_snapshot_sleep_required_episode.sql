-- A person's Sleep is required (policy a3780107): it must not fail. A failed attempt is
-- retried by the sweep and the bounded fallback, which carry no person, so the requirement
-- is recorded on the episode it belongs to. The claim of a person's Sleep sets this to the
-- episode's sleep_episode_started_at. The episode is required only while the two columns are
-- equal, so every writer that ends or restarts an episode (a finished sleep, a wake, a human
-- follow-up, a new episode) clears the requirement without any change of its own.
-- Existing rows stay NULL: no earlier episode was required.
ALTER TABLE session_snapshots ADD COLUMN sleep_required_episode_started_at TEXT;
