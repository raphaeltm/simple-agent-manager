-- Convert users.created_at and updated_at from TEXT to INTEGER (timestamp_ms)
-- Migration: 0003_users_timestamp_to_integer.sql
--
-- BetterAuth requires integer timestamps (milliseconds since epoch) because
-- Drizzle's timestamp_ms mode converts Date objects to integers for D1 storage.
-- Without this, D1 throws: "Type 'object' not supported for value '<Date>'"

-- Recreate users table with INTEGER timestamps
CREATE TABLE IF NOT EXISTS users_new (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  image TEXT,
  github_id TEXT UNIQUE,
  avatar_url TEXT,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)),
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer))
);

-- Copy existing data, converting TEXT timestamps to INTEGER (milliseconds)
-- strftime('%s', ...) converts ISO date to unix seconds, * 1000 for milliseconds
INSERT OR IGNORE INTO users_new (id, email, email_verified, name, image, github_id, avatar_url, created_at, updated_at)
  SELECT
    id, email, email_verified, name, image, github_id, avatar_url,
    CASE
      WHEN typeof(created_at) = 'text' THEN cast(strftime('%s', created_at) * 1000 as integer)
      WHEN typeof(created_at) = 'integer' THEN created_at
      ELSE cast(unixepoch() * 1000 as integer)
    END,
    CASE
      WHEN typeof(updated_at) = 'text' THEN cast(strftime('%s', updated_at) * 1000 as integer)
      WHEN typeof(updated_at) = 'integer' THEN updated_at
      ELSE cast(unixepoch() * 1000 as integer)
    END
  FROM users;

-- Swap tables
DROP TABLE IF EXISTS users;
ALTER TABLE users_new RENAME TO users;

-- Recreate indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id);
