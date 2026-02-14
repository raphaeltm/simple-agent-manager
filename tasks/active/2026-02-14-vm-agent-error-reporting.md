# VM Agent Error Reporting to CF Workers Observability

**Created**: 2026-02-14
**Priority**: Medium
**Status**: Active (PR #74)

## Problem

VM agent errors (Go) are only visible via the VM agent's own event store (accessed through `GET /nodes/:id/events` and `GET /workspaces/:id/events`). These logs are not searchable in Cloudflare Workers observability, making it hard to diagnose VM-side issues using the same `mcp__cloudflare-observability` tooling used for API and client errors.

## Goal

Add a `POST /api/nodes/:id/errors` endpoint that the VM agent calls to report errors. The control plane logs each error via `console.error('[vm-agent-error]', { ... })`, making VM agent errors searchable in CF Workers observability alongside client errors (`[client-error]`) and API errors.

## Acceptance Criteria

- [x] VM agent can POST errors to the control plane API
- [x] Errors appear in CF Workers observability with `[vm-agent-error]` prefix
- [x] Auth uses existing callback JWT token pattern (same as heartbeat/ready callbacks)
- [x] All limits configurable via env vars (Constitution Principle XI)
- [x] Tests for both API endpoint and VM agent Go reporter
- [x] Documentation updated (CLAUDE.md, AGENTS.md, .env.example)
- [ ] Deployed and verified in CF Workers observability

## Implementation Summary

### API Endpoint (`apps/api/src/routes/nodes.ts`)
- `POST /api/nodes/:id/errors` — callback JWT auth, batch of up to 10 entries
- Each entry logged via `console.error('[vm-agent-error]', { ...entry, nodeId })`
- Configurable via `MAX_VM_AGENT_ERROR_BODY_BYTES` (32KB) and `MAX_VM_AGENT_ERROR_BATCH_SIZE` (10)

### Go Error Reporter (`packages/vm-agent/internal/errorreport/`)
- Thread-safe batching with `sync.Mutex`-protected queue
- Background `time.Ticker` flush every 30s, immediate flush at batch threshold
- Nil-safe methods (matches boot log reporter pattern)
- Fire-and-forget: failed sends logged locally, never retried

### ACP Gateway Integration
- `reportAgentError()` now dual-reports to both boot-log and error reporter
- Covers: agent start failure, rapid exit, prompt failure, install failure

### Tests
- 13 Go unit tests (queue, flush, nil-safety, HTTP, shutdown)
- 16 API unit tests (auth, validation, truncation, levels, batch)
