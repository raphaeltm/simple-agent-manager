# Secure renewal of workspace callback tokens for long-lived sessions

SAM task `01M42YQA8QPJQBW48KTDQFAHDE` (parent `01M42WJSH7238RWH5ZH7TSSFZG`), branch
`sam/fix-secure-renewal-workspace-qfahde`.

## Problem

Workspace-scoped VM callback JWTs (`signCallbackToken`, `apps/api/src/services/jwt.ts`,
default 24h via `CALLBACK_TOKEN_EXPIRY_MS`) are minted only when a workspace is created or
restored. The node heartbeat renews only the **node** token (`node-lifecycle.ts` heartbeat →
`refreshedToken` → `health.go:setCallbackToken`). A workspace awake more than 24h therefore
gets `401 Invalid or expired callback token` on every workspace-scoped callback.

### Production evidence (read-only, Workers Logs, 100% head sampling)

- `POST /api/workspaces/01M3Z4CGTEWNBP3VSTFQK90XJ1/session-snapshot/prepare` → 401 repeatedly
  2026-10-03 22:37Z … 2026-10-04 05:57Z (83 in the rolling 24h per the brief; the sleep could
  never complete).
- `POST /api/workspaces/01M3XX0HCA4H5XHXB9ZF3N0867/git-token` → 401 at 2026-10-03 12:31:57Z,
  about 24h after that workspace started (git credential fill failed).
- `POST /api/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/workspace-resource-history` → 401 several
  times 10-03 22:24Z … 10-04 05:11Z (resource-history spool deleted as "permanent").
- `POST …/messages` → **no 401 observed** 10-01 … 10-04: both long-lived sessions produced no
  agent output after their 24h mark (last message 200s for 01M3XX0H… at 10-02 20:56Z). Message
  loss is proven by code below, not by production observation.

## Research findings

### Token custody (VM agent)

- Canonical per-workspace store: `WorkspaceRuntime.CallbackToken` (`internal/server/server.go`),
  persisted encrypted in SQLite (`workspace_runtime_persistence.go`) and hydrated on restart
  (`workspace_routing.go` `upsertWorkspaceRuntime`). Token-only updates are **not** persisted today
  (`metadataChanged` is not set when only the token changes).
- Writers today: create-workspace, `UpdateAfterBootstrap`, a hibernate request body
  (`session_snapshot.go` `sessionSnapshotHandlerInput`, supported since 2026-07-11), and the
  restore body. The API only sends a body token on cf-container restore
  (`vm-agent-container.ts`), never on VM hibernate (`node-agent-session-snapshots.ts`).
- Consumers (24 call sites, full table in the session notes). Three custody classes:
  1. **Live reads** of `runtime.CallbackToken` at call time: git-token (helper and agent start),
     runtime-assets, task status callbacks, credential sync, eviction delivery (retried every
     heartbeat forever), resource history (401 ⇒ spool deleted), provisioning/recovery. These heal
     automatically once the runtime token is renewed.
  2. **Copies that outlive the request**: ACP `SessionHost` `h.config.CallbackToken` (agent-key,
     agent-settings, activity, usage, interactions/elicitation, URL completion); message reporter
     `authToken`; snapshot capture input (prepare/progress/complete/failure/artifacts); publish jobs.
  3. **Baked into the agent subprocess** at process start: platform AI proxy credential
     (`ANTHROPIC_AUTH_TOKEN`/`OPENAI_API_KEY`, `{wstoken}` base URLs, Codex `config.toml`) and the
     codex refresh URL. Cannot be rotated without restarting the agent process.
- `messagereport` treats 401 as **terminal**: `markTerminalPersistenceFailure` clears the session
  outbox and latches `terminalPersistenceFailure`; `Enqueue` then silently drops every later message
  (`sender.go:isTerminalBatchResponse`, `reporter.go`). So a chat awake >24h that produces output
  loses that output permanently until the agent restarts (code-proven; reproduced in tests).
- The workspace token is visible inside the devcontainer (agent env for SAM-proxy mode, Codex
  config). The node token is not in VM devcontainers (cf-container: the agent inherits the node
  token from the container env).

### Control plane

- `verifyWorkspaceCallbackAuth` is stateless (signature/scope/claim). Revocation of workspace
  callbacks is enforced per route through D1 state (`assertWorkspaceAcceptsCallback`: workspace
  status `creating|running|recovery`, node non-terminal, else 410).
- Message writes are idempotent server-side (`project-data/messages.ts`: dedupe by message id and
  user-content), so resending a batch that got 401 cannot duplicate rows. A 401 is raised before the
  body is read, so nothing was persisted.
- Instant (cf-container) stale-callback guard (`routes/_stale-callback-guard.ts`) compares the
  token `iat` to the row `updated_at`. A renewal that refreshes `iat` would hide a superseded
  container generation. Renewed tokens must carry the original generation issue time.
- Placement binds `workspaces.node_id` with `nodes.user_id = workspace user` and never moves a bound
  workspace (attach requires `node_id IS NULL`; evicted restart keeps the node).
- Existing dual-credential precedent: snapshot upload relay requires the workspace bearer plus the
  relay node's node-scoped bearer (`session-snapshot-upload-relay.ts`
  `verifySessionSnapshotRelayAuthorization`, headers `X-SAM-Relay-Node-ID` /
  `X-SAM-Relay-Authorization`).

### Design (no new trust boundary)

1. **API push on hibernate (heals running old agents, no binary rollout needed):**
   `hibernateAgentSessionOnNode` mints a fresh workspace token only when D1 confirms the workspace
   is active on the target node, and sends it as `workspaceCallbackToken` over the existing
   node-management channel (same channel that delivers the token at create/restore). Agents since
   2026-07-11 already store it before capture.
2. **Proactive dual-proof renewal (new agents):** `POST /api/workspaces/:id/callback-token/renew`
   requires the current, unexpired workspace token (`Authorization`) **and** the hosting node's
   node token (`X-SAM-Node-ID` / `X-SAM-Node-Authorization`). It renews only if the workspace is
   active, bound to that node, owned by the node's user, the node is non-terminal, and (Instant) the
   token generation is not superseded. A renewed token preserves the generation issue time (`gen`
   claim) so the stale-callback guard keeps working. Not-yet-due tokens are not re-minted.
   - A node token alone cannot obtain a workspace token (no widened node authority).
   - A workspace token leaked from a VM devcontainer cannot renew itself (needs the node token).
   - Expired tokens are never renewed (no expiry bypass); recovery is the control-plane push.
3. **Agent:** after each successful heartbeat, renew due tokens (past
   `WORKSPACE_CALLBACK_TOKEN_REFRESH_RATIO` of lifetime, default 0.5) with bounded backoff, latch
   definitive rejections, compare-and-swap the runtime token, persist it, and propagate every token
   change (renewal or control-plane push) to the message reporter and ACP session hosts.
4. **Message reporter:** a 401 is no longer terminal-and-destructive. If a newer token exists, retry
   with it; otherwise keep the outbox, send nothing, and resume when a new token arrives. Bounded by
   the existing outbox cap and a new configurable park budget, after which the old terminal
   behaviour applies (rule 54.13).
5. **ACP SessionHost:** read the callback token through a lock-free accessor that renewal updates
   (rule 46: nothing reachable from the ACP notification goroutine may take `mu`).

## Implementation checklist

### API
- [ ] `jwt.ts`: renewal signing preserves generation (`gen` claim); payload exposes generation;
      stale-callback guard reads generation before `iat`
- [ ] New service `workspace-callback-token-renewal.ts`: dual-proof verification, D1 binding checks,
      due check, Instant superseded check, mint; hibernate-delivery mint helper (active + bound)
- [ ] New callback route file `routes/workspaces/callback-token-renewal.ts` mounted in
      `routes/workspaces/index.ts`; `Cache-Control: no-store`; designed 401/403/410; IDs-only logs
- [ ] `node-agent-session-snapshots.ts`: include fresh token on hibernate when bound + active
- [ ] Env vars: `WORKSPACE_CALLBACK_TOKEN_RENEWAL_*` documented (`env.ts`, `.env.example`, docs)

### VM agent
- [ ] Config: renewal ratio, retry initial/max, request timeout; heartbeat parse unaffected
- [ ] `workspace_callback_token_renewal.go`: due selection with injected clock, request with both
      tokens, response classification, bounded backoff, rejection latch, CAS apply
- [ ] Hook renewal after successful heartbeat (TryLock, like ready/eviction retries)
- [ ] `upsertWorkspaceRuntime`: persist token changes and propagate to reporter + session hosts
- [ ] `acp.SessionHost`: lock-free current-token accessor + `SetCallbackToken`; replace reads
- [ ] `messagereport`: stale-token retry, park-on-401, resume on new token, bounded park budget

### Tests
- [ ] Workers test through the real route: renew success (gen preserved, scope workspace, new exp),
      expired token denied, node token as workspace proof denied, workspace token as node proof
      denied, foreign node denied, workspace on other node (moved) denied, user mismatch denied,
      deleted/stopped/evicted workspace 410, terminal node 410, claim/path mismatch, not-due no mint,
      Instant superseded denied, concurrent renewals
- [ ] Unit: hibernate push includes token only when bound + active; stale guard uses `gen`
- [ ] Go: clock crosses threshold/24h; expired not sent; rejection latch; backoff; CAS vs concurrent
      push; heartbeat (node) vs workspace token separation; propagation to reporter + session host;
      persistence across restart; reporter park/resume/no-duplicate/no-loss/budget; real HTTP path
- [ ] `go test -race` for the touched packages

### Docs / rollout
- [ ] Public docs: security architecture (callback token lifetime + renewal), env reference
- [ ] Rollout note: API push heals old agents for snapshot calls only; other consumers need the new
      agent (new nodes); no hot replacement; AI proxy env token residual risk → SAM Idea

## Acceptance criteria

- [ ] A VM workspace awake past 24h keeps working: snapshot prepare/progress/complete, git-token,
      runtime assets, messages, ACP activity/usage/interactions (new agent)
- [ ] Old agents: hibernate/snapshot callbacks succeed after 24h via the API push alone
- [ ] Renewal never mints for: expired tokens, node-only callers, foreign nodes, moved/deleted/
      stopped workspaces, terminal nodes, superseded Instant generations
- [ ] No message loss or duplication across a token rotation; 401 handling is bounded
- [ ] No tokens in logs; responses carrying tokens are `no-store`
- [ ] Independent security review passes; parent informed of the design

## Staging

User permitted skipping staging for this wave. Reason: the failure needs a workspace awake more
than 24h (or a VM with an injected clock), and the cross-boundary contract is fully exercised by
workers tests through the real route plus Go tests against an HTTP control plane. Substitute:
deterministic clock-injected Go tests, Miniflare workers tests through the real auth boundary,
`-race` runs, and post-deploy production log checks.

## References

- `.claude/rules/28-credential-resolution-fallback-tests.md`, `.claude/rules/34` (callback auth),
  `packages/vm-agent/.claude/rules/54-vm-agent-rollout-compatibility.md`, rule 46, rule 62, rule 73
