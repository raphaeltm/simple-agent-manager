-- Reset recovery_attempts for snapshots bricked by the lifetime-counter bug: the
-- counter was never reset on successful wake, so sessions that slept and woke 3+
-- times became permanently unwakeable. Resetting is safe even for genuinely-failed
-- rows — they just get 3 more bounded attempts before hitting the cap again.
--
-- The threshold 3 matches DEFAULT_SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS
-- (session-snapshot-artifacts.ts). Self-hosted deployments that override
-- SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS to a different value may need to
-- adjust this migration.
UPDATE session_snapshots
SET recovery_attempts = 0,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE recovery_attempts >= 3;
