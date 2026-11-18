# Background snapshot 410 on session stop is logged as an error

## Problem

When a chat session is stopped, the vm-agent's background snapshot capture can call the control
plane after the workspace has started stopping. The control plane correctly answers
`410 GONE "Workspace is stopping; callback resource is gone"`, but the vm-agent reports it as an
error-level `vm_agent_error` from `session_snapshot.background_capture`:

`snapshot control plane returned HTTP 410: {"error":"GONE","message":"Workspace is stopping; callback resource is gone"}`

This is the same teardown race class that `isSnapshotTeardownRaceError`
(`packages/vm-agent/internal/server/session_snapshot_coordinator.go`) suppresses for the
`workspace is not running` producer, reached through a different producer (the control plane's
designed terminal 410, rule 34). Error-level rows like this feed incident triage.

## Context

Seen on the self-host test box on 2026-11-18 at 13:10:49Z (BOX debt run, task
01M7QB382PDGH42XEG3ZFFS6DE), right after `POST …/sessions/:id/stop` for workspace
01M7QCCTDJWBDY10316ZF8343G. Probably the same on Cloudflare installs; not checked there.

## Acceptance Criteria

- [ ] Confirm whether the 410 happens only after a successful earlier capture, i.e. no snapshot
      is lost (rule 67, requirement 4)
- [ ] If nothing is lost, classify the control plane's designed 410 for a stopping workspace as a
      teardown race using a typed error (not a message substring), without widening any
      recovery trigger
- [ ] Tests: the 410 from a stopping workspace is not reported as an error; a 410 for another
      reason, and other failures, still report
