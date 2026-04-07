# Phase 6: Parent Routing for request_human_input

## Problem Statement

The `request_human_input` MCP tool already has partial parent routing (enqueue to parent inbox with urgent priority), added during Phase 3/4. However, it's missing:
1. A kill switch (`ORCHESTRATOR_PARENT_ROUTING_ENABLED`) to disable parent routing
2. "Also sent to parent agent" note in human notification for dual-routing awareness
3. `get_inbox_status` MCP tool for orchestrator agents to proactively check inbox
4. Comprehensive tests for the parent routing behavior
5. Updated notification body to indicate dual-routing when parent exists

## Research Findings

### Existing Implementation (instruction-tools.ts:192-234)
- Parent routing already works: checks parentTaskId, resolves parent session, enqueues urgent inbox message
- Uses `resolveParentSessionContext` from `services/inbox-drain.ts`
- Falls back to human notification on failure
- Missing: kill switch, dual-routing note in notification, configurable timeout

### Inbox Infrastructure (Already Built)
- `getInboxStats()` exists in `project-data/inbox.ts:151-161` — returns `{ pending: number }`
- `ProjectData.getInboxStats(targetSessionId)` exposed at `project-data/index.ts:270-272`
- Need to enhance to also return urgent count and oldest message age

### MCP Tool Registration Pattern
- Tool definitions in `routes/mcp/tool-definitions.ts` (MCP_TOOLS array)
- Handler dispatch in `routes/mcp/index.ts` (switch statement, line ~238)
- Handler functions follow pattern: `handleXxx(requestId, params?, tokenData, env)`

### Configuration Pattern
- Constants in `_helpers.ts` with `DEFAULT_ORCHESTRATOR_*` prefix
- Env vars in `Env` interface at `index.ts:305-313`
- `getMcpLimits()` aggregates parsed values

### Notification Service
- `notifyNeedsInput()` at `services/notification.ts:225-256`
- Body is `truncate(opts.context, MAX_NOTIFICATION_BODY_LENGTH)`
- Can append parent routing note to context before passing to notification

## Implementation Checklist

### 1. Add Configuration
- [ ] Add `DEFAULT_ORCHESTRATOR_PARENT_ROUTING_ENABLED` constant (default: true) in `_helpers.ts`
- [ ] Add `ORCHESTRATOR_PARENT_ROUTING_ENABLED` to Env interface in `index.ts`

### 2. Add Kill Switch to handleRequestHumanInput
- [ ] Wrap parent routing block with kill switch check
- [ ] When disabled, skip parent resolution entirely (human notification only)

### 3. Dual-Routing Note in Notification
- [ ] When parent routing succeeds, append note to notification body: "(Also sent to parent agent task '{parentTitle}')"
- [ ] Fetch parent task title during parent resolution
- [ ] When parent routing fails or is skipped, send unmodified notification

### 4. Enhance getInboxStats
- [ ] Add urgent count and oldest message age to `getInboxStats()` in `inbox.ts`
- [ ] Update `ProjectData.getInboxStats()` return type
- [ ] Update existing tests for new return shape

### 5. Add get_inbox_status MCP Tool
- [ ] Add tool definition to `tool-definitions.ts`
- [ ] Create `handleGetInboxStatus()` handler in `orchestration-tools.ts`
- [ ] Add case to dispatch switch in `index.ts`
- [ ] Handler: resolve caller's session, call `getInboxStats()`, return counts

### 6. Tests
- [ ] Child with active parent → message enqueued + human notification sent
- [ ] Child without parent → human notification only
- [ ] Child with completed parent → human notification only
- [ ] Urgent priority on enqueued message
- [ ] Dual notification content includes "also sent to parent" note
- [ ] Parent resolution failure → graceful fallback
- [ ] Kill switch disabled → human notification only
- [ ] get_inbox_status returns correct counts

### 7. Documentation
- [ ] Add new env vars to `apps/api/.env.example`
- [ ] Update CLAUDE.md if needed

## Acceptance Criteria

- [ ] When a child task calls `request_human_input` and has an active parent, the request is enqueued to the parent's inbox with urgent priority AND a human notification is sent with a note indicating dual routing
- [ ] The kill switch `ORCHESTRATOR_PARENT_ROUTING_ENABLED=false` disables parent routing entirely
- [ ] `get_inbox_status` MCP tool returns pending count, urgent count, and oldest message age for the caller's session
- [ ] All 8 test scenarios pass
- [ ] No regressions in existing MCP tool behavior

## References

- `apps/api/src/routes/mcp/instruction-tools.ts` — handleRequestHumanInput
- `apps/api/src/services/inbox-drain.ts` — resolveParentSessionContext
- `apps/api/src/durable-objects/project-data/inbox.ts` — getInboxStats
- `apps/api/src/routes/mcp/tool-definitions.ts` — MCP tool definitions
- `apps/api/src/routes/mcp/index.ts` — tool dispatch
- Phase 3 PR #623, Phase 4 PR #624
