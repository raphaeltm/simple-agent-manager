-- Wake attempts are a BURST budget, not a lifetime cap.
--
-- `recovery_attempts` gates every wake (`claimSessionSnapshotRecovery`), but it was
-- consumed identically by failures that prove the snapshot cannot be restored and by
-- transient infrastructure failures that never reached the snapshot at all. Three
-- provider-capacity errors inside 34 minutes therefore deleted, permanently, the only
-- route back into a verified and unexpired snapshot.
--
-- Recording when a wake attempt last reported failure lets the budget decay
-- (SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS), so the cap bounds retry RATE while
-- `expires_at` stays the absolute escape path.
ALTER TABLE session_snapshots ADD COLUMN recovery_failed_at TEXT;

-- Rows already parked at `recovery_status = 'failed'` predate the column and would keep
-- a NULL forever. NULL means "no clean failure report", which the decay predicate
-- deliberately refuses, so without this backfill every session stranded by the old
-- lifetime cap would stay stranded (.claude/rules/71). `updated_at` is the timestamp
-- `failSessionSnapshotRecovery` wrote alongside that terminal state.
UPDATE session_snapshots
   SET recovery_failed_at = updated_at
 WHERE recovery_status = 'failed'
   AND recovery_failed_at IS NULL;
