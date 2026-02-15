# Platform Reliability, UX, and Performance Improvements

**Created**: 2026-02-15
**Source**: Comprehensive platform review across all layers (API, UI, VM Agent, ACP/WebSocket)
**Priority**: Reliability > UX > Performance

---

## Priority 1: Reliability (Critical)

### R1. VM Agent Event Log Memory Leak
**Severity**: Critical | **Component**: `packages/vm-agent/internal/server/server.go`
- `nodeEvents` slice grows unbounded (initialized at 512, no max)
- `workspaceEvents` map entries never cleaned up for deleted workspaces
- Long-running nodes will OOM
- **Fix**: Cap event slices with circular buffer eviction, delete workspace events on workspace deletion

### R2. External API Calls Without Timeouts
**Severity**: Critical | **Component**: `apps/api/src/services/`
- All Hetzner API calls (`hetzner.ts`) lack `AbortController` timeout
- All Cloudflare DNS API calls (`dns.ts`) lack timeout
- Node Agent HTTP calls (`node-agent.ts`) lack timeout
- VM agent calls to control plane lack timeout
- **Fix**: Add configurable `HETZNER_API_TIMEOUT_MS`, `CF_API_TIMEOUT_MS`, `NODE_AGENT_TIMEOUT_MS` env vars with 30s defaults

### R3. WebSocket Token Expiry Without Refresh
**Severity**: Critical | **Component**: `packages/acp-client/src/hooks/useAcpSession.ts`, `apps/web/src/components/ChatSession.tsx`
- Terminal token fetched once on mount, expires after 1h
- No refresh mechanism exists
- After expiry, reconnection silently fails with auth error
- User must manually reload page
- **Fix**: Track token expiry, refresh proactively before expiry, or refresh on 401 during reconnection

### R4. No React Error Boundary
**Severity**: Critical | **Component**: `apps/web/`
- Zero error boundaries in the entire app
- Any unhandled React error crashes to white screen
- No recovery path for users
- **Fix**: Add global ErrorBoundary in App.tsx with "Something went wrong" UI and reload button

### R5. Credential Toggle Race Condition
**Severity**: High | **Component**: `apps/api/src/routes/credentials.ts:374-399`
- Two sequential UPDATE queries without transaction
- Concurrent requests can activate multiple credentials or leave all inactive
- **Fix**: Wrap in D1 transaction (batch)

### R6. WebSocket Ping/Pong Timeout Hardcoded
**Severity**: High | **Component**: `packages/vm-agent/internal/acp/gateway.go:156-159`
- `pingInterval = 30s`, `pongTimeout = 10s` are constants
- Aggressive timeout on slow/mobile networks causes premature disconnects
- **Fix**: Make configurable via `ACP_PING_INTERVAL` and `ACP_PONG_TIMEOUT` env vars

### R7. Workspace Status Transition Race
**Severity**: High | **Component**: `packages/vm-agent/internal/server/workspaces.go`
- `handleStopWorkspace` doesn't check current status before transition
- Provisioning goroutine can overwrite "stopped" with "running"
- **Fix**: Atomic status transitions with CAS-style validation

### R8. Dashboard Polling Interval Not Dynamic
**Severity**: Medium | **Component**: `apps/web/src/pages/Dashboard.tsx:41-46`
- `pollInterval` calculated but `setInterval` set only once
- Changing from transitional to stable state doesn't adjust polling rate
- **Fix**: Use `setTimeout` chain or `useEffect` dependency on `hasTransitionalWorkspaces`

### R9. Silent API Failures in UI
**Severity**: Medium | **Component**: `apps/web/src/lib/api.ts`
- `listWorkspaceEvents`, `listNodeEvents`, `getWorkspaceTabs`, `getGitStatus` silently return empty on error
- Users see empty lists with no indication of failure
- **Fix**: Propagate errors to UI, show retry option

---

## Priority 2: UX (Major)

### U1. No Loading Skeletons
**Severity**: Major | **Component**: All pages
- All pages show centered `<Spinner />` with no content placeholders
- Dashboard, Settings, CreateWorkspace, Nodes pages all blank during load
- **Fix**: Add skeleton screens matching loaded content layout

### U2. No Confirmation Feedback (Toasts)
**Severity**: Major | **Component**: All mutation actions
- Save, delete, stop, restart actions have no success confirmation
- Only feedback is modal closing and list updating
- **Fix**: Add toast notification system for action feedback

### U3. No Optimistic Updates
**Severity**: Medium | **Component**: All pages with mutations
- Every mutation (stop, restart, delete) refetches entire list
- Causes flashing UI and perceived slowness
- **Fix**: Optimistically update local state, reconcile on refetch

### U4. CreateWorkspace Prerequisites Flow
**Severity**: Medium | **Component**: `apps/web/src/pages/CreateWorkspace.tsx`
- Full-page spinner during prerequisites check
- User discovers setup requirements only after spinner completes
- **Fix**: Show prerequisites list immediately with loading status for each

### U5. Missing Onboarding Flow
**Severity**: Low | **Component**: First-time user experience
- No guided tour or setup checklist
- User must discover Settings → Hetzner token → Create flow independently
- **Fix**: Add welcome screen with setup checklist

---

## Priority 3: Performance

### P1. N+1 Query Patterns
**Severity**: High | **Component**: `apps/api/src/routes/`
- Workspace listing fetches all then filters in-memory (should use WHERE clauses)
- Workspace limit checks fetch all IDs to count (should use COUNT)
- Node operations fetch full rows when only IDs needed
- **Fix**: Use Drizzle `where()`, `count()`, and `select()` appropriately

### P2. Missing Database Compound Indexes
**Severity**: Medium | **Component**: `apps/api/src/db/schema.ts`
- Missing `(userId, status)` for filtered workspace listings
- Missing `(nodeId, status)` for node workspace queries
- Missing `(workspaceId, userId, status)` for agent session queries
- **Fix**: Add compound indexes via Drizzle migration

### P3. GitHub Repository Listing Serial API Calls
**Severity**: Medium | **Component**: `apps/api/src/routes/github.ts:86-104`
- Sequential `for...of` loop for GitHub API calls
- Should use `Promise.all()` for parallel requests
- **Fix**: Parallelize installation repository fetches

### P4. No API Response Pagination
**Severity**: Low (until scale) | **Component**: `apps/api/src/routes/`
- `GET /workspaces` and `GET /nodes` return all records
- No limit/offset/cursor pagination
- **Fix**: Add pagination support to list endpoints

---

## Top 3 to Implement Now

Based on impact and feasibility:

1. **R4. React Error Boundary** — Prevents white-screen crashes, easy to implement, huge UX impact
2. **R2. External API Timeouts** — Prevents hung Workers, critical for reliability
3. **R8. Dashboard Polling Fix** — Fixes stale UI, small targeted change

---
