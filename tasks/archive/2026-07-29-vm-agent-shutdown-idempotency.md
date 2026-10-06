# VM-agent shutdown idempotency

## Problem

VM-agent shutdown paths are not fully idempotent. `auth.SessionManager.Stop()` closes its cleanup channel directly, so repeated calls panic. `server.Server.Stop()` also closes its `done` channel directly and does not stop the owned auth session cleanup goroutine. Shutdown may therefore panic during repeated lifecycle cleanup and may leave an owned goroutine running.

This task is a retry of the failed startup task `01KYQJ1P3FPQBDPCWFQ0SWPAYJ`; duplicate check found no active queued duplicate for VM-agent shutdown idempotency.

## Research findings

- `packages/vm-agent/internal/auth/session.go`
  - `NewSessionManagerWithConfig()` starts a cleanup goroutine.
  - `SessionManager.Stop()` currently calls `close(sm.stopCleanup)` directly, making repeated calls panic.
  - Tests in `session_test.go` defer `sm.Stop()` in many cases, so the public cleanup API is already expected to be safe to call from tests and shutdown paths.
- `packages/vm-agent/internal/server/server.go`
  - `Server.Start()` starts node health, ACP heartbeat, and error reporter background work.
  - `Server.Stop()` closes `s.done` directly, so repeated calls can panic.
  - `Server.Stop()` stops port scanners, JWT validator, ACP session hosts, PTY sessions, reporters, persistence, and HTTP server, but does not stop `s.sessionManager`.
- Relevant rules:
  - `.claude/rules/46-vm-agent-diagnostic-getter-sync.md`: vm-agent background goroutine state must be synchronized and race-tested where feasible.
  - `.claude/rules/02-quality-gates.md`: lifecycle bug fixes need regression tests that would have caught the violated invariant.
  - `.claude/rules/14-do-workflow-persistence.md` and `.claude/rules/25-review-merge-gate.md`: maintain `.do-state.md` and complete specialist reviews before PR completion.

## Implementation checklist

- [x] Make `auth.SessionManager.Stop()` idempotent and safe under repeated/concurrent calls without changing public API shape.
- [x] Ensure `auth.SessionManager` cleanup goroutine exits when `Stop()` is called.
- [x] Make `server.Server.Stop()` idempotent for repeated/concurrent calls without changing public API shape.
- [x] Ensure `Server.Stop()` stops the owned auth session cleanup goroutine.
- [x] Preserve current shutdown ordering for external behavior unless a narrow ordering change is required for complete cleanup.
- [x] Add focused Go tests for repeated and concurrent `SessionManager.Stop()`.
- [x] Add focused Go tests proving `Server.Stop()` calls auth session cleanup and repeated `Server.Stop()` does not panic.
- [x] Run relevant Go tests, including `-race` if feasible.
- [x] Run local `go-specialist`, `test-engineer`, and task-completion validation reviews and address findings.
- [ ] Open a PR against `main`, wait for CI, and do not merge.

## Acceptance criteria

- Repeated `SessionManager.Stop()` calls do not panic.
- Repeated `Server.Stop()` calls do not panic.
- `Server.Stop()` cleanly stops owned background goroutines, including auth session cleanup.
- No external/public API changes are introduced.
- Strong Go regression tests cover the shutdown idempotency contract and pass locally.
- PR includes specialist review evidence, tests run, CI status, and a no-breaking-change rationale.


## Validation evidence

- `go test ./internal/auth ./internal/server` — passed.
- `go test -race ./internal/auth ./internal/server` — passed.
- `go test ./...` from `packages/vm-agent` — passed.

## Specialist review evidence

| Reviewer | Status | Outcome |
| --- | --- | --- |
| task-completion-validator | PASS | Research findings, checked checklist items, and acceptance criteria are represented in the diff/tests; no UI or multi-resource paths apply. |
| go-specialist | PASS | Concurrency/resource lifecycle is bounded by `sync.Once`; no mutex is held during I/O; auth cleanup and server background shutdown are explicit. |
| test-engineer | PASS | Regression tests cover repeated and concurrent Stop calls, cleanup goroutine exit, and race-targeted execution. |

## No-breaking-change rationale

The change adds only unexported synchronization fields and internal shutdown coordination. Existing constructors, methods, HTTP routes, config fields, and response shapes are unchanged. First-call shutdown behavior is preserved while repeated calls become safe no-ops that return the first shutdown result.
