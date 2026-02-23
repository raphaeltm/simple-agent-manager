-- Migration: Add user approval / invite-only mode
-- Adds role and status columns to users table for admin-gated access control.
-- Defaults ensure existing users remain active with 'user' role (zero disruption).

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

CREATE INDEX idx_users_status ON users(status);
CREATE INDEX idx_users_role ON users(role);
