-- BetterAuth required tables
-- Migration: 0002_betterauth_tables.sql
--
-- BetterAuth requires: users, sessions, accounts, verifications tables.
-- Our users table exists but needs columns BetterAuth expects, and
-- github_id must be nullable (BetterAuth manages user creation).

-- Recreate users table with BetterAuth-compatible schema
-- (SQLite doesn't support ALTER COLUMN, so we must recreate)
CREATE TABLE IF NOT EXISTS users_new (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  name TEXT,
  image TEXT,
  github_id TEXT UNIQUE,
  avatar_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Copy any existing data (preserving all columns that exist in both)
INSERT OR IGNORE INTO users_new (id, github_id, email, name, avatar_url, created_at, updated_at)
  SELECT id, github_id, email, name, avatar_url, created_at, updated_at FROM users;

-- Swap tables
DROP TABLE IF EXISTS users;
ALTER TABLE users_new RENAME TO users;

-- Recreate indexes on users
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_id ON users(github_id);

-- Sessions table (BetterAuth session management)
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)),
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)),
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);

-- Accounts table (BetterAuth OAuth provider accounts)
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER,
  scope TEXT,
  password TEXT,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)),
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer))
);

CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id);

-- Verifications table (BetterAuth email verification, magic links, etc.)
CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer)),
  updated_at INTEGER NOT NULL DEFAULT (cast(unixepoch() * 1000 as integer))
);

CREATE INDEX IF NOT EXISTS idx_verifications_identifier ON verifications(identifier);
