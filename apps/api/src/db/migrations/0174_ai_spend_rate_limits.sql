-- Atomic per-user counters for Workers AI spend guards. One row is retained
-- per spend bucket and user; window rollover replaces the counter in place.

CREATE TABLE ai_spend_rate_limits (
  bucket TEXT NOT NULL CHECK (bucket IN ('session-summarize', 'transcribe')),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  window_start INTEGER NOT NULL CHECK (window_start >= 0),
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (bucket, user_id)
);
