-- Reset recovery_attempts for snapshots that were bricked by the lifetime-counter
-- bug: the counter was never reset on successful wake, so sessions that slept and
-- woke 3 times became permanently unwakeable. Only resets rows where the last wake
-- actually succeeded (restore_status = 'restored'), proving the count is wrong.
UPDATE session_snapshots
SET recovery_attempts = 0
WHERE recovery_attempts >= 3
  AND restore_status = 'restored';
