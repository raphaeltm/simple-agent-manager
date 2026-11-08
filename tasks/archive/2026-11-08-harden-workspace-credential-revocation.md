# Harden Workspace Credential Revocation and Callback Lifecycle

**Created**: 2026-11-08
**SAM task**: 01M6Y0DAXRD0S56125X2TQA7RF (branch `sam/harden-workspace-credential-revocation-tqa7rf`)
**Source**: Source-only Cloudflare security-audit report (Library `01M6XBX8SZDQGD5ZK87NDE3Y5P`,
`/engineering/security/cloudflare-security-audit-findings-2026-11-08.md`), §5.4 and §5.7 items 1-2.
**Coordination**: channel `feature.byoc-security-2026-11-08` (sibling: trial-system removal).

## Problem Statement

Raphaël's priority: a stopped or replaced workspace must not keep credentials that can fetch
secrets or change SAM state or the current workspace. The audit is source-only and proves no live
exploit. This task checks each claim against current `main` and fixes only what the evidence shows.

## Credential Map (verified against `main` @ e4934fddf)

| Credential | Minted by | Renewed by | Bound to | Revocation mechanism |
|---|---|---|---|---|
| Workspace callback JWT (`aud=workspace-callback`, `scope=workspace`) | `signCallbackToken` (`services/jwt.ts`) at create/dispatch/Instant wake/hibernate delivery | `renewWorkspaceCallbackToken` (dual proof, VM-only, active-only) | workspace ID | D1 status + node status + incarnation re-read (`assertWorkspaceAcceptsCallback`, `assertWorkspaceCallbackIdentityCurrent`); 24h TTL |
| Node callback JWT (`scope=node`) | `signNodeCallbackToken` at provisioning/Instant wake | heartbeat response while node non-terminal | node ID | `nodeStatusTerminatesCallbacks`; 24h TTL |
| Workspace MCP token (opaque, KV) | `storeMcpToken` per agent session/task | sliding idle TTL (8h), hard max 24h | project/user/workspace/task | explicit `revokeMcpToken` on task completion/failure; TTL |
| Node-management JWT (control plane → VM) | `signNodeManagementToken` | none (short TTL) | node (+ workspace) | TTL; VM checks node/workspace claim |

## Research Findings

1. **CONFIRMED: the AI proxy ignores the workspace lifecycle.** `verifyAIProxyAuth`
   (`services/ai-proxy-auth.ts`) checks only that the token is workspace-scoped and the row exists.
   A workspace token for a `stopped`, `sleeping`, `deleted` or `error` workspace, or one whose node
   is stopping/destroyed, can still spend platform, project or user model credentials through
   `/ai/v1/*`. It contradicts `architecture/security.md` ("Deleting or stopping a workspace ends its
   callback authority at once").
2. **CONFIRMED: workspace MCP tokens ignore the workspace lifecycle.** `authenticateMcpRequest`
   (`routes/mcp/_helpers.ts`), the webhook-claim redemption route (`routes/mcp/webhook-claims.ts`,
   which returns a secret) and the GCP deployment identity endpoint (`routes/project-deployment.ts`,
   which signs a WIF token) accept the KV token for up to 24h after the workspace stopped or was
   deleted. Tokens are revoked only on task-runner completion/failure.
3. **CONFIRMED (compat debt, not exploitable cross-scope): legacy unscoped callback tokens are still
   accepted.** `verifyCallbackToken` accepts a missing `scope` claim. `verifyWorkspaceCallbackAuth`,
   `verifyNodeCallbackAuth` (default), `workspace-resource-history-callback.ts`, `_callback-auth.ts`
   and other inline checks carry a `scope === undefined` branch. No minting path has issued an
   unscoped token since #483 (2026-03-23). Every token is minted by the API with a 24h default
   lifetime, and every renewal path mints scoped tokens, so no legitimate unscoped token can still be
   in circulation unless a self-host set `CALLBACK_TOKEN_EXPIRY_MS` above ~7 months.
4. **CONFIRMED (intentional, tightened): Instant stale-callback guard fails open when ambiguous.**
   `isSupersededInstantCallback` processes callbacks with missing `iat`, non-Instant runtime, or a
   gap inside the margin. Every minting path sets `iat`, so a token without one cannot be a
   legitimate SAM token. Requiring `iat` at verification removes that ambiguity. Non-Instant runtimes
   and the in-margin case are deliberate: VMs never swap generations under one token, and failing
   closed on in-margin gaps would stop a crashed current container from failing its session.
5. **VERIFIED SAFE: secret-delivery callbacks are fenced.** `agent-key`, `agent-settings`,
   `runtime`, `runtime-assets`, `git-token`, `bootstrap-token`, `boot-log` and renewal re-read the
   full incarnation before delivery (rule 49). They reject non-active workspaces and terminal nodes.
6. **VERIFIED: workspace node binding never moves.** Placement sets `node_id` only while it is NULL
   (`workspace-placement.ts`), so a workspace token cannot follow a workspace to another node. A
   deleted node nulls `node_id`, which fails the identity check.
7. **ACCEPTED RESIDUAL (documented, tracked): an active workspace ID reuses its credential across
   incarnations.** A VM restart or rebuild keeps the workspace's token because the VM agent keeps it
   and `restartWorkspaceOnNode` sends no new one. Revoking at restart would need a VM-agent protocol
   change, and old agents would break on upgrade. An Instant wake mints a fresh token, but the
   previous generation's token stays valid for its remaining TTL while the workspace is active again.
   While a workspace is not active, every sink refuses after this change. Exfiltrated copies expire
   within `CALLBACK_TOKEN_EXPIRY_MS` and cannot renew without the node token. The durable
   generation-epoch fix stays tracked in `tasks/backlog/2026-07-21-extend-stale-instant-callback-guard-coverage.md`.

## Permitted vs Forbidden After Stop / Delete / Replacement

- **Permitted terminal cleanup** (unchanged): node heartbeat and node error reports while the node
  is non-terminal; a provisioning-failure report for a workspace in `error`; idempotent eviction
  replays; resource-telemetry flushes; deletion-unconfirmed signalling. Stale-generation destructive
  callbacks are rejected with designed 4xx/410. Snapshot routes need an active workspace, because
  the snapshot is taken before the sleep transition.
- **Forbidden**: secret delivery (agent key, git token, runtime assets, registry creds, webhook
  claims, GCP identity tokens), AI proxy spend, MCP tool calls, token renewal, and state-mutating
  callbacks for a non-active workspace or terminal node.

## Implementation Checklist

- [x] `verifyCallbackToken` requires a valid `scope` and a positive integer `iat`; `CallbackTokenPayload.scope` becomes required (also the shared `CallbackTokenClaimsSchema`)
- [x] Remove every `scope === undefined` legacy branch (`_helpers.ts`, `node-callback-auth.ts` incl. the `requireExplicitScope` option, `_callback-auth.ts`, `workspace-resource-history-callback.ts`, `node-acp-heartbeat.ts`, `workspace-eviction-callback.ts`)
- [x] `verifyNodeCallbackAuth` re-checks `payload.scope === 'node'` after verification (defence in depth)
- [x] AI proxy: require the token's workspace to be active (`creating`/`running`/`recovery`) on a non-terminal node (`verifyAIProxyAuth`), plus a deletion-unconfirmed signal
- [x] MCP: `validateActiveWorkspaceMcpToken` (new `services/mcp-token-lifecycle.ts`) used by `authenticateMcpRequest` (covers `/mcp` and webhook claims) and the deployment identity endpoint; revokes on deleted/missing/identity mismatch, rejects otherwise
- [x] codex-refresh: rule-49 incarnation re-check before returning rotated OAuth tokens (the DO has already persisted them)
- [x] build-started: lifecycle check before notifying the TaskRunner
- [x] acp-interaction callbacks: shared lifecycle check (adds node-terminal rejection)
- [x] Tests: legacy/missing-iat tokens rejected (`node-agent-contract`, `callback-token-unified-scope`, renewal, observability ingestion)
- [x] Tests: AI proxy (`ai-proxy-auth-lifecycle.test.ts`) and MCP (`mcp-token-lifecycle.test.ts`) with a real SQL engine, owner controls, route-level stop→refuse; build-started and acp-interaction real-state cases; codex-refresh mid-flight stop
- [x] Discrimination verified: removing each guard reddens exactly its attack tests (build-started 7, AI proxy 9, verifier scope 2, MCP 20, codex fence 1)
- [x] Update existing tests that relied on legacy acceptance, or seeded no workspace for MCP tokens (`seedActiveMcpWorkspace`, `seedActiveMcpTokenWorkspace`)
- [x] Docs: `architecture/security.md` Callback Tokens (revocation semantics, permitted cleanup, residual); API rule 34 lesson
- [x] Note on the Instant epoch backlog task; deploy-env status gap filed as `tasks/backlog/2026-11-08-deploy-release-env-status-gate.md`

### Decisions (not fixed, with reasons)

- Session-snapshot routes check lifecycle at entry only (no final fence): they are sleep-time
  writes the active workspace makes; low value, documented in the inventory.
- Heartbeat node-token refresh has no re-read between CAS and signing: a token minted to a node
  that turns terminal in that window grants nothing, because every node callback rejects terminal nodes.
- Resource-history telemetry has no lifecycle gate: it is a permitted terminal flush, bound to
  project/node identity, idempotent and size-bounded.
- Instant generation / VM restart credential reuse: accepted residual (finding 7).

## Acceptance Criteria

- [ ] A workspace token for a non-active workspace cannot use the AI proxy (test)
- [ ] A workspace MCP token for a non-active workspace cannot call MCP tools, redeem webhook claims, or mint GCP identity tokens (test)
- [ ] An unscoped or `iat`-less callback token is rejected everywhere (test)
- [ ] Active workspaces keep working through AI proxy, MCP, and callbacks (control tests)
- [ ] Staging: a live agent session works (AI/MCP/callbacks), and after stop the old credentials are refused
- [ ] Independent adversarial security review passes

## References

- `.claude/rules/28-credential-resolution-fallback-tests.md`, `11-fail-fast-patterns.md`,
  `apps/api/.claude/rules/34-vm-agent-callback-auth.md`, `apps/api/.claude/rules/49-*`

## Review Results (Phase 5)

| Reviewer | Status | Outcome |
|---|---|---|
| security-auditor (independent adversarial) | PASS | 0 CRITICAL/HIGH/MEDIUM. LOW-1 self-host note added to security.md; LOW-2 per-request (not mid-stream) check accepted as the architecture-wide admission pattern |
| cloudflare-specialist | PASS | 2 optional LOWs: D1 fault → 500 on MCP auth (a genuine fault, intended); duplicated workspace⋈node join (not consolidated — AI proxy needs extra columns, MCP needs per-reason logs) |
| doc-sync-validator | ADDRESSED | MEDIUM: rule copied to `packages/vm-agent/.claude/rules/34`; LOW: full ending-node list in security.md |
| task-completion-validator | PASS | All six checks pass; it independently confirmed the AI-proxy guard discriminates (14/19 red); only staging remained pending |

## Staging Verification (2026-11-08, run 42517040887, branch rebased on main a84ae0859)

- One Instant chat in project Potato (staging smoke user, Claude Code profile on the Instant runtime): the agent replied, so agent-key and message callbacks were accepted.
- The session slept on its own, with workspace and node both `sleeping`. Replaying the session's MCP token (read from staging KV) gave **401**.
- A follow-up woke the session. The woken agent called `get_instructions` and got "Potato". The original token gave **200** again: rejected while inactive, kept for the same session.
- After a session stop (`workspaceDeleted: true`), the token gave **401**, and both of the session's KV MCP tokens were revoked (KV key gone after replay). The workspace row is gone; the node is `deleted`.
- "Agent credential fetched" was recorded for both container generations, and there were no new platform errors.
- Not exercised live: the AI proxy refusal path. Staging has no platform-proxy (`sam`) sessions (all recent sessions are `direct`/user credential), and the callback token can't be extracted (encrypted at rest; agents only see it in proxy mode). It is covered by `ai-proxy-auth-lifecycle.test.ts` with real JWTs and real SQL through `prepareAIProxyRequest`.
- Not run: the Playwright UI pass. The restored workspace lacks Chromium system libraries and the node disk is full. The PR changes no UI. API-level checks (dashboard, project, sessions and nodes endpoints, app root) all returned 200.
- Cleanup: 0 live VM nodes; the test workspace and node are deleted; local token and cookie files are deleted.
