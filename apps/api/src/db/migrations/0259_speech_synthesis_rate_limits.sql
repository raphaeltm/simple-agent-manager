-- Independent atomic counters for paid speech endpoints. Keep the existing AI
-- counters and their CHECK constraint intact; no table rebuild or data movement.
-- One row per user is reused at each clock-hour rollover.
CREATE TABLE speech_synthesis_rate_limits (
  bucket TEXT NOT NULL CHECK (bucket = 'speech-synthesis'),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  window_start INTEGER NOT NULL CHECK (window_start >= 0),
  count INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (bucket, user_id)
);
