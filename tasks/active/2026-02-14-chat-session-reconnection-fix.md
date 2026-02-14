# Fix Chat Session Reconnection and Conversation Continuity

**Created**: 2026-02-14
**Status**: Active
**Branch**: `fix/chat-session-reconnection`

## Problem

When a user switches away from the SAM browser tab (e.g., to another app on mobile) and returns, two critical bugs occur:

1. **Reconnection hang**: After WebSocket reconnect, the browser's `agentType` state is stale. The auto-select guard `agentType === preferredAgentId` evaluates true and skips sending `select_agent`. The server waits for a message that never comes. UI shows "Waiting for agent..." forever.

2. **Conversation amnesia**: Even after successful reconnection (via page refresh), the server spawns a fresh agent process and calls `NewSession()`. The browser shows cached messages from `sessionStorage`, but the agent has zero knowledge of them.

## Root Cause

1. **Hang**: `useAcpSession.ts` WebSocket `open` handler doesn't reset `agentType` state, so `ChatSession.tsx` auto-select effect short-circuits.
2. **Amnesia**: Gateway always calls `NewSession()` instead of `LoadSession()`. ACP SDK v0.6.3 supports `LoadSession()` which restores sessions from disk (`~/.claude/sessions/`), but we never use it.

## Solution (5 Phases)

### Phase 1: Fix reconnection hang
- Reset `agentType` to `null` and `error` to `null` in WebSocket `open` handler
- File: `packages/acp-client/src/hooks/useAcpSession.ts`

### Phase 2: Persist ACP session ID
- Add `AgentType` and `AcpSessionID` fields to `agentsessions.Session`
- Add `UpdateAcpSessionID()` method to Manager
- Add migration v2 to SQLite store for `acp_session_id` column
- Files: `manager.go`, `store.go`

### Phase 3: Wire up LoadSession on reconnection
- Modified `handleSelectAgent()` to capture previous ACP session ID before stopping agent
- Modified `startAgent()` to accept `previousAcpSessionID` and attempt `LoadSession` first
- Added `SessionUpdater`/`TabSessionUpdater` interfaces for persistence
- Added `persistAcpSessionID()` helper
- Files: `gateway.go`, `agent_ws.go`

### Phase 4: Browser discards local cache on reconnection
- Detect reconnection state transition and clear `acpMessages` cache
- LoadSession replay from agent becomes sole source of truth
- File: `ChatSession.tsx`

### Phase 5: Persist ACP session ID on agent start
- Handled within Phase 3 via `persistAcpSessionID()` in `startAgent()`

## Files Modified

| File | Change |
|------|--------|
| `packages/acp-client/src/hooks/useAcpSession.ts` | Reset agentType/error on reconnect |
| `packages/acp-client/src/hooks/useAcpSession.test.ts` | 2 new test cases |
| `apps/web/src/components/ChatSession.tsx` | Reconnection cache clear |
| `packages/vm-agent/internal/agentsessions/manager.go` | AcpSessionID/AgentType fields + update method |
| `packages/vm-agent/internal/agentsessions/manager_test.go` | 2 new test cases |
| `packages/vm-agent/internal/persistence/store.go` | Migration v2 + UpdateTabAcpSessionID |
| `packages/vm-agent/internal/persistence/store_test.go` | 3 new test cases |
| `packages/vm-agent/internal/acp/gateway.go` | LoadSession support + persistence |
| `packages/vm-agent/internal/server/agent_ws.go` | Wire up config fields |

## Checklist

- [x] Phase 1: Fix reconnection hang
- [x] Phase 2: Persist ACP session ID
- [x] Phase 3: Wire up LoadSession
- [x] Phase 4: Browser cache discard on reconnect
- [x] Phase 5: Persist ACP session ID on agent start
- [x] Unit tests pass (Go + TypeScript)
- [x] Typecheck passes
- [x] Lint passes
- [x] PR created with preflight evidence (#67)
- [ ] CI passes
- [ ] Merged to main
- [ ] Deployed to production
- [ ] Playwright verification in production
