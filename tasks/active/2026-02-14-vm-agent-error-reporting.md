# VM Agent Error Reporting to CF Workers Observability

**Created**: 2026-02-14
**Priority**: Medium
**Status**: Backlog

## Problem

VM agent errors (Go) are only visible via the VM agent's own event store (accessed through `GET /nodes/:id/events` and `GET /workspaces/:id/events`). These logs are not searchable in Cloudflare Workers observability, making it hard to diagnose VM-side issues using the same `mcp__cloudflare-observability` tooling used for API and client errors.

## Goal

Add a `POST /api/nodes/:id/errors` endpoint that the VM agent calls to report errors. The control plane logs each error via `console.error('[vm-agent-error]', { ... })`, making VM agent errors searchable in CF Workers observability alongside client errors (`[client-error]`) and API errors.

## Acceptance Criteria

- [ ] VM agent can POST errors to the control plane API
- [ ] Errors appear in CF Workers observability with `[vm-agent-error]` prefix
- [ ] Auth uses existing callback JWT token pattern (same as heartbeat/ready callbacks)
- [ ] Rate limited to prevent abuse
- [ ] All limits configurable via env vars (Constitution Principle XI)
- [ ] Tests for both API endpoint and VM agent HTTP client
- [ ] Documentation updated (CLAUDE.md, AGENTS.md, .env.example)

## Implementation Notes

- Follow the `POST /api/nodes/:id/heartbeat` pattern for auth (callback token validation)
- Follow the `POST /api/client-errors` pattern for logging structure
- VM agent Go side: add an `ErrorReporter` that batches and sends errors
- Keep it fire-and-forget on the VM agent side (don't block on error reporting)
