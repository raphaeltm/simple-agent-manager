-- Backfill provider volumes that are already attached but still carry a pre-attach
-- transitional status. Rows without both attachment identifiers keep their current
-- state so failed, deleted, and detached records are not rewritten.
UPDATE deployment_volumes
SET
  status = 'attached',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE length(trim(coalesce(attached_server_id, ''))) > 0
  AND length(trim(coalesce(linux_device, ''))) > 0
  AND status IN ('creating', 'available', 'in-use');
