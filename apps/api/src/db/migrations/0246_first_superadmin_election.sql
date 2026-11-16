-- Close the ordinary first-superadmin election on installations that already have an
-- administrator. The marker names the oldest real (status != 'system') superadmin, matching
-- RECORD_SQL in apps/api/src/services/first-superadmin.ts (establishFirstSuperadmin). While it
-- exists, no sign-in is promoted, even if that administrator is later deleted.
--
-- This migration only inserts the marker. It never updates or deletes user rows:
--   * An installation with more than one superadmin (possible only from the concurrent first
--     sign-up race that predates this election, or a manual database edit) keeps every one of
--     them. establishFirstSuperadmin logs first-superadmin.multiple_superadmins on each sign-in
--     until an operator resolves it.
--   * An installation with no superadmin gets no marker. A fresh installation has only the system
--     user here, so its first real user still wins the election at sign-in. An existing sole
--     non-suspended user stays electable, as the login-time self-heal already allowed. An
--     installation with several real users and no superadmin promotes nobody, because the election
--     requires the signing-in user to be the only real user.
INSERT OR IGNORE INTO platform_settings (key, value, updated_at, updated_by)
SELECT
  'setup.firstSuperadminEstablished',
  json_object('version', 1, 'ownerId', id),
  CURRENT_TIMESTAMP,
  id
FROM users
WHERE role = 'superadmin'
  AND status != 'system'
ORDER BY created_at, id
LIMIT 1;
