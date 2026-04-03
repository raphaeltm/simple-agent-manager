# Fix MCP Streamable HTTP Compliance for Codex

**Created**: 2026-04-03
**Priority**: High
**Classification**: `bug`

## Problem

SAM's `/mcp` endpoint treats all JSON-RPC messages as requests. When Codex sends `notifications/initialized` (a notification with no `id` field), SAM returns a JSON-RPC error instead of `202 Accepted` with no body. Codex's strict Rust RMCP client closes the transport immediately.

## Research Findings

- **Root cause**: `apps/api/src/routes/mcp/index.ts` line 184 — the `default` case in the method switch returns `Method not found` for notifications like `notifications/initialized`
- **JSON-RPC notifications** have no `id` field (per spec, `id` is undefined, not null)
- **MCP Streamable HTTP spec** requires notifications to get `202 Accepted` with no body
- **GET and DELETE** on `/mcp` should return `405 Method Not Allowed` per spec
- **Existing test patterns**: `apps/api/tests/unit/routes/mcp.test.ts` uses `mcpRequest()` helper with Hono app mock
- Claude Code and Vibe work because they use different integration paths (ACP SDK / tolerant client)

## Implementation Checklist

### A. Notification detection + 202 response
- [x] After parsing JSON-RPC body and validating `jsonrpc: '2.0'`, detect notifications where `rpc.id` is `undefined`
- [x] Return `202 Accepted` with no body for all notifications (before the method switch)

### B. GET and DELETE 405 handlers
- [x] Add `mcpRoutes.get('/', ...)` returning 405 Method Not Allowed
- [x] Add `mcpRoutes.delete('/', ...)` returning 405 Method Not Allowed

### C. Tests
- [x] Test that POST with no `id` field returns 202 with empty body
- [x] Test that `notifications/initialized` returns 202
- [x] Test that unknown notifications return 202 (not JSON-RPC error)
- [x] Test that GET `/mcp` returns 405
- [x] Test that DELETE `/mcp` returns 405
- [x] Test full Codex lifecycle: initialize (200) → notifications/initialized (202) → tools/list (200) → tools/call (200)
- [x] Regression: existing initialize, tools/list, tools/call, ping still return 200 with JSON-RPC responses

## Acceptance Criteria

- [x] `notifications/initialized` POST returns 202 with no body
- [x] All notifications (no `id` field) return 202
- [x] GET `/mcp` returns 405
- [x] DELETE `/mcp` returns 405
- [x] Existing MCP requests (initialize, tools/list, tools/call, ping) still work
- [x] Automated tests cover all lifecycle steps

## References

- `apps/api/src/routes/mcp/index.ts`
- `apps/api/src/routes/mcp/_helpers.ts`
- `tasks/backlog/2026-04-02-fix-codex-mcp-streamable-http-compliance.md`
