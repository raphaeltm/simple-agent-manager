# Recover unsent VM reporter rows across warm session switches

## Evidence

`Reporter.SetSessionID` (`packages/vm-agent/internal/messagereport/reporter.go`) deletes the previous session's outbox rows when a reused workspace is linked to a new chat session. It has to: the callback route rejects a message for any session other than the workspace's current `chatSessionId` with `400 Session mismatch` (`rejectMessageSessionMismatch` in `apps/api/src/routes/workspaces/runtime.ts`), so those rows can no longer be delivered and would otherwise occupy the bounded outbox.

The loss window is whatever the old session enqueued after its last successful flush (one `MSG_BATCH_MAX_WAIT` in the normal case, longer while the control plane is unreachable). This is pre-existing and separate from the transcript-boundary/payload fix, which binds every request to its rows' stored session and sends one session per request, so a leftover row can no longer sink a batch of the current session's messages.

## Reproduction

1. Point a reporter at a control plane that stalls (`MSG_BATCH_MAX_WAIT` elapses without a 200).
2. Enqueue messages for session A.
3. Link the workspace to session B (the API now rejects writes for A) and call `SetSessionID("B")`.
4. Session A's unsent rows are deleted and logged as `cleared stale outbox messages on session switch`; they never reach ProjectData.

## Desired behavior

Before relinking or recycling a warm node, drain the old session while its callback identity is valid. If delivery cannot complete, durably quarantine the original rows with an observable recovery/export path and an explicit capacity policy. Verify old-session and new-session messages remain correctly attributed under concurrent enqueue, restart, and callback rejection.
