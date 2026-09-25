# Recover unsent VM reporter rows across warm session switches

## Evidence

`Reporter.SetSessionID` clears old-session outbox rows when a warm node is relinked. The callback API rejects writes for a session other than the workspace's current `chatSessionId`, so retaining those rows in the active outbox without a separate recovery path makes them undeliverable and consumes its bounded capacity. The transcript-boundary/payload task preserved the existing scoped clear rather than claiming this separate lifecycle is lossless.

## Desired behavior

Before relinking or recycling a warm node, drain the old session while its callback identity is valid. If delivery cannot complete, durably quarantine the original rows with an observable recovery/export path and an explicit capacity policy. Verify old-session and new-session messages remain correctly attributed under concurrent enqueue, restart, and callback rejection.
