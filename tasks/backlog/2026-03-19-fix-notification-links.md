# Fix Notification Panel Links

## Problem

Notification links in the notification panel point to `/projects/{projectId}` (bare project page) instead of `/projects/{projectId}/chat/{sessionId}` (the specific chat session for that task). This means clicking a notification doesn't take the user to the relevant conversation.

## Root Cause

Two issues:

1. **`notifyPrCreated()`** in `apps/api/src/services/notification.ts` doesn't accept `sessionId` in its options interface, so `buildActionUrl()` is called without it (line 206). The call site in `apps/api/src/routes/tasks/crud.ts` (line 526) has `ws?.chatSessionId` available but can't pass it.

2. **MCP notification call sites** in `apps/api/src/routes/mcp.ts` don't look up `chatSessionId` for several notifications (`notifyProgress`, `notifyTaskComplete`, `notifyNeedsInput`). The `McpTokenData` has `workspaceId` but MCP code doesn't query the workspace's `chatSessionId`. `notifySessionEnded` explicitly passes `null`.

## Research Findings

### Key Files
- `apps/api/src/services/notification.ts` — notification helpers and `buildActionUrl()`
- `apps/api/src/routes/tasks/crud.ts` — task lifecycle callbacks calling notification helpers
- `apps/api/src/routes/mcp.ts` — MCP tool handlers calling notification helpers
- `apps/api/src/services/mcp-token.ts` — `McpTokenData` interface (has workspaceId)
- `apps/api/src/db/schema.ts` — workspaces table has `chatSessionId`
- `apps/web/src/components/NotificationCenter.tsx` — frontend uses `notification.actionUrl` correctly

### Notification sessionId Status

| Function | File | Has sessionId? |
|----------|------|---------------|
| notifyTaskComplete | notification.ts | ✅ accepts, but MCP caller doesn't pass it |
| notifyTaskFailed | notification.ts | ✅ accepts, but need to verify callers |
| notifySessionEnded | notification.ts | ✅ accepts, MCP passes null |
| notifyPrCreated | notification.ts | ❌ doesn't accept |
| notifyNeedsInput | notification.ts | ✅ accepts, but MCP caller doesn't pass it |
| notifyProgress | notification.ts | ✅ accepts, but MCP caller doesn't pass it |

### `buildActionUrl()` already correct
Returns `/projects/{id}/chat/{sessionId}` when sessionId is provided, `/projects/{id}` otherwise. No changes needed here.

## Implementation Checklist

- [ ] Add `sessionId?: string | null` to `notifyPrCreated` opts interface in `notification.ts`
- [ ] Pass `opts.sessionId` to `buildActionUrl()` and `sendNotification()` in `notifyPrCreated`
- [ ] Pass `sessionId: ws?.chatSessionId` at the `notifyPrCreated` call site in `crud.ts`
- [ ] Create a helper function to look up `chatSessionId` from `workspaceId` via D1
- [ ] Pass sessionId to MCP `notifyProgress` call site
- [ ] Pass sessionId to MCP `notifyTaskComplete` call site
- [ ] Pass sessionId to MCP `notifyNeedsInput` call site
- [ ] Pass sessionId to MCP `notifySessionEnded` call site (replace null with actual lookup)
- [ ] Add unit test for `notifyPrCreated` with sessionId
- [ ] Add test verifying MCP notifications include sessionId in actionUrl

## Acceptance Criteria

- [ ] Clicking any notification in the panel navigates to `/projects/{projectId}/chat/{sessionId}` when a sessionId exists
- [ ] `notifyPrCreated` includes sessionId in its actionUrl
- [ ] MCP-originated notifications include sessionId when the workspace has one
- [ ] Existing notification tests still pass
- [ ] No hardcoded URLs (constitution Principle XI compliance)

## References
- `apps/web/src/App.tsx` lines 70-71 — route pattern `/projects/:id/chat/:sessionId`
- `buildActionUrl()` at `notification.ts:67-72` — already handles sessionId correctly
