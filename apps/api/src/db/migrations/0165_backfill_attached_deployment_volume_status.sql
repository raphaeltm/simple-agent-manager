-- Backfill provider volumes that are already attached but still carry a pre-attach
-- transitional status. Rows without both attachment identifiers keep their current
-- state so failed, deleted, and detached records are not rewritten.
UPDATE deployment_volumes
SET
  status = 'attached',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE attached_server_id IS NOT NULL
  AND trim(attached_server_id) <> ''
  AND linux_device IS NOT NULL
  AND trim(linux_device) <> ''
  AND status IN ('creating', 'available', 'in-use');
