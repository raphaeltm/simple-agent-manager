# MCP Token Revocation Breaks Ongoing Sessions

## Problem

After an agent calls `complete_task` on the SAM MCP server, **all subsequent MCP tool calls fail permanently** for the rest of the session. The tools remain visible in the agent's tool list but every call returns "Command failed with no output."

This was discovered during a live session on 2026-03-08 where `get_instructions` and `complete_task` succeeded on first use, but all three tools (`get_instructions`, `update_task_status`, `complete_task`) failed on subsequent attempts.

## Root Cause Analysis

### Primary Cause: Token Revocation on `complete_task`

When `complete_task` is called, `handleCompleteTask()` in `apps/api/src/routes/mcp.ts:338-339` revokes the MCP token from KV:

```typescript
await revokeMcpToken(env.KV, rawToken);
```

The MCP token is the sole authentication credential for the `sam-mcp` MCP server. Once revoked, all subsequent requests using that token receive HTTP 401.

### Secondary Cause: OAuth Discovery Fallback on 401

When the MCP client (Claude Code) receives a 401 from the server, it follows the MCP Streamable HTTP protocol and attempts **OAuth discovery** as a recovery mechanism:

1. Server returns 401 (token revoked)
2. Client tries OAuth discovery at `https://api.simple-agent-manager.org/.well-known/oauth-authorization-server`
3. Client records discovery state: `"authorizationServerUrl": "https://api.simple-agent-manager.org/"`
4. Client has no OAuth client credentials → "No client info found"
5. Subsequent calls hit fast-path failure: "Token expired without refresh token"
6. Connection drops, tool call fails

This was confirmed from Claude Code debug logs at `~/.claude/debug/`:

```
11:17:28 complete_task succeeds (token revoked server-side)
...
11:29:09 get_instructions called → 401 → "Saving discovery state"
11:29:10 "No client info found" → "HTTP connection dropped" → FAIL
11:29:12 update_task_status → "Token expired without refresh token" → FAIL
11:29:15 complete_task → "Token expired without refresh token" → FAIL
```

### Tertiary Cause: Connection Lifecycle Mismatch

- **MCP token lifecycle**: Scoped to a single task. Revoked on completion.
- **MCP connection lifecycle**: Scoped to the ACP session (entire workspace lifetime). Persists across tasks.
- **Bearer token injection**: One-time at ACP session start via HTTP headers. Cannot be refreshed.

This means once the token is revoked, the MCP client continues sending the old (revoked) token with no mechanism to obtain a new one.

## Evidence

### Debug Log Timeline

| Timestamp | Event | Outcome |
|-----------|-------|---------|
| 11:17:13 | MCP server connected | Success (1258ms) |
| 11:17:22 | `get_instructions` called | Success (823ms) |
| 11:17:28 | `complete_task` called | Success (776ms) — **token revoked** |
| 11:29:10 | `get_instructions` called | **FAIL** — 401 → OAuth discovery → drop |
| 11:29:13 | `update_task_status` called | **FAIL** — "Token expired without refresh token" |
| 11:29:17 | `complete_task` called | **FAIL** — "Token expired without refresh token" |

### Credential State After Failure

`~/.claude/.credentials.json` shows:
```json
"sam-mcp|d44fa16a4d781544": {
  "serverName": "sam-mcp",
  "serverUrl": "https://api.simple-agent-manager.org/mcp",
  "accessToken": "",
  "expiresAt": 0,
  "discoveryState": {
    "authorizationServerUrl": "https://api.simple-agent-manager.org/"
  }
}
```

Empty `accessToken` and cached OAuth discovery state confirm the client fell into the OAuth recovery path and got stuck.

## Impact

- Agents cannot report progress or complete tasks after the first task in a session
- Multi-task sessions (user sends follow-up work) lose all MCP functionality
- Error message ("Command failed with no output") provides no diagnostic information
- The 2-hour KV TTL would also cause the same failure on long-running tasks, even without explicit revocation

## Affected Code Paths

| File | Function/Line | Role |
|------|--------------|------|
| `apps/api/src/routes/mcp.ts:338-339` | `handleCompleteTask()` | Revokes token on task completion |
| `apps/api/src/services/mcp-token.ts:77-81` | `revokeMcpToken()` | Deletes token from KV |
| `apps/api/src/durable-objects/task-runner.ts:827-872` | Step: create MCP token | Generates and stores token, passes to VM agent |
| `apps/api/src/durable-objects/task-runner.ts:1129-1139` | Cleanup | Also revokes token (redundant with `complete_task`) |
| `packages/vm-agent/internal/acp/session_host.go:935,972` | `buildAcpMcpServers()` | Injects MCP servers at ACP session start (one-time) |
| `packages/vm-agent/internal/server/workspaces.go:646-648` | `handleCreateAgentSession` | Stores MCP server config per session |

## Proposed Fixes

### Option A: Remove Token Revocation from `complete_task` (Simplest)

Remove lines 337-345 from `mcp.ts`. Let the KV TTL handle natural expiration. The task-runner DO cleanup (lines 1129-1139) provides a second cleanup path.

**Pros**: Minimal change, fixes the immediate problem.
**Cons**: Token remains valid after task completion (up to 2 hours). Low risk since the token only grants access to `update_task_status` (which will reject updates on completed tasks) and `complete_task` (which is idempotent and will fail with "not in completable status").

### Option B: Session-Scoped Tokens Instead of Task-Scoped

Change token lifecycle to match the ACP session, not the individual task. Token would be scoped to the workspace/session and survive across task boundaries.

**Pros**: Architecturally correct — matches actual connection lifecycle.
**Cons**: Requires changes to token generation, storage, and the `get_instructions` tool (which currently returns data for a single task). Need a mechanism to associate the session token with the "current" task.

### Option C: Token Refresh via New Agent Session

When a new task is submitted to a running workspace, have the task-runner start a new agent session with a new MCP token, which would replace the MCP server config in the VM agent.

**Pros**: Maintains task-scoped security model.
**Cons**: Requires new ACP session per task (potentially disruptive to running Claude Code session). May not be possible with current ACP architecture.

### Option D: Extend KV TTL and Remove Explicit Revocation

Set a longer TTL (e.g., 24 hours or match workspace max lifetime) and remove explicit revocation entirely.

**Pros**: Simple, robust.
**Cons**: Tokens live longer than necessary. Mitigated by the fact that tool handlers validate task state independently.

## Recommendation

**Start with Option A** (remove revocation from `complete_task`). It's the lowest-risk fix that resolves the immediate problem. The tool handlers already validate task state independently, so a lingering token provides no meaningful privilege escalation. Follow up with Option B for proper architectural alignment.

## Acceptance Criteria

- [ ] Agent can call MCP tools after `complete_task` without errors
- [ ] Agent can call MCP tools across multiple tasks in the same session
- [ ] Token is still cleaned up eventually (KV TTL or task-runner cleanup)
- [ ] Error message for genuinely expired tokens is informative (not "Command failed with no output")
- [ ] Unit tests cover the token lifecycle across task completion
- [ ] Integration test: call `complete_task` → call `get_instructions` → verify success
