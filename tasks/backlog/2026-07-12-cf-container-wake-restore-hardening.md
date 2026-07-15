# cf-container wake/restore hardening follow-ups

Deferred, non-blocking hardening items raised by the specialist reviewers during
PR #1562 (cf-container session hibernate/wake/restore). None are regressions
introduced by #1562 — the feature is verified working end-to-end on both the
instant-container and VM paths. The CRITICAL/HIGH items from that review (wake
concurrency mutex per rule 45, and Go unit tests for the token-persist +
reporter-prime invariants) were fixed in #1562 itself. These remaining LOW /
pre-existing items are tracked here.

## Context
- Origin: PR #1562 specialist review (go-specialist, cloudflare-specialist, security-auditor, test-engineer).
- Feature files: `apps/api/src/durable-objects/vm-agent-container.ts`, `packages/vm-agent/internal/server/session_snapshot.go`, `.../session_snapshot_archive.go`, `apps/api/src/services/session-snapshots.ts`.

## Acceptance Criteria
- [ ] **Bound the DO-internal restore call with a wall-clock budget.** `wakeFromSnapshot`'s `containerFetch` to `/restore` is not bounded by an `AbortSignal`/timeout inside the DO (the Worker request carries `getCfContainerWakeTimeoutMs`, but a hung restore inside the DO can still block). Add an env-configurable deadline (`.claude/rules/47`).
- [ ] **Decouple restore agent-start from the HTTP request context.** `restoreSessionSnapshot` passes the request `ctx` into `SelectAgent`; a proxy timeout / client disconnect could abort a cold agent install mid-flight. Use a job-owned `context.WithTimeout(context.Background(), <configurable>)` (`.claude/rules/43`).
- [ ] **Add a decompression size limit** (`io.LimitReader` with configurable max) around the tar stream in `downloadAndExtractTar` to prevent decompression bombs.
- [ ] **Filter/truncate `restoreBody`** before it is passed to `markWakeDegraded` (persisted to D1 `errorMessage`) and returned in the 503 response, so future vm-agent error-message changes cannot leak sensitive content.
- [ ] **Decouple node-management token TTL** from `TERMINAL_TOKEN_EXPIRY_MS`: introduce `NODE_MANAGEMENT_TOKEN_EXPIRY_MS` / `getNodeManagementTokenExpiry` (default 1h).
- [ ] **Validate hostname in `absoluteControlPlaneURL`** to restrict absolute-URL passthrough to the expected SAM domain.
- [ ] **Break the pre-existing circular import**: `node-agent.ts` re-exports `hibernateAgentSessionOnNode`/`restoreAgentSessionOnNode` from `node-agent-session-snapshots`; have callers import directly (mirrors the `node-agent-diagnostics.ts` split done in #1562).
- [ ] **`markWakeDegraded` node status accuracy**: if the container launched before restore failed, reflect the real container state rather than leaving it stale.
- [ ] **Thread `ctx` through `skipOversizedUntracked`** (currently uses `context.Background()` for `git check-ignore`, ignoring cancellation). Pre-existing.
- [ ] **Add an HTTP-level Go test** for `sessionSnapshotHandlerInput` (with a valid node-management JWT) asserting a restore request with `workspaceCallbackToken` in the body persists it — complements the invariant-level test added in #1562.

## Notes
- The security review's checklist (token scopes, no-leak, restore-endpoint auth, no scope escalation, TTLs) all PASSED for #1562; these are additive defense-in-depth.
