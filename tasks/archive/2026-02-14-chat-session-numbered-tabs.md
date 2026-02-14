# Chat Session Tabs Should Have Unique Numbered Names

## Summary

When creating a new chat session, it gets the same label as the previous one (e.g. every Claude Code session is labeled "Claude Code Chat"). This makes it impossible to distinguish between tabs. New sessions also appear before older ones in the tab strip, which is confusing.

Sessions should have incrementing numbered names (e.g. "Claude Code Chat 1", "Claude Code Chat 2") and new tabs should appear after existing ones. The tab ordering and naming need to be properly managed across both the web UI and VM agent.

## Current Behavior

- **Duplicate names**: `handleCreateSession()` in `Workspace.tsx:378-414` always passes `{ label: "{AgentName} Chat" }` — every session of the same agent type gets the identical label
- **Wrong tab order**: New sessions are prepended via `[created, ...remaining]` (line 399), so the newest tab appears first
- **Label fallback**: The display logic (lines 538-555) falls through: custom label → "{AgentName} Chat" → "Chat {sessionId suffix}" — but since label is always set to the same string, fallback never triggers
- **API ordering**: `listAgentSessions()` returns `orderBy(desc(createdAt))` — newest first
- **Two tab systems**: The web UI has its own session list (`agentSessions` state) AND the VM agent has a `tabs` table with `sort_order` — these aren't well synchronized

## Desired Behavior

- New chat sessions get incrementing labels: "Claude Code Chat 1", "Claude Code Chat 2", etc.
- New tabs appear after existing tabs (append, not prepend)
- Tab order is consistent between page loads (persisted sort order)
- Labels are unique within a workspace

## Root Cause Files

| File | Lines | Issue |
|------|-------|-------|
| `apps/web/src/pages/Workspace.tsx` | 378-414 | `handleCreateSession()` always uses same label, prepends new session |
| `apps/web/src/pages/Workspace.tsx` | 538-555 | Tab label display logic |
| `apps/api/src/routes/workspaces.ts` | 673-684 | `listAgentSessions()` orders by `createdAt DESC` |
| `apps/api/src/routes/workspaces.ts` | 687-761 | Create session endpoint, stores label |
| `packages/vm-agent/internal/server/` | tabs persistence | VM agent `tabs` table has `sort_order` but web UI doesn't use it consistently |

## Implementation Notes

### Numbered Labels
- When creating a session, count existing sessions with the same agent type
- Generate label: `"{AgentName} Chat {N+1}"` where N is the count of existing sessions of that type
- OR: query existing labels matching the pattern and find the next number

### Tab Ordering
- Append new sessions instead of prepending: `[...remaining, created]`
- Use `orderBy(asc(createdAt))` in API (oldest first = stable tab order)
- Alternatively, use the VM agent's `sort_order` as the source of truth for tab positioning

### State Synchronization
- The web UI and VM agent both track tabs independently — changes in one should reflect in the other
- The VM agent `tabs` table has `sort_order` — consider making this the canonical ordering source
- Web UI polls `listAgentSessions()` every 5s — this should include consistent ordering

## Open Questions

- Should users be able to rename chat session tabs?
- Should the numbering restart when old sessions are stopped/closed, or always increment?
- Should the VM agent `tabs` table be the single source of truth for tab state, replacing the D1 `agentSessions` ordering?
