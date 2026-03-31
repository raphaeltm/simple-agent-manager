# Fix Forwarded Ports Display in Project View

## Problem

Forwarded ports show up reliably in the workspace view but not in the project (chat) view. The project view's port polling is fragile due to three issues:

1. **No token refresh** — Workspace view uses `useTokenRefresh()` which proactively refreshes tokens before expiry. Project view (`ProjectMessageView.tsx`) does a one-shot `getTerminalToken()` in a `useEffect` (line 574-590). When the token expires, `listWorkspacePorts()` calls get 401 errors and silently fail — ports disappear.

2. **No retry on failed workspace/token fetch** — Both the workspace fetch (line 558) and token fetch (line 583) have empty catch blocks. If either fails (network hiccup, transient error), `workspace` or `terminalToken` stays null/undefined, and port polling never starts.

3. **Sequential dependency chain** — Session → workspace → token → ports. Three async steps must complete in sequence before ports poll. Any break silently kills the entire chain.

## Research Findings

### Workspace View (Reliable) — `apps/web/src/pages/Workspace.tsx`
- Uses `useTokenRefresh()` hook (line 241) which fetches token, schedules proactive refresh 5min before expiry, and exposes manual `refresh()` for 401 recovery
- `workspace` data is available early — fetched directly from URL params `id`
- Token stays fresh for the lifetime of the page

### Project Chat View (Unreliable) — `apps/web/src/components/chat/ProjectMessageView.tsx`
- Manual one-shot `getTerminalToken()` in useEffect (line 574-590) — **no refresh, no retry**
- `workspace` fetched via `getWorkspace(session.workspaceId)` with silent catch (line 558-567)
- `isWorkspaceRunning` depends on `workspace?.status === 'running'` — if workspace fetch fails, status is undefined, token fetch never fires
- Port polling uses same `useWorkspacePorts()` hook as workspace view, but with unreliable inputs

### Token Flow Comparison
| Aspect | Workspace View | Project Chat View |
|--------|---------------|-------------------|
| Token source | `useTokenRefresh()` | Manual `useEffect` one-shot |
| Token refresh | Proactive (5min before expiry) | None |
| Token retry | Via `refresh()` callback | None |
| Workspace URL | Direct from page context | Async fetch from session.workspaceId |
| Failure handling | Error state displayed | Silent catch (empty) |

### Key Files
- `apps/web/src/hooks/useWorkspacePorts.ts` — shared polling hook (10s interval)
- `apps/web/src/hooks/useTokenRefresh.ts` — token refresh hook (used by workspace view only)
- `apps/web/src/components/chat/ProjectMessageView.tsx` — project chat view (broken)
- `apps/web/src/pages/Workspace.tsx` — workspace view (working reference)
- `apps/web/src/lib/api.ts:1098-1115` — `listWorkspacePorts()` API call
- `apps/web/src/lib/api.ts:1205-1210` — `getTerminalToken()` API call

## Implementation Checklist

- [x] 1. Replace manual one-shot token fetch in `ProjectMessageView.tsx` with `useTokenRefresh()` hook
  - Use same pattern as `Workspace.tsx` line 231-244
  - Enable when `!!session?.workspaceId && isWorkspaceRunning`
  - Remove the manual `useEffect` at lines 574-590
  - Remove `terminalToken` useState (replaced by hook return)

- [x] 2. Add retry logic for workspace fetch
  - Add retry with backoff when `getWorkspace()` fails
  - Or: use a polling interval (e.g., retry every 10s until workspace is available, stop once fetched)
  - Ensure workspace fetch fires when session transitions from no-workspace to has-workspace

- [x] 3. Update `useWorkspacePorts` hook to be more resilient
  - When a fetch fails (401/network error), don't immediately clear ports — keep stale data visible
  - Add consecutive failure tracking: only clear ports after N consecutive failures (e.g., 3)
  - Log errors for debuggability

- [x] 4. Add tests
  - Unit test: `useWorkspacePorts` retains stale ports on transient failure
  - Unit test: `useWorkspacePorts` clears ports after N consecutive failures
  - Unit test: ProjectMessageView port polling starts when workspace becomes available

- [x] 5. Update CLAUDE.md recent changes if needed (not needed — no new features/config)

## Acceptance Criteria

- [ ] Forwarded ports display in the project chat view as reliably as in the workspace view
- [ ] Token is proactively refreshed before expiry in the project chat view
- [ ] Transient network failures don't permanently break port display (retry + stale data preservation)
- [ ] No regressions in workspace view port display
- [ ] Tests cover the token refresh and retry behaviors

## References
- `apps/web/src/hooks/useTokenRefresh.ts` — existing token refresh hook
- `apps/web/src/hooks/useWorkspacePorts.ts` — port polling hook
- `.claude/rules/06-technical-patterns.md` — React interaction-effect analysis
