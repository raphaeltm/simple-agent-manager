# Fix Agent Offline in Task Mode — 3 Critical Bugs

## Problem

Task-mode agents are going "offline" — workspace running but UI shows "agent offline." Three bugs interact to cause this failure. The direct ACP heartbeat endpoint (added in commit `9a513283`, PR #688) has never worked because it's behind the wrong auth middleware.

## Research Findings

### Bug 1: Direct ACP Heartbeat Auth Mismatch (CRITICAL)
- **VM agent** (`acp_heartbeat.go:105`): Sends `Authorization: Bearer <callback-JWT>`
- **API routing** (`projects/index.ts:11`): `projectsRoutes.use('/*', requireAuth(), requireApproved())` applies BetterAuth session cookie validation to ALL project routes including `node-acp-heartbeat`
- **`requireAuth()`** (`middleware/auth.ts:38-66`): Uses `auth.api.getSession()` which validates browser cookies, NOT callback JWTs → 401 on every heartbeat
- **Fix pattern**: Mount a separate route BEFORE `projectsRoutes` in `index.ts` (same pattern as `deploymentIdentityTokenRoute` at line 390), using `verifyCallbackToken()` inline auth (pattern from `nodes.ts:97-115`)
- Token must accept both `scope: 'workspace'` AND `scope: 'node'` (token refresh changes scope)

### Bug 2: Backup Sweep Timeout Too Low (HIGH)
- **Location**: `nodes.ts:638` — `HEARTBEAT_ACP_SWEEP_TIMEOUT_MS` defaults to `8000`ms
- DO cold starts can exceed 8s → heartbeat silently lost
- **Fix**: Change default to `15000`ms (still within `waitUntil`'s 30s budget)

### Bug 3: Auto-Suspend Enabled for Task Mode (MEDIUM)
- **Location**: `agent_ws.go:258-262` — task mode sets `IdleSuspendTimeout = 30min`, conversation mode disables it
- **Fix**: Set `cfg.IdleSuspendTimeout = 0` unconditionally — five independent shutdown mechanisms remain (15-min idle cleanup, 6-hour prompt timeout, 2-hour workspace idle timeout, orphan cron sweep, 4-hour max node lifetime)

## Implementation Checklist

- [x] **Fix 1a**: Create `apps/api/src/routes/projects/node-acp-heartbeat.ts` with callback JWT auth inline (using `extractBearerToken` + `verifyCallbackToken`, accepting both workspace and node scope)
- [x] **Fix 1b**: Mount `nodeAcpHeartbeatRoute` in `apps/api/src/index.ts` BEFORE `projectsRoutes` at `/api/projects` path
- [x] **Fix 1c**: Remove the `node-acp-heartbeat` handler from `apps/api/src/routes/projects/acp-sessions.ts`
- [x] **Fix 1d**: Fix the misleading auth comments in `acp-sessions.ts` (lines 132-137, 191-193)
- [x] **Fix 2**: Change `HEARTBEAT_ACP_SWEEP_TIMEOUT_MS` default from `'8000'` to `'15000'` in `nodes.ts:638`
- [x] **Fix 3**: Set `cfg.IdleSuspendTimeout = 0` unconditionally in `agent_ws.go:258-262`
- [x] **Test 1**: Integration test — `node-acp-heartbeat` accepts valid callback JWT (workspace + node scoped)
- [x] **Test 2**: Integration test — `node-acp-heartbeat` rejects invalid/expired/missing tokens
- [x] **Test 3**: Auto-suspend disabled unconditionally — existing test in `session_host_test.go:963` covers `IdleSuspendTimeout=0` behavior
- [x] **Test 4**: Contract test — VM agent heartbeat request format matches API expectations

## Acceptance Criteria

- [x] Direct ACP heartbeat endpoint returns 204 with valid callback JWT (both scopes)
- [x] Direct ACP heartbeat endpoint returns 401/403 with invalid/missing tokens
- [x] Other project routes still require BetterAuth session cookies (no auth regression)
- [x] Backup sweep timeout defaults to 15s
- [x] Auto-suspend is disabled for both task and conversation mode
- [x] All existing tests pass (3509/3509)

## References

- Idea: `01KP5GNP83JB0PK1QGXGDNMKMD`
- Task: `01KP5GPG6CVDRAKZEWYFBPGDDD`
- PR #688 (commit `9a513283`) — introduced the broken direct heartbeat
- `docs/notes/2026-03-25-deployment-identity-token-middleware-leak-postmortem.md` — same middleware leak pattern
- `.claude/rules/06-api-patterns.md` — Hono middleware scoping rules
