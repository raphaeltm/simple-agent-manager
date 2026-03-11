# Quickstart: DO-Owned ACP Session Lifecycle

**Feature**: 027-do-session-ownership | **Date**: 2026-03-11

## Prerequisites

- Node.js 18+, pnpm 8+, Go 1.24+
- Working build: `pnpm install && pnpm build`
- Familiarity with ProjectData DO (`apps/api/src/durable-objects/project-data.ts`)

## Implementation Order

Build in this sequence (each step testable independently):

### Step 1: Data Model (DO Migration + Types)

1. Add `acp_sessions` and `acp_session_events` tables to `apps/api/src/durable-objects/migrations.ts` (migration 008)
2. Add `AcpSession`, `AcpSessionStatus`, `AcpSessionEvent` types to `packages/shared/src/types.ts`
3. Build shared: `pnpm --filter @simple-agent-manager/shared build`
4. **Test**: Verify migration runs in Miniflare test

### Step 2: DO Session CRUD

1. Add methods to `apps/api/src/durable-objects/project-data.ts`:
   - `createAcpSession()` — insert with status "pending"
   - `getAcpSession()` / `listAcpSessions()` — query
   - `transitionAcpSession()` — state machine enforcement
   - `updateHeartbeat()` — heartbeat processing
   - `forkAcpSession()` — create child session
   - `getAcpSessionLineage()` — query fork tree
2. Add service functions to `apps/api/src/services/project-data.ts`
3. **Test**: Unit tests for every state transition (valid + invalid)

### Step 3: API Endpoints

1. Add routes to `apps/api/src/routes/projects.ts`:
   - POST/GET for ACP sessions
   - Status report, heartbeat, fork, lineage endpoints
2. Add reconciliation endpoint: GET `/api/nodes/:nodeId/acp-sessions`
3. **Test**: Integration tests with Miniflare

### Step 4: Task Runner Integration

1. Modify task runner to create ACP session in DO before provisioning workspace
2. After workspace assigned, call assign endpoint
3. Pass ACP session ID to VM agent on session creation
4. **Test**: Verify task submission creates DO-owned ACP session

### Step 5: VM Agent Reconciliation

1. Add reconciliation query on startup (`packages/vm-agent/internal/agentsessions/manager.go`)
2. Add heartbeat goroutine per active session
3. Add status reporting to control plane on ACP session events
4. **Test**: Go unit tests for reconciliation logic

### Step 6: Heartbeat + Interruption Detection

1. Add DO alarm handler for heartbeat checking in `project-data.ts`
2. Wire heartbeat endpoint processing
3. **Test**: Simulate heartbeat timeout, verify session transitions to "interrupted"

### Step 7: Session Forking

1. Implement fork endpoint — create child session with context summary
2. Enforce fork depth limit
3. **Test**: Fork completed session, verify lineage

### Step 8: UI Updates

1. Add `SessionStatusBadge` component showing session states
2. Update `ProjectChat` to display fork lineage
3. Show interruption state with "Continue" action
4. **Test**: Behavioral tests for UI components

## Key Files to Modify

| File | What to Change |
|------|----------------|
| `apps/api/src/durable-objects/migrations.ts` | Add migration 008 |
| `apps/api/src/durable-objects/project-data.ts` | Add ACP session methods |
| `apps/api/src/services/project-data.ts` | Add service layer |
| `apps/api/src/routes/projects.ts` | Add API endpoints |
| `packages/shared/src/types.ts` | Add ACP session types |
| `packages/shared/src/vm-agent-contract.ts` | Add reconciliation schemas |
| `packages/vm-agent/internal/agentsessions/manager.go` | Add reconciliation + heartbeat |
| `packages/vm-agent/internal/acp/session_host.go` | Report status changes |
| `apps/web/src/components/SessionStatusBadge.tsx` | New component |
| `apps/web/src/pages/ProjectChat.tsx` | Show session states + fork lineage |

## Environment Variables

Add to `.env.example` and document:

```bash
# ACP Session Lifecycle (all optional, sensible defaults)
ACP_SESSION_HEARTBEAT_INTERVAL_MS=60000       # VM agent heartbeat frequency
ACP_SESSION_DETECTION_WINDOW_MS=300000         # DO heartbeat timeout
ACP_SESSION_RECONCILIATION_TIMEOUT_MS=30000    # VM agent startup reconciliation
ACP_SESSION_FORK_CONTEXT_MESSAGES=20           # Messages to summarize for fork
ACP_SESSION_MAX_FORK_DEPTH=10                  # Max fork chain length
```

## Running Tests

```bash
# After each step:
pnpm typecheck                                   # Type check
pnpm --filter @simple-agent-manager/api test     # API tests
pnpm --filter @simple-agent-manager/shared build # Rebuild shared types
pnpm --filter @simple-agent-manager/web test     # UI tests (after step 8)
```

## Verification Checklist

- [ ] Migration 008 creates tables correctly
- [ ] All 8 state transitions work (valid) and invalid transitions are rejected
- [ ] Heartbeat resets detection alarm
- [ ] Heartbeat timeout marks session as "interrupted"
- [ ] Fork creates child with correct lineage
- [ ] Fork depth limit enforced
- [ ] VM agent reconciles on startup
- [ ] Task runner creates DO-owned session
- [ ] UI shows session states and fork lineage
- [ ] PTY sessions completely unaffected
