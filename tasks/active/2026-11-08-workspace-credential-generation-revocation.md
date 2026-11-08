# Revoke Workspace Credentials Across Reactivation (Credential Generations)

**Created**: 2026-11-08
**SAM task**: 01M6YNJDB3328SQ43281EEH7T1 (branch `sam/finish-workspace-credential-revocation-eeh7t1`)
**Continues**: task 01M6Y0DAXRD0S56125X2TQA7RF / PR #2590 (f375bf66f), which left this gap as an
"accepted residual" that Raphaël never accepted.
**Coordination**: channel `feature.byoc-security-2026-11-08`.

## Problem Statement

Raphaël's outcome: a stopped or replaced workspace must not keep credentials that can fetch secrets
or change current SAM state. #2590 refuses every credential while its workspace is inactive, but an
unexpired credential works again as soon as the same workspace ID is active again:

- A VM restart or rebuild keeps the workspace callback JWT and the agent sessions' MCP tokens.
- An Instant (cf-container) wake or crash recovery mints a new workspace JWT, node JWT and MCP token,
  but the previous container generation's credentials stay valid until they expire (24h).

## Research Findings (main @ 80f6cec9b)

Reactivation paths for the same workspace ID (others create a new ID):

| Path | Code | Rotated today | New credentials delivered |
|---|---|---|---|
| VM restart (stopped/error/evicted) | `routes/workspaces/lifecycle.ts` → `reserveWorkspaceRestart` | `workspaces.eviction_generation` | none (agent keeps its token, persisted MCP lists) |
| VM rebuild (running/recovery/error) | `lifecycle.ts` rebuild route | `eviction_generation` | none |
| Instant wake / crash recovery | `VmAgentContainer.beginUnexpectedRecovery` → `persistRuntimeRecovering` → `wakeFromSnapshot` | `nodes.runtime_incarnation_id` | node JWT (env), workspace JWT (`POST /workspaces`, `/restore`), MCP (`prepareSessionRestoreMcp`) |
| VM sleep/wake, evicted auto-recovery | `session-recovery.ts` | n/a: a **new workspace row** | fresh everything; old row stays inactive (#2590 refuses) |

Credential facts:

1. Callback JWTs carry `{workspace, scope, iat, [gen_iat]}` only; no runtime identity. All
   sinks verify through `verifyCallbackToken` (`services/jwt.ts`), ~15 call sites.
2. MCP tokens are opaque KV entries (`McpTokenData`) checked by `validateActiveWorkspaceMcpToken`
   (`/mcp`, webhook claims, GCP deployment identity), which already reads the workspace row.
3. Instant node rows are 1:1 with the workspace; the container's env `CALLBACK_TOKEN` node JWT is
   readable inside the container and authenticates heartbeats, errors and the snapshot upload relay.
4. The VM agent restart/rebuild decoder uses `DisallowUnknownFields` (`workspace_reprovision.go`), so
   an old agent rejects a new `callbackToken` field with 400 before any state change.
5. The VM agent's local git-credential endpoint accepts any signature-valid workspace JWT for the
   workspace (`git_credential.go:isValidCallbackAuth`).
6. Agent-side token adoption refuses a delivered token that expires earlier than the current one;
   agent ignores `gen_iat`.
7. Restarts are rare in production (read-only query 2026-11-08: 10 stopped VM workspaces on
   running nodes, none restarted in 30 days).

## Design

One opaque **credential generation** per workspace and per node, stored in D1 and embedded in
every credential minted for that runtime. Reactivation rotates it in the same D1 write that
reactivates the runtime, then mints the new runtime's credentials with the new value.

- Columns: `workspaces.callback_generation`, `nodes.callback_generation` (nullable TEXT, migration
  ADD COLUMN only). NULL means "never rotated since this release": claimless (pre-release)
  credentials are accepted only while the column is NULL, so they die at the first rotation.
- Callback JWT claim `cgen`. `verifyCallbackToken` (the single credential choke point) reads the
  token's row by scope and rejects (401) when the claim differs from the column. A missing row
  falls through to the sinks' existing 410 handling.
- MCP token data `callbackGeneration`; `validateActiveWorkspaceMcpToken` compares it in its existing
  row read and revokes on mismatch (a rotated generation never comes back).
- Rotation values reuse the existing incarnation ids: the new `eviction_generation` ULID on VM
  restart/rebuild, the new `runtime_incarnation_id` on Instant recovery.
- VM restart/rebuild sends a freshly minted current-generation `callbackToken` in the restart body.
  A new agent installs it before provisioning and rotates each persisted session's `sam-mcp` token
  through a dual-proof endpoint (`POST /api/workspaces/:id/mcp-token/rotate`: current callback JWT +
  the old MCP token; copies the token's context, keeps its `createdAt`, revokes the old one).
  An old agent rejects the field with 400, so restart fails closed with an actionable error
  (policy 91fe011f "fail closed instead of insecure fallback").
- The workspace callback identity snapshot gains `callbackGeneration`, so rule-49 final fences and
  callback CAS writes catch an A→B rotation between authentication and side effect.
- VM agent local git-credential endpoint requires the presented JWT's `cgen` to equal the current
  runtime token's.

Not changed: VM node tokens (no rotation event for VM node rows; held only by the vm-agent),
the Instant stale-callback heuristic (now redundant for claimed tokens; kept as defence in depth).

## Implementation Checklist

### API
- [ ] Migration `0227_callback_generation.sql` + `schema.ts` columns
- [ ] `callback-token-claims.ts`: `cgen` claim + reader; `signCallbackToken` / `signNodeCallbackToken` accept `callbackGeneration`
- [ ] `verifyCallbackToken`: generation check against D1 by scope; payload returns `callbackGeneration`
- [ ] Rotation: `persistRuntimeRecovering` (node + workspace = new incarnation); `reserveWorkspaceRestart`; rebuild active-path update
- [ ] Mint sites carry the current generation: Instant wake (node + workspace JWT), restart/rebuild token, hibernate delivery, renewal (preserve), heartbeat node refresh, creation/dispatch sites
- [ ] Restart/rebuild send `callbackToken`; old-agent 400 maps to a clear fail-closed error
- [ ] MCP: `callbackGeneration` stored at every `storeMcpToken` site; verified in `validateActiveWorkspaceMcpToken`
- [ ] MCP rotate endpoint (dual proof, rule 49 fence, revoke old)
- [ ] `WorkspaceCallbackIdentitySnapshot.callbackGeneration` in loaders, comparator, CAS

### VM agent
- [ ] Restart/rebuild accept `callbackToken`; validate workspace + scope; install (replace, persist, propagate) before provisioning
- [ ] Rotate persisted `sam-mcp` session tokens after install, before agent sessions start
- [ ] Git-credential endpoint: JWT path requires matching `cgen`

### Tests
- [ ] Real-SQL + real-JWT A→B tests per path: VM restart, VM rebuild, Instant recovery: A refused / B accepted at secret (agent-key, git-token), AI proxy, state (messages, task callback, activity), node sinks (heartbeat, snapshot relay)
- [ ] MCP: A's token refused + revoked at `/mcp`, webhook claims, deployment identity after B; B's works; rotate endpoint (attack: A-token-only, other workspace, B control)
- [ ] Legacy claimless tokens: accepted while column NULL, refused after rotation
- [ ] Renewal keeps generation; heartbeat refresh keeps node generation; ABA fence (identity snapshot)
- [ ] Go: restart token install + persistence + propagation; MCP rotation; old-API compatibility (no field); git credential cgen
- [ ] Discrimination: delete each guard once, record reddened tests

### Docs
- [ ] `architecture/security.md` Callback Tokens: replace the residual paragraph
- [ ] `apps/api/.claude/rules/34` + vm-agent copy: generation rule
- [ ] Archive `tasks/backlog/2026-07-21-extend-stale-instant-callback-guard-coverage.md` (superseded) with evidence

## Acceptance Criteria

- [ ] Credential captured for incarnation A is refused after A stops/sleeps/is replaced and the same workspace ID runs as B, at secret, AI-proxy, state and node sinks, and for MCP (`/mcp`, webhook claims, deployment identity)
- [ ] B's credentials work, including renewal and ordinary in-process token renewal of B
- [ ] Shutdown/telemetry callbacks of A keep working until B starts
- [ ] Old VM agents fail closed on restart with a clear message; old APIs keep working with new agents
- [ ] Independent adversarial reviewer actively tried to reuse A after B starts
- [ ] Staging: old-token rejection and woken-agent functionality on Instant wake and VM restart

## References
- PR #2590, `tasks/archive/2026-11-08-harden-workspace-credential-revocation.md`
- `.claude/rules/28`, `49`, `54` (vm-agent rollout), `61`, `62`, `74`, `apps/api/.claude/rules/34`
