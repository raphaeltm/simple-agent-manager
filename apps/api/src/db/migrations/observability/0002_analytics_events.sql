-- Migration: D1 analytics sink for installations without Analytics Engine (self-host).
-- Additive only. Written only when ANALYTICS_SINK="d1" (services/analytics-d1-sink.ts);
-- Cloudflare installations keep writing Analytics Engine and never touch this table.
--
-- Columns mirror Analytics Engine's data point shape (index1, blob1..blob11, double1..double3,
-- timestamp) so the admin analytics SQL runs against both with only a dialect translation.
-- `timestamp` is UTC text 'YYYY-MM-DD HH:MM:SS' (SQLite datetime()), so range filters compare
-- lexicographically and date()/strftime() work without conversion.
-- Growth is bounded by the 5-minute observability purge: age (ANALYTICS_D1_RETENTION_DAYS,
-- default 90) and row cap (ANALYTICS_D1_MAX_ROWS, default 500000).

CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  index1 TEXT NOT NULL DEFAULT '',
  blob1 TEXT NOT NULL DEFAULT '',
  blob2 TEXT NOT NULL DEFAULT '',
  blob3 TEXT NOT NULL DEFAULT '',
  blob4 TEXT NOT NULL DEFAULT '',
  blob5 TEXT NOT NULL DEFAULT '',
  blob6 TEXT NOT NULL DEFAULT '',
  blob7 TEXT NOT NULL DEFAULT '',
  blob8 TEXT NOT NULL DEFAULT '',
  blob9 TEXT NOT NULL DEFAULT '',
  blob10 TEXT NOT NULL DEFAULT '',
  blob11 TEXT NOT NULL DEFAULT '',
  double1 REAL NOT NULL DEFAULT 0,
  double2 REAL NOT NULL DEFAULT 0,
  double3 REAL NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_timestamp ON analytics_events (timestamp);
CREATE INDEX IF NOT EXISTS idx_analytics_events_blob1_timestamp ON analytics_events (blob1, timestamp);
