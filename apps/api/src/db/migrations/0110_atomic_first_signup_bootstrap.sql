-- Atomic first-signup superadmin election (audit finding BA-01).
--
-- Better Auth's user.create.before hook and its later adapter INSERT are separate
-- operations. A read of an empty users table in that hook is therefore not a
-- compare-and-set: concurrent signups can all observe the same empty baseline.
--
-- The system row is a mixed-version deployment guard. Migrations run before the
-- new Worker is deployed, so the previous Worker may still execute its legacy
-- "any user other than the configured sentinel?" read. It sees this second
-- system row and safely creates migration-window signups as ordinary pending
-- users. This prevents SQLite RETURNING from ever handing that Worker a stale
-- privileged value while the new adapter reload is not yet deployed.
INSERT INTO users (id, email, email_verified, role, status)
VALUES (
  'system_first_signup_election_guard',
  'first-signup-election@simple-agent-manager.internal',
  0,
  'user',
  'system'
)
ON CONFLICT(id) DO NOTHING;

-- Persist a one-time claim instead of reopening bootstrap whenever an
-- established deployment happens to have no active superadmin. The migration is
-- atomic: a genuinely clean installation has no non-system users when this row
-- is initialized, while every existing installation starts permanently closed.
CREATE TABLE IF NOT EXISTS first_signup_superadmin_claim (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  is_open INTEGER NOT NULL CHECK (is_open IN (0, 1)),
  claimed_user_id TEXT
);

INSERT INTO first_signup_superadmin_claim (singleton, is_open, claimed_user_id)
SELECT
  1,
  CASE WHEN EXISTS (
    SELECT 1 FROM users WHERE status != 'system'
  ) THEN 0 ELSE 1 END,
  NULL
ON CONFLICT(singleton) DO NOTHING;

-- Put the election in the successful account-link INSERT so SQLite's
-- single-writer ordering serializes the privilege claim with a usable
-- authentication identity. A request interrupted before account linking leaves
-- the singleton open; a committed link and claim are one atomic statement.
CREATE TRIGGER IF NOT EXISTS accounts_claim_first_superadmin_after_insert
AFTER INSERT ON accounts
WHEN EXISTS (
  SELECT 1
  FROM users AS candidate
  WHERE candidate.id = NEW.user_id
    AND candidate.role = 'user'
    AND candidate.status = 'pending'
)
BEGIN
  UPDATE first_signup_superadmin_claim
  SET is_open = 0, claimed_user_id = NEW.user_id
  WHERE singleton = 1
    AND is_open = 1
    AND NOT EXISTS (
      SELECT 1
      FROM users AS existing_operator
      WHERE existing_operator.role = 'superadmin'
        AND existing_operator.status = 'active'
    );

  UPDATE users
  SET role = 'superadmin', status = 'active'
  WHERE id = NEW.user_id
    AND role = 'user'
    AND status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM first_signup_superadmin_claim AS claim
      WHERE claim.singleton = 1
        AND claim.is_open = 0
        AND claim.claimed_user_id = NEW.user_id
    );
END;

-- Open registration keeps creating active ordinary users. When the retained
-- login-time self-heal promotes the sole user, close the same one-time claim so
-- bootstrap cannot reopen later if that operator is suspended or removed.
CREATE TRIGGER IF NOT EXISTS users_close_first_superadmin_claim_after_update
AFTER UPDATE OF role, status ON users
WHEN NEW.role = 'superadmin' AND NEW.status = 'active'
BEGIN
  UPDATE first_signup_superadmin_claim
  SET is_open = 0, claimed_user_id = COALESCE(claimed_user_id, NEW.id)
  WHERE singleton = 1 AND is_open = 1;
END;
