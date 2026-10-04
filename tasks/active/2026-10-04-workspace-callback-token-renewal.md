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
- [x] `jwt.ts`: renewal signing preserves generation (`gen_iat`); claim readers live in
      `callback-token-claims.ts` (tests partially mock `jwt.ts`); stale guard reads `gen_iat` first
- [x] New service `workspace-callback-token-renewal.ts`: dual-proof verification, D1 binding checks
      (node, owner, active, non-terminal node), due check, JIT re-check, mint; VM-only delivery mint
      with post-sign incarnation re-read. Superseded-generation refusal dropped: `agent_sessions.updated_at`
      has non-recovery writers (credential attribution, suspend/resume), so it would refuse the live
      container; `gen_iat` preservation keeps the stale guard intact instead.
- [x] New callback route file `routes/workspaces/callback-token-renewal.ts` mounted in
      `routes/workspaces/index.ts`; node proof in the JSON body (Workers Logs records headers; custom
      header redaction is undocumented); `Cache-Control: no-store`; designed 401/403/410; IDs-only logs
- [x] `node-agent-session-snapshots.ts`: include fresh token on hibernate when bound + active (VM only)
- [x] Env vars documented: env-reference skill (API `CALLBACK_TOKEN_*`, agent `WORKSPACE_CALLBACK_TOKEN_*`,
      `MSG_AUTH_RENEWAL_WAIT`), public VM agent reference

### VM agent
- [x] Config: renewal ratio (clamped), retry initial/max, request timeout
- [x] `workspace_callback_token_renewal.go`: due selection with injected clock, request with both
      tokens, response classification, bounded backoff, rejection latch keyed on the token, CAS apply
- [x] Hook renewal after successful heartbeat (TryLock, like ready/eviction retries)
- [x] `upsertWorkspaceRuntime`: never adopt an earlier-expiring token; persist then propagate
- [x] `acp.SessionHost`: lock-free current-token accessor + `SetCallbackToken`; replace reads
- [x] `messagereport`: stale-token retry, park-on-401 without deleting rows, resume on new token,
      pause beyond `MSG_AUTH_RENEWAL_WAIT` reported once (slog.Error + node errorreport)

### Tests
- [x] Workers test through the real route (29): renew success (gen preserved, scope, new exp),
      expired denied, node-as-workspace and workspace-as-node proofs denied, foreign/moved node,
      owner mismatch, deleted/stopped/terminal node 410, missing row 410, claim/path mismatch, not-due,
      concurrent renewals, downstream route accepts the renewed token, VM-only delivery, hibernate body
- [x] Unit (14, real SQLite): delete/move/rebind between reads, Instant excluded, D1 throw → null,
      deletion during renewal mint → 410, legacy unscoped proofs, exp boundary, ratio clamping;
      stale guard uses `gen_iat` with the real signer
- [x] Go: clock crosses threshold/24h; expired offered once; latch per token; backoff; node-credential
      retry; CAS vs concurrent delivery; earlier-expiry delivery ignored; node token untouched;
      propagation to reporter + every host of the workspace only; restart hydration; reporter
      park/resume/stale-401/no-duplicate/budget/bounded; hibernate handler uses delivered token
- [x] `go test -race` for server, messagereport, acp, config

### Docs / rollout
- [x] Public docs: security architecture (callback token scopes, lifetime, renewal), VM agent env
- [x] Rollout note (PR body): API push heals old agents for snapshot calls only (proven against pinned
      7a9782c90 source); other consumers need new nodes; no hot replacement; AI proxy env token
      residual → SAM Idea 01M432G3276YZWCP3HEJ5B25J5

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

## Discrimination evidence

Each guard was removed once and the intended tests went red, then restored:
API M1 node binding, M2 owner binding, M3 node proof, M4 not-due gate, M5 gen preservation,
M6 claim/path, M7 delivery status, M8 post-sign re-read, M9 Instant exclusion, M10 renewal JIT.
Agent A1 expiry ordering, A2 CAS, A3 refusal latch, A4/A5 propagation, A6 persistence, A7 node
credential retry; reporter R1/R2/R4/R5/R6; SessionHost S1; upsert publish U1. R3 (resume bookkeeping)
is not a guard: parking is keyed on the rejected token, so a new token resumes by construction.

## References

- `.claude/rules/28-credential-resolution-fallback-tests.md`, `.claude/rules/34` (callback auth),
  `packages/vm-agent/.claude/rules/54-vm-agent-rollout-compatibility.md`, rule 46, rule 62, rule 73
