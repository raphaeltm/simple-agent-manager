# PTY manager race hardening

## Problem

The VM agent PTY manager has race-prone lifecycle code around session creation and orphan timer management. These are high-confidence quality/security-adjacent findings because terminal WebSocket handlers can create, orphan, and reattach sessions concurrently. The fix must be non-breaking: no command contracts, payloads, flags, environment variable names, auth semantics, or wire protocols change.

## Research findings

- `packages/vm-agent/internal/pty/manager.go` checks `sessions[sessionID]` and per-user session limits before starting a PTY, then inserts the session later. Concurrent `CreateSessionWithID` calls can pass the pre-checks together and overwrite the same session ID or exceed `MaxSessionsPerUser`.
- `OrphanSession` writes `session.orphanTimer` outside `session.mu`, while `ReattachSession` reads/stops it under `session.mu`. That creates a race-sensitive lifecycle edge under concurrent WebSocket disconnect/reattach.
- Existing tests in `packages/vm-agent/internal/pty/manager_test.go` already exercise orphan/reattach behavior and can host race-sensitive tests.
- Scope is `packages/vm-agent/internal/pty` only. No wire contract or CLI behavior changes are required.

## Implementation checklist

- [x] Make `CreateSessionWithID` insertion duplicate-safe under the manager mutex.
- [x] Make `MaxSessionsPerUser` enforcement atomic with session map insertion.
- [x] Guard orphan timer assignment with the session mutex.
- [x] Add scenario-driven Go tests for duplicate concurrent session creation and max-session enforcement.
- [x] Run `go test -race` for the touched package.
- [x] Run Go specialist, test engineer, and security auditor reviews before finalizing.

## Acceptance criteria

- Concurrent duplicate `CreateSessionWithID` calls result in exactly one managed session for that ID.
- Concurrent per-user session creation cannot exceed `MaxSessionsPerUser`.
- Orphan/reattach timer state remains race-safe under `go test -race`.
- `go test -race ./internal/pty` passes from `packages/vm-agent`.
- PR explains why the change is non-breaking.

## Constraints

- Do not change terminal WebSocket message types, JSON payloads, auth semantics, CLI contracts, flags, environment variable names, or wire protocols.
- Open a PR and wait for CI to be completely green.
- Do not merge the PR.
