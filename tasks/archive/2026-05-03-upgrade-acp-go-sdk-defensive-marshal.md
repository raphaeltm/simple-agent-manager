# Upgrade acp-go-sdk and Add Defensive Marshal Handling

## Problem

The VM agent can drop ACP `session/update` notifications when the ACP SDK cannot marshal newer Claude Code content block variants. Returning that marshal error from the notification handler causes the SDK to treat the notification as failed, which blocks downstream session updates and message reporting.

## Research Findings

- `packages/vm-agent/go.mod` pins `github.com/coder/acp-go-sdk` at v0.6.3.
- `packages/vm-agent/internal/acp/session_host.go` implements `sessionHostClient.SessionUpdate`.
- The current `SessionUpdate` returns `fmt.Errorf("failed to marshal session update: %w", err)` before message extraction, so a marshal failure prevents both WebSocket broadcast and reporter enqueue.
- The change touches Go VM agent code only; relevant review skill is `$go-specialist`.

## Checklist

- [x] Upgrade `github.com/coder/acp-go-sdk` from v0.6.3 to v0.12.2.
- [x] Run `go mod tidy` in `packages/vm-agent`.
- [x] Update `SessionUpdate` to log marshal failures, skip broadcast on failure, continue message extraction, and return nil.
- [x] Fix compile errors from SDK API changes if any appear.
- [x] Add regression coverage for non-blocking `SessionUpdate` marshal failures.
- [x] Validate with `go build ./...`.
- [x] Validate with `go test ./...`.
- [x] Validate with `go vet ./...`.

## Acceptance Criteria

- `packages/vm-agent/go.mod` requires `github.com/coder/acp-go-sdk v0.12.2`.
- ACP `session/update` marshal errors are logged and never propagated to the SDK notification path.
- Message extraction and reporter enqueue still run even when broadcast marshaling fails.
- `go build ./...`, `go test ./...`, and `go vet ./...` pass in `packages/vm-agent`.
