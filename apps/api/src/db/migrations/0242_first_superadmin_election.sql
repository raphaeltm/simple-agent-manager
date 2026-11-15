-- Close the ordinary first-superadmin election on installations that already have an
-- administrator or multiple real users. A sole non-admin stays eligible for the existing
-- single-operator self-heal. New installations have only the status='system' sentinel when this
-- migration runs, so their first session can atomically create this marker and promote its owner.
-- The marker is durable even if that owner is later deleted, preventing initial administration
-- from reopening. Multiple non-system superadmins can only originate from the former concurrent
-- bootstrap race: the admin API never accepts 'superadmin' as a role change. Keep the oldest active
-- winner and return every other active duplicate to the ordinary pending approval path.
UPDATE users
SET
  role = 'user',
  status = CASE WHEN status = 'active' THEN 'pending' ELSE status END,
  updated_at = cast(unixepoch() * 1000 as integer)
WHERE role = 'superadmin'
  AND status != 'system'
  AND id != (
    SELECT winner.id
    FROM users winner
    WHERE winner.role = 'superadmin' AND winner.status != 'system'
    ORDER BY CASE WHEN winner.status = 'active' THEN 0 ELSE 1 END, winner.created_at, winner.id
    LIMIT 1
  );

INSERT OR IGNORE INTO platform_settings (key, value, updated_at, updated_by)
SELECT
  'setup.firstSuperadminEstablished',
  json_object('version', 1, 'ownerId', id),
  CURRENT_TIMESTAMP,
  id
FROM users
WHERE status != 'system'
  AND (
    role = 'superadmin'
    OR (SELECT COUNT(*) FROM users real_user WHERE real_user.status != 'system') > 1
  )
ORDER BY
  CASE WHEN role = 'superadmin' THEN 0 ELSE 1 END,
  CASE WHEN status = 'active' THEN 0 ELSE 1 END,
  created_at,
  id
LIMIT 1;
