# Harden VM-agent terminal WebSocket limits and session IDs

## Problem

Prior CLI/VM/Go and security audits identified a narrow hardening gap in the VM-agent terminal WebSocket path: terminal sockets should enforce bounded client input behavior, maintain heartbeat/read deadlines, and strictly validate client-supplied terminal session IDs. This should be a backward-compatible remediation PR that does not change public terminal protocol fields.

## Research findings

- `packages/vm-agent/internal/server/websocket.go` owns both `/terminal/ws` and `/terminal/ws/multi` behavior.
- `handleMultiTerminalWS()` accepts `create_session` data with a client-provided `sessionId` and passes it directly into `runtime.PTY.CreateSessionWithID()`.
- `packages/vm-agent/internal/pty/manager.go` only checks duplicate IDs and per-user counts before creating a requested-ID PTY session; it does not validate ID shape.
- Existing multi-terminal tests live in `packages/vm-agent/internal/server/websocket_test.go` and already exercise create/list/reattach/close and user scoping.
- Config already exposes `WS_READ_BUFFER_SIZE` and `WS_WRITE_BUFFER_SIZE`, but there are no visible configurable terminal WebSocket message size/rate/deadline settings.
- Constitution Principle XI requires new timeouts and limits to be configurable with sensible defaults.
- Relevant rules: `.claude/rules/06-vm-agent-patterns.md`, `.claude/rules/03-constitution.md`, `.claude/rules/10-e2e-verification.md`, `.claude/rules/11-fail-fast-patterns.md`, `.claude/rules/22-infrastructure-merge-gate.md`.
- Relevant prior terminal work includes `tasks/archive/2026-06-17-harden-terminal-multi-session.md`, `tasks/archive/2026-05-10-terminal-token-route-hardening.md`, and `tasks/archive/2026-07-15-pty-manager-race-hardening.md`.

## Checklist

- [x] Add configurable terminal WebSocket read/message limits with defaults and config validation.
- [x] Add configurable terminal WebSocket heartbeat/read deadline behavior with defaults and config validation.
- [x] Add configurable per-connection message rate limiting with defaults and config validation.
- [x] Validate client-supplied terminal session IDs at the WebSocket edge and PTY manager boundary.
- [x] Preserve legitimate existing ID forms used by the current client and tests, including simple hyphenated IDs.
- [x] Keep public terminal protocol fields backward-compatible.
- [x] Add Go tests for accepted and rejected terminal session IDs.
- [x] Add Go tests for oversized or invalid WebSocket input behavior.
- [x] Add Go tests for heartbeat/read deadline behavior where feasible without flaky sleeps.
- [x] Run focused VM-agent Go tests.
- [ ] Run repository quality checks required by `/do`.
- [ ] Run local specialist reviews: go-specialist, security-auditor, test-engineer, constitution-validator, task-completion-validator.
- [ ] Create a PR that states no breaking changes and includes test evidence; do not merge.

## Acceptance criteria

- Terminal WebSocket clients cannot send unbounded message bodies.
- Terminal WebSocket clients cannot flood messages beyond the configured per-connection rate.
- Idle/dead terminal WebSocket connections are bounded by heartbeat/read deadline behavior.
- Malformed client-supplied terminal session IDs are rejected before PTY creation or tab persistence.
- Existing legitimate terminal session IDs continue to work.
- New limits/timeouts are configurable and satisfy Constitution Principle XI.
- Go tests cover the hardening behavior.
- PR is open, CI is green or clearly reported, and the PR is not merged.

## References

- SAM task: `01KXT2X95TV8FRYDTVFC9F0C7P`
- Audit tasks: `01KXT1F6JSDV3J5CJ22TGXRGAV`, `01KXT25E7FSNR952HMGACHSQE9`
- Relevant sessions: `fd408b7a-4b2e-4684-a290-285d03a88d63`, `14d1b5ba-f76e-4f21-9d54-324a8095a486`
- Implementation slice tests: go test ./internal/pty ./internal/server PASS.
- Full VM-agent tests: go test ./... in packages/vm-agent PASS.
