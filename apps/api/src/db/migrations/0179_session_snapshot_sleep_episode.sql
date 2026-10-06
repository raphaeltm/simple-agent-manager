-- Bounded sleep-failure episodes (tasks/active/2026-10-04-bounded-sleep-failure-git-baseline-fallback.md).
--
-- A sleep whose final snapshot keeps failing used to retry every few minutes forever when
-- the capture was degraded or still in flight, pinning the VM. These columns persist the
-- episode budget so it survives Worker restarts and duplicate sweeps, and so a new capture
-- generation cannot reset it:
--
-- * sleep_episode_started_at — when the current automatic/explicit sleep episode first
--   claimed the session (ISO-8601, COALESCE on claim). Cleared when the session sleeps,
--   wakes, or a human sends a follow-up.
-- * sleep_episode_failures — failed attempts in the episode (a crashed attempt whose claim
--   lease expired counts as one). Cleared with the episode.
-- * sleep_fallback_json — the bounded-failure decision: either the transcript-and-Git
--   recovery point a fallback sleep released compute with, or why the episode ended
--   blocked. Read by the wake path to tell the agent and user what was not saved.
--
-- Existing rows: failures default to 0 and the anchors are NULL, so a row that was looping
-- on a degraded capture starts one fresh bounded episode on its next attempt and then
-- falls back or ends blocked. Additive only: no DROP, no table rebuild, no backfill needed.

ALTER TABLE session_snapshots ADD COLUMN sleep_episode_started_at TEXT;
ALTER TABLE session_snapshots ADD COLUMN sleep_episode_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_snapshots ADD COLUMN sleep_fallback_json TEXT;
