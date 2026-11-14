-- Write-ahead record of a provider deletion the cleanup cron started but did not wait for
-- (two-phase deletion, `services/strict-node-deletion.ts`). The cron sends the provider DELETE
-- without waiting for the provider's operation and confirms on a later tick from the provider's
-- own record of that deletion; termination proof is written only then.
--
-- provider_deletion_requested_at: when this record was written. Never re-stamped while the record
--   exists, so it bounds how long a deletion may stay unconfirmed.
-- provider_deletion_json: the provider's opaque ticket plus the provider instance id and runtime
--   incarnation it was written for. A record whose identity does not match the row is ignored.
--
-- Existing rows stay NULL: they have no deletion in flight and take the ordinary path.
ALTER TABLE nodes ADD COLUMN provider_deletion_requested_at TEXT;
ALTER TABLE nodes ADD COLUMN provider_deletion_json TEXT;
