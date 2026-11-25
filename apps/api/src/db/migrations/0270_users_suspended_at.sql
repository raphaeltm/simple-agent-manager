-- When the account's current suspension began. Set by the admin suspend route on the transition
-- into `suspended`, kept on a suspension retry, cleared on approval. A retried suspension closes
-- sockets on memberships removed since this time (`closeSuspendedUserSockets`); `updated_at` cannot
-- serve, because every retry and role change rewrites it. Additive and nullable: existing rows are
-- untouched, and an account suspended before this column falls back to `updated_at` once.
ALTER TABLE users ADD COLUMN suspended_at INTEGER;
