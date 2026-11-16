-- Write-ahead record of a provider deletion the cleanup cron started but did not wait for
-- (two-phase deletion, `services/strict-node-deletion.ts`). The cron sends the provider DELETE
-- without waiting for the provider's operation and confirms on a later tick from the provider's
-- own record of that deletion; termination proof is written only then.
--
-- provider_deletion_requested_at: when this record was written, immediately before the DELETE.
--   Confirmation never re-stamps it, so it bounds how long a deletion may stay unconfirmed. A new
--   record replaces it only when another DELETE is about to be sent: after the provider showed the
--   old one void (cleared), when it no longer describes the row's runtime, or when the next current
--   credential retries after the provider refused the previous one's DELETE.
-- provider_deletion_json: the provider's opaque ticket plus the provider instance id and runtime
--   incarnation it was written for. A record whose identity does not match the row is ignored.
--
-- Numbered 0241 to stay clear of 0239/0240 proposed by open PRs #2693 and #2721.
-- Existing rows stay NULL: they have no deletion in flight and take the ordinary path.
ALTER TABLE nodes ADD COLUMN provider_deletion_requested_at TEXT;
ALTER TABLE nodes ADD COLUMN provider_deletion_json TEXT;
