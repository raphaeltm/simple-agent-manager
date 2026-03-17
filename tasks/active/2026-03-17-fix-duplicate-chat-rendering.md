# Fix Duplicate Conversation Rendering in Merged DO+ACP View

## Problem

In `ProjectMessageView.tsx`, the merged view (shown when agent is not prompting and grace period is over) renders the full conversation twice — once from DO messages and once from ACP messages.

### Root Cause

The deduplication logic at lines 858-874 is broken on both checks:

1. **ID check fails**: ACP items use client-generated IDs (`item-N-timestamp` from `useAcpMessages.ts:nextId()`) while DO items use database ULIDs/UUIDs. The formats never overlap, so `doIds.has(item.id)` is always false.

2. **Timestamp check fails**: ACP items get `Date.now()` timestamps when the browser processes them (including during replay). DO items have server-side `createdAt` timestamps. After an ACP replay, all ACP items have timestamps newer than `latestDoTimestamp`, so the filter passes everything through.

Result: `mergedItems = [...convertedItems, ...acpOnlyItems]` contains the full conversation twice.

## Research Findings

### Key Code Paths

| Component | File | Lines |
|-----------|------|-------|
| View selection (`useFullAcpView`) | `ProjectMessageView.tsx` | 849-851 |
| Broken merge (to remove) | `ProjectMessageView.tsx` | 858-874 |
| Grace period config | `ProjectMessageView.tsx` | 42-43 |
| Grace timer lifecycle | `ProjectMessageView.tsx` | 418-443 |
| ACP ID generation (`nextId()`) | `useAcpMessages.ts` | 134-136 |
| DO→ConversationItem conversion | `ProjectMessageView.tsx` | 125-230 |
| State-level merge | `merge-messages.ts` | 66-142 |

### Why DO-Only After Grace Period Is Safe

- The merged view is only reached when: ACP has items AND DO has items AND agent is NOT prompting AND grace period (3s) is over
- The 3s grace period covers the ~2s VM agent batch delay for persisting messages
- Active streaming is handled by `useFullAcpView` (shows ACP-only when prompting)
- The 3s polling fallback catches any remaining stragglers
- `ACP_GRACE_MS` is configurable via `VITE_ACP_GRACE_MS` env var

### Existing Tests

- `chatMessagesToConversationItems.test.ts` (741 lines) — comprehensive DO conversion tests
- `project-message-view.test.tsx` — session cross-contamination regression tests
- No existing tests for the ACP↔DO view transition or grace period mechanism

## Implementation Checklist

- [x] Replace broken merge logic with `const mergedItems = convertedItems` after `useFullAcpView` check
- [x] Update comment block to describe two-source rendering strategy accurately
- [x] Update existing merge tests to match new DO-only behavior after grace period
- [x] Add regression test: duplicate messages when ACP and DO have same conversation
- [ ] Verify lint passes (`pnpm --filter @simple-agent-manager/web lint`)
- [ ] Verify typecheck passes (`pnpm --filter @simple-agent-manager/web typecheck`)
- [ ] Verify build passes (`pnpm build`)
- [ ] Run existing tests (`pnpm test`)

## Acceptance Criteria

- [ ] Chat messages are not duplicated when viewing a completed or idle session
- [ ] Active streaming (agent prompting) still shows live ACP messages
- [ ] Grace period still provides smooth handoff from ACP to DO view
- [ ] Sessions with no ACP connection show DO messages correctly
- [ ] Build, lint, and typecheck pass
- [ ] Existing chat rendering tests pass

## References

- `apps/web/src/components/chat/ProjectMessageView.tsx`
- `packages/acp-client/src/hooks/useAcpMessages.ts`
- `apps/web/src/lib/merge-messages.ts`
