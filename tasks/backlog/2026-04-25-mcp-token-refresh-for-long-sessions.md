# MCP Token Refresh for Long-Lived Agent Sessions

**Priority**: MEDIUM — affects all agent sessions that exceed 4 hours (common with `/do` workflow + continuations)
**Created**: 2026-04-25

## Problem

MCP tokens are minted once at task start and stored in KV with a 4-hour TTL (`DEFAULT_MCP_TOKEN_TTL_SECONDS`). There is no refresh mechanism. When an agent session runs longer than 4 hours (which happens regularly with the `/do` workflow, especially across context continuations), the KV entry auto-expires and **all `sam-mcp` tool calls fail permanently** for the rest of the session.

The error manifests as OAuth-looking validation failures because the MCP server can no longer authenticate the request — the token simply doesn't exist in KV anymore.

### Impact

- Agents lose access to knowledge graph, idea creation, task management, session tools, and all other MCP capabilities mid-session
- The `/do` workflow regularly exceeds 4 hours (research + implement + review + staging + PR), especially for complex features
- Session continuations (context compaction → new session) inherit the same MCP token but the KV TTL doesn't reset
- There is no user-visible error or recovery path — tools just start failing

## Research Findings

### Current Flow
1. Task starts → `task-runner.ts` calls `storeMcpToken()` → KV entry with 4h TTL
2. Token injected into workspace environment (MCP server config)
3. Agent makes tool calls → `authenticateMcpRequest()` → `validateMcpToken()` reads from KV
4. After 4h → KV entry auto-expires → all tool calls return auth errors
5. No mechanism to refresh or extend the token

### Key Files
- `apps/api/src/services/mcp-token.ts` — `storeMcpToken()`, `validateMcpToken()`, `generateMcpToken()`
- `apps/api/src/routes/mcp/_helpers.ts` — `authenticateMcpRequest()` (line 263)
- `packages/shared/src/constants/defaults.ts:88` — `DEFAULT_MCP_TOKEN_TTL_SECONDS = 4 * 60 * 60`
- `apps/api/src/durable-objects/task-runner/` — where token is minted and injected

### Prior Incident
- `docs/notes/2026-03-17-mcp-token-ttl-too-short-postmortem.md` — TTL was previously reduced to 30 min, breaking all tasks > 30 min. Fixed by aligning TTL to max task execution time (4h). But max execution time ≠ max session time when continuations are involved.
- Regression guard test: `apps/api/tests/unit/services/mcp-token.test.ts:63` asserts `DEFAULT_MCP_TOKEN_TTL_SECONDS >= DEFAULT_TASK_RUN_MAX_EXECUTION_MS / 1000`

## Proposed Solutions

### Option A: Sliding Window TTL (Simplest)

On every successful `validateMcpToken()` call, refresh the KV TTL:

```typescript
export async function validateMcpToken(kv: KVNamespace, token: string): Promise<McpTokenData | null> {
  const key = `${MCP_TOKEN_PREFIX}${token}`;
  const data = await kv.get<McpTokenData>(key, { type: 'json' });
  if (data) {
    // Refresh TTL on every successful validation — sliding window
    await kv.put(key, JSON.stringify(data), {
      expirationTtl: getMcpTokenTTL(),
    });
  }
  return data;
}
```

**Pros**: Minimal code change. Token stays alive as long as the agent is actively using it.
**Cons**: Extra KV write on every tool call (adds ~1-2ms latency). Token never expires while agent is active (security concern if token is leaked).

### Option B: Explicit Refresh Endpoint

Add `POST /api/mcp/refresh-token` that the MCP server calls when it detects an auth failure. The workspace callback token authenticates the refresh request. Returns a new MCP token.

**Pros**: Clean separation. Token lifecycle is explicit.
**Cons**: More complex. Requires MCP server to handle retry-with-refresh logic.

### Option C: Longer TTL + Max Lifetime Cap

Set TTL to 24h but add a `maxLifetime` field to the token data. `validateMcpToken()` checks both KV existence and `createdAt + maxLifetime > now`.

**Pros**: Simple. Covers even multi-day continued sessions.
**Cons**: Longer window for leaked tokens.

## Recommendation

**Option A (Sliding Window TTL)** is the simplest fix and directly solves the problem. The extra KV write per tool call is negligible. Add a hard max lifetime (e.g., 24h from creation) as a safety cap so leaked tokens can't live forever.

## Implementation Checklist

- [ ] Modify `validateMcpToken()` to refresh KV TTL on successful validation
- [ ] Add `maxLifetimeSeconds` check against `createdAt` in token data (cap at 24h)
- [ ] Update regression guard test to cover the sliding window behavior
- [ ] Add test: token remains valid after repeated calls spanning > 4h (mock time)
- [ ] Add test: token expires after max lifetime even with continuous use
- [ ] Update `docs/notes/2026-03-17-mcp-token-ttl-too-short-postmortem.md` with reference to this fix

## Acceptance Criteria

- [ ] MCP tokens remain valid for agent sessions that exceed 4 hours, as long as the agent is actively making tool calls
- [ ] Tokens expire after max lifetime (24h) regardless of activity
- [ ] Tokens still expire after 4h of inactivity (sliding window)
- [ ] No regression in token revocation on task completion
- [ ] Existing regression guard test still passes
