# Fix: Workspace-Scoped Session Cookies

**Created**: 2026-03-18
**Status**: Active

## Problem

Session cookies are shared across workspace subdomains because the cookie is set with `Domain: ".baseDomain"` (e.g., `.simple-agent-manager.org`). When two workspaces share a node, the browser sends the same cookie for both `ws-AAA` and `ws-BBB`, causing "workspace claim mismatch" 403 errors.

Symptoms:
- Can't open terminal on workspace B after authenticating to A
- Can't start agent sessions on workspace B
- "Git status failed: workspace claim mismatch" on workspace B
- Only one workspace works at a time per browser

## Root Cause

1. Cookie name is fixed (`vm_session`) — same name for all workspaces
2. Cookie domain is `.baseDomain` — shared across all workspace subdomains
3. `requireWorkspaceRequestAuth` hard-fails on workspace claim mismatch instead of falling through to token auth

## Fix (Option 3: Both)

### A. Workspace-scoped cookie names
- Change `GetSessionFromRequest` to look for workspace-scoped cookie `vm_session_{workspaceId}`
- Change `SetCookie` to accept workspace ID and set workspace-scoped cookie name
- This allows multiple workspace sessions simultaneously

### B. Graceful fallthrough on mismatch
- In `requireWorkspaceRequestAuth` and `authenticateWorkspaceWebsocket`, when cookie session doesn't match workspace, skip it (log warning) and fall through to token auth
- Defense in depth — even with old cookies, token auth still works

### C. Port forwarding compatibility
- Port forwarding uses `ws-ID--PORT.baseDomain` subdomains
- Cookie domain `.baseDomain` means workspace-scoped cookies work for port forwarding too
- `SetCookie` with workspace-scoped name handles this automatically since cookie domain covers all subdomains

## Implementation Checklist

- [ ] Modify `SessionManager.GetSessionForWorkspace(r, workspaceID)` to look for workspace-scoped cookie
- [ ] Modify `SessionManager.SetCookieForWorkspace(w, session, workspaceID)` to set workspace-scoped cookie
- [ ] Update `requireWorkspaceRequestAuth` to use workspace-scoped methods and fallthrough on mismatch
- [ ] Update `authenticateWorkspaceWebsocket` to use workspace-scoped methods and fallthrough on mismatch
- [ ] Update `handleSessionCheck` to check workspace-scoped cookie
- [ ] Update `handleLogout` to clear workspace-scoped cookie
- [ ] Update `handleTerminalResize` to use workspace-scoped session lookup
- [ ] Update `resolveWorkspaceIDForWebsocket` to try all session cookies
- [ ] Add tests for workspace-scoped cookie behavior
- [ ] Build Go code successfully

## Acceptance Criteria

- [ ] Two workspaces on the same node can be used simultaneously in the same browser
- [ ] Port forwarding subdomains share the workspace session cookie
- [ ] Token-based auth works as fallback when cookies mismatch
- [ ] No regression for single-workspace nodes
