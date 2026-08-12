-- Atomic first-signup superadmin election (audit finding BA-01).
--
-- Better Auth's user.create.before hook and its later adapter INSERT are separate
-- operations. A read of an empty users table in that hook is therefore not a
-- compare-and-set: concurrent signups can all observe the same empty baseline.
--
-- Put the election in the successful account-link INSERT so SQLite's single-writer
-- ordering serializes the privilege claim with a usable authentication identity.
-- Approval-enabled code first writes an ordinary pending user. The first candidate
-- whose account link succeeds becomes active/superadmin; later candidates stay
-- pending. A user insert interrupted before account linking leaves no claim.
--
-- The user trigger is an upgrade compatibility guard for an old Worker serving
-- briefly after this migration is applied: legacy code still inserts its chosen
-- candidate as superadmin/active, so later legacy candidates must be demoted.
CREATE TRIGGER IF NOT EXISTS users_guard_legacy_first_superadmin_after_insert
AFTER INSERT ON users
WHEN NEW.role = 'superadmin' AND NEW.status = 'active'
BEGIN
  UPDATE users
  SET role = 'user', status = 'pending'
  WHERE id = NEW.id
    AND EXISTS (
      SELECT 1
      FROM users AS existing_operator
      WHERE existing_operator.id != NEW.id
        AND existing_operator.role = 'superadmin'
        AND existing_operator.status = 'active'
    );
END;

CREATE TRIGGER IF NOT EXISTS accounts_elect_first_superadmin_after_insert
AFTER INSERT ON accounts
BEGIN
  UPDATE users
  SET role = 'superadmin', status = 'active'
  WHERE id = NEW.user_id
    AND role = 'user'
    AND status = 'pending'
    AND NOT EXISTS (
      SELECT 1
      FROM users AS existing_operator
      WHERE existing_operator.id != NEW.user_id
        AND existing_operator.role = 'superadmin'
        AND existing_operator.status = 'active'
    );
END;
