# Fix recurring Codex OAuth refresh-family revocation

- SAM Task: `01KXQKQR630MAQ5P289WSWNXHS`
- SAM Idea: `01KXBD9EZGQPR0NSDJNKVK0YC5`
- Output branch: `sam/investigate-fix-validate-ship-swnxhs`

## Problem Statement

On 2026-07-11 two production Codex tasks failed in the same minute with refresh-token-family revocation despite the existing per-user `CodexRefreshLock`. Production correlation observed no `/api/auth/codex-refresh` request or persisted rotation before the failure; the later `cc_credentials` insertion was a manual replacement. PRs #1439 and #1445 correctly mirror and serialize refreshes that reach the proxy, but cannot protect a rotation outside that path.

The incident must be reproduced or directly verified using the currently installed Codex runtime. The fix must follow the proven route and preserve the existing lock, grace window, scope validation, encryption, and fail-closed security boundaries.

## Research Findings

- `packages/vm-agent/internal/acp/gateway.go` pins `@agentclientprotocol/codex-acp@1.1.2`, whose dependency is `@openai/codex@^0.144.0`. Because installation is an un-locked global npm install, July 11 resolved Codex `0.144.1`; current installs resolve `0.144.5`.
- Direct inspection of the official `0.144.1` shipped Linux binary confirms it contains `CODEX_REFRESH_TOKEN_URL_OVERRIDE`, `env_refresh_token_url_override_present`, and the refresh implementation in `login/src/auth/default_client.rs`. The exact override name was therefore supported by the incident runtime; injection compatibility alone does not prove requests reached the proxy.
- `packages/vm-agent/internal/acp/session_host_startup.go` injects the override for `openai-codex` OAuth credentials when both control-plane URL and callback token exist.
- `packages/vm-agent/internal/acp/session_host_lifecycle.go` syncs `auth.json` only after `Suspend`/`Stop`, by reading the file once after the agent exits. There is no durable watcher or prompt-boundary sync while a long-running process remains alive. Thus any direct/upstream rotation can remain unpersisted indefinitely and another workspace can be seeded with the consumed family member.
- `packages/vm-agent/internal/server/workspace_callbacks.go` and `apps/api/src/routes/workspaces/runtime.ts` already provide an authenticated callback and encrypted dual-write path. The callback currently transports the full credential in the request body (never logs it), compares it with the encrypted stored value, and updates legacy plus active CC storage.
- `syncAgentCredentialToCC` deletes old attachments but leaves superseded `cc_credentials` and configurations active. Resolution currently joins active attachments, so attached selection is safe, but orphaned active rows remain misleading and unsafe for any direct active-row consumer.
- The retained 2026-06-30 incident shows two prior real bugs: missed dual-write (#1439) and async DO concurrency (#1445). It also established the safe sanitized upstream diagnostic. This recurrence's no-proxy/no-persist evidence is a different failure class.
- Relevant rules: `.claude/rules/02-quality-gates.md`, `10-e2e-verification.md`, `13-staging-verification.md`, `14-do-workflow-persistence.md`, `28-credential-resolution-fallback-tests.md`, `34-vm-agent-callback-auth.md`, `35-vertical-slice-testing.md`, `41-credential-snapshot-resilience.md`, `44-dual-write-migration-enumerate-writers.md`, and `45-durable-object-concurrency-mutex.md`.

## Implementation Checklist

- [x] Pin the verified Codex CLI build exactly across the manifest, direct install fallback, and VM-agent container image; verify the incident build and pinned build both contain the override contract without logging environment values or auth material.
- [x] Add durable in-session `auth.json` change detection and sync-back for Codex OAuth credentials, with configurable poll/callback bounds, lifecycle cancellation, and no credential-bearing logs.
- [x] Capture stop/suspend credential metadata before lifecycle cleanup and use the latest accepted rotation for crash recovery.
- [x] Make live and final sync ordered with a previous-credential hash, including an atomic database compare-and-swap for simultaneous callbacks.
- [x] Reject malformed, mismatched, and superseded credential payloads while preserving callback scope authentication, encryption, and dual-write behavior.
- [x] Leave unattached active CC rows unchanged: resolution requires an active attachment, so production evidence did not support destructive stale-row deactivation.
- [x] Surface a sanitized, actionable platform error when a stored Codex family is superseded/revoked, without exposing upstream bodies or credential material.
- [x] Instrument sanitized vm-agent sync and control-plane rejection milestones without credential, path, token-body, or Authorization-header fields.
- [x] Add Go tests for watcher rotation, lifecycle snapshot ordering, final ordered sync, crash-restart credential reuse, callback contract, permanent superseded handling, and configuration.
- [x] Add API/DO tests for malformed payload rejection, hash mismatch, atomic concurrent rotation, encrypted dual-write, and sanitized persisted errors.
- [x] Run focused Go/API validation, Go race detection, repository typecheck, lint, and manifest synchronization checks.
- [ ] Complete `go-specialist`, `security-auditor`, `test-engineer`, `constitution-validator`, `doc-sync-validator`, and `task-completion-validator` reviews; address all correctness findings.
- [ ] Prepare and push the PR branch, then report `STAGING_LEASE_REQUEST` and wait for the parent workflow coordinator.
- [ ] After lease grant, deploy to shared staging and exercise a real current Codex session through refresh plus sync lifecycle while tailing both sanitized paths.
- [ ] Pass CI, merge under the existing authorization, and monitor production deployment.

## Acceptance Criteria

- The exact Codex build used by SAM is deterministically pinned/resolved and startup fails visibly if its required refresh compatibility cannot be established.
- A Codex OAuth rotation that changes `auth.json` during an active session is persisted promptly through the authenticated callback, not only when the session ends.
- A concurrent second workspace receives the latest stored family member and does not replay a known-consumed token.
- Proxy-routed refreshes remain serialized by the per-user DO mutex and retain grace-window, rate-limit, scope, and dual-write semantics.
- Callback and watcher error paths fail closed and expose only sanitized identifiers/status; credentials, `auth.json`, refresh/access tokens, authorization headers, and token bodies never appear in logs/errors.
- Malformed, cross-workspace, cross-user, wrong-agent, and stale/out-of-order sync attempts cannot replace the active credential.
- Tests discriminate override bypass/direct rotation from proxy rotation and cover negative security plus concurrent rotation cases across Go and API boundaries.
- Shared staging is untouched until the parent coordinator grants the lease; after grant, a real current Codex refresh and sync lifecycle passes end-to-end.
- Required specialists and task-completion validation pass, CI is green, the PR merges, and production deployment succeeds.

## References

- `packages/vm-agent/internal/acp/session_host_startup.go`
- `packages/vm-agent/internal/acp/session_host_lifecycle.go`
- `packages/vm-agent/internal/server/workspace_callbacks.go`
- `apps/api/src/durable-objects/codex-refresh-lock.ts`
- `apps/api/src/routes/workspaces/runtime.ts`
- `apps/api/src/services/composable-credentials/agent-sync.ts`
- `tasks/archive/2026-06-30-fix-production-codex-oauth-refresh-429.md`
