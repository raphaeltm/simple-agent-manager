# Fix MCP tools/call Error Handling

## Problem

When an MCP tool handler throws an unhandled exception, the error propagates to Hono's global `app.onError()` handler which returns a generic HTTP 500 response:
```json
{"error":"INTERNAL_ERROR","message":"Internal server error"}
```

This is NOT a proper JSON-RPC error envelope. The MCP client (Claude Code) sees this as:
```
Streamable HTTP error: Error POSTing to endpoint: {"error":"INTERNAL_ERROR","message":"Internal server error"}
```

The tool appears completely broken to the agent, when in reality it was a transient error that should have been reported as a JSON-RPC error with a helpful message.

## Root Cause

1. **Primary**: The `tools/call` case in `apps/api/src/routes/mcp/index.ts` (line 206) dispatches to tool handlers with bare `await handler(...)` calls and NO try/catch. Any unhandled exception falls through to the global Hono error handler.

2. **Secondary**: Multiple knowledge tool handlers in `apps/api/src/routes/mcp/knowledge-tools.ts` lack try/catch:
   - `handleSearchKnowledge` (line 197)
   - `handleAddKnowledge` (line 29)
   - `handleGetKnowledge` (line 160)
   - `handleGetProjectKnowledge` (line 224)
   - `handleGetRelevantKnowledge` (line 250)
   - `handleConfirmKnowledge` (line 345)
   - `handleGetRelated` (line 320)

   While their siblings have try/catch: `handleUpdateKnowledge`, `handleRemoveKnowledge`, `handleRelateKnowledge`, `handleFlagContradiction`.

3. **Tertiary**: `searchObservationsLike` in `apps/api/src/durable-objects/project-data/knowledge.ts` lacks try/catch, while `searchObservationsFts` has one.

## Research Findings

- The MCP endpoint at `/api/mcp` serves all workspace MCP tool calls
- The `sam-mcp` MCP server name is configured in agent sessions pointing to this endpoint
- The error is intermittent (tool works most of the time) — likely triggered by transient DO communication failures
- The global error handler at `apps/api/src/index.ts:109` logs the error but returns a non-JSON-RPC response format
- The observability DB doesn't capture these errors (they're logged to Worker stdout only)

## Implementation Checklist

- [x] Add try/catch wrapper around the entire `tools/call` switch body in `apps/api/src/routes/mcp/index.ts` that returns `jsonRpcError(requestId, INTERNAL_ERROR, message)` on failure
- [x] Add try/catch to `handleSearchKnowledge` in `knowledge-tools.ts`
- [x] Add try/catch to `handleAddKnowledge` in `knowledge-tools.ts`
- [x] Add try/catch to `handleGetKnowledge` in `knowledge-tools.ts`
- [x] Add try/catch to `handleGetProjectKnowledge` in `knowledge-tools.ts`
- [x] Add try/catch to `handleGetRelevantKnowledge` in `knowledge-tools.ts`
- [x] Add try/catch to `handleConfirmKnowledge` in `knowledge-tools.ts`
- [x] Add try/catch to `handleGetRelated` in `knowledge-tools.ts`
- [x] Add try/catch to `searchObservationsLike` in `apps/api/src/durable-objects/project-data/knowledge.ts`
- [x] Write test: unhandled tool handler exception returns JSON-RPC error (not HTTP 500)
- [x] Write test: knowledge search DO failure returns proper error
- [x] Verify existing MCP tests still pass

## Acceptance Criteria

- [x] When a tool handler throws, the MCP endpoint returns a proper JSON-RPC error response (not HTTP 500)
- [x] The error includes the requestId so the client can correlate the response
- [x] Knowledge tool errors are caught and return helpful error messages
- [x] All existing MCP tests pass
- [x] No regressions in tool functionality

## References

- `apps/api/src/routes/mcp/index.ts` — MCP endpoint router
- `apps/api/src/routes/mcp/knowledge-tools.ts` — Knowledge tool handlers
- `apps/api/src/durable-objects/project-data/knowledge.ts` — DO knowledge search implementation
- `apps/api/src/index.ts:109` — Global Hono error handler
- `.claude/rules/06-api-patterns.md` — Hono error handling patterns
