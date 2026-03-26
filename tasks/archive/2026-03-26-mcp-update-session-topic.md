# MCP Tool: Update Session Topic

## Problem Statement

Agents currently have no way to update the topic/title of their chat session after it's created. The initial topic is set at session creation time (often from the task title or a generic label), but agents may only understand the true nature of a conversation after several messages. They need a tool to rename the session topic as the conversation evolves or changes direction.

## Research Findings

### Key Files
- `apps/api/src/routes/mcp/tool-definitions.ts` — MCP tool schemas (add new tool definition)
- `apps/api/src/routes/mcp/session-tools.ts` — Session tool handlers (add handler here)
- `apps/api/src/routes/mcp/index.ts` — MCP route dispatcher (register new case)
- `apps/api/src/routes/mcp/_helpers.ts` — Shared helpers, limits, sanitization
- `apps/api/src/durable-objects/project-data/sessions.ts` — Session CRUD in DO SQLite (add `updateSessionTopic()`)
- `apps/api/src/durable-objects/project-data/index.ts` — DO class methods (add `updateSessionTopic()` RPC method)
- `apps/api/src/services/project-data.ts` — Service layer bridging API to DO (add `updateSessionTopic()`)

### Session Data Model
- Sessions use a `topic` field (TEXT, nullable) — not "title"
- Schema: `chat_sessions` table in ProjectData DO SQLite
- Sessions have `status` ('active' or 'stopped'), `updated_at` timestamp

### Existing Patterns
- `resolveSessionId()` in `idea-tools.ts` resolves workspace → session via D1 `workspaces.chat_session_id`
- `sanitizeUserInput()` strips null bytes, bidi overrides, control chars
- `McpTokenData` has `taskId`, `projectId`, `userId`, `workspaceId` (no sessionId)
- `update_idea` tool is the closest existing pattern for an update MCP tool
- Configurable limits pattern: `DEFAULT_*` constants + env var overrides via `getMcpLimits()`

### Data Flow
1. Agent calls `update_session_topic` MCP tool with `topic` param
2. Handler resolves `sessionId` from `workspaceId` via `resolveSessionId()`
3. Handler calls `projectDataService.updateSessionTopic(env, projectId, sessionId, topic)`
4. Service calls DO stub method `stub.updateSessionTopic(sessionId, topic)`
5. DO method calls `sessions.updateSessionTopic(sql, sessionId, topic)`
6. SQL: `UPDATE chat_sessions SET topic = ?, updated_at = ? WHERE id = ?`

## Implementation Checklist

- [ ] Add `updateSessionTopic()` function in `apps/api/src/durable-objects/project-data/sessions.ts`
- [ ] Add `updateSessionTopic()` method on ProjectData DO class in `apps/api/src/durable-objects/project-data/index.ts`
- [ ] Add `updateSessionTopic()` service function in `apps/api/src/services/project-data.ts`
- [ ] Add `update_session_topic` tool definition in `apps/api/src/routes/mcp/tool-definitions.ts`
- [ ] Add `handleUpdateSessionTopic()` handler in `apps/api/src/routes/mcp/session-tools.ts`
- [ ] Register `update_session_topic` case in MCP route dispatcher `apps/api/src/routes/mcp/index.ts`
- [ ] Move `resolveSessionId()` from `idea-tools.ts` to `_helpers.ts` (shared utility, used by both idea and session tools)
- [ ] Add configurable `MCP_SESSION_TOPIC_MAX_LENGTH` limit with sensible default (200 chars)
- [ ] Add unit tests for `updateSessionTopic()` DO function
- [ ] Add integration test for the MCP tool handler

## Acceptance Criteria

- [ ] Agent can call `update_session_topic` with a `topic` string to rename their current session
- [ ] Tool validates topic is non-empty and within max length
- [ ] Tool returns the updated session with new topic
- [ ] Topic is sanitized (no control chars, bidi overrides)
- [ ] Only active sessions can be updated (stopped sessions are immutable)
- [ ] Max topic length is configurable via `MCP_SESSION_TOPIC_MAX_LENGTH` env var
- [ ] Existing session tools continue to work unchanged
- [ ] Unit and integration tests pass
