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
  is non-terminal, snapshot upload/complete/failure for sleep, deletion-unconfirmed signalling,
  stale-generation destructive callbacks rejected with designed 4xx/410.
- **Forbidden**: secret delivery (agent key, git token, runtime assets, registry creds, webhook
  claims, GCP identity tokens), AI proxy spend, MCP tool calls, token renewal, and state-mutating
  callbacks for a non-active workspace or terminal node.

## Implementation Checklist

- [ ] `verifyCallbackToken` requires a valid `scope` and a positive integer `iat`; `CallbackTokenPayload.scope` becomes required
- [ ] Remove every `scope === undefined` legacy branch (dead code after the verifier change)
- [ ] AI proxy: require the token's workspace to be active (`creating`/`running`/`recovery`) on a non-terminal node, with owner/project from the same read
- [ ] MCP: shared lifecycle check for workspace MCP tokens (active workspace, matching user/project, non-terminal node) used by `authenticateMcpRequest` (covers `/mcp` and webhook claims) and the deployment identity endpoint; revoke the KV entry when the workspace is gone or terminal
- [ ] Tests: legacy/malformed/missing-iat tokens rejected; wrong scope/resource/user rejected
- [ ] Tests: AI proxy and MCP with a real SQL engine: stopped/sleeping/deleted/error workspace and stopping node rejected; active workspace accepted (owner control); user/project mismatch rejected
- [ ] Tests: TOCTOU/renewal stays covered (existing renewal tests); stale token after stop rejected; current lifecycle succeeds
- [ ] Update existing tests that relied on legacy acceptance
- [ ] Docs: `architecture/security.md` (callback + MCP revocation semantics, residuals), `reference/vm-agent.md`/`configuration.md` if they mention legacy tokens; API rule 34 note
- [ ] Note on the Instant epoch backlog task

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
