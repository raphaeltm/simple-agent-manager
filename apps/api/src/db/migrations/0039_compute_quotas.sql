-- Migration 0039: Compute Quotas (Phase 3 of Admin Platform Credentials + Compute Metering & Quotas)
-- Adds default_quotas and user_quotas tables for admin-configurable per-user monthly vCPU-hour caps.

-- Platform-wide default quota set by admin (singleton — one row per quota type)
CREATE TABLE default_quotas (
  id TEXT PRIMARY KEY,
  monthly_vcpu_hours_limit REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT NOT NULL REFERENCES users(id)
);

-- Per-user quota overrides set by admin
-- null monthly_vcpu_hours_limit = use default, 0 = blocked, positive = custom limit
CREATE TABLE user_quotas (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  monthly_vcpu_hours_limit REAL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by TEXT NOT NULL REFERENCES users(id)
);

CREATE INDEX idx_user_quotas_user_id ON user_quotas(user_id);
