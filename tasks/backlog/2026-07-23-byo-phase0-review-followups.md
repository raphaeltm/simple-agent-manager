# BYO Phase 0 — deferred review follow-ups (MEDIUM/LOW)

**Date:** 2026-07-23
**Parent:** `tasks/archive/2026-07-23-byo-user-owned-nodes-phase0.md`, PR for branch `sam/build-byo-user-owned-e2d62t`
**Source:** Phase-0 local specialist review (security-auditor, cloudflare-specialist, test-engineer, task-completion-validator).

All CRITICAL/HIGH findings were fixed in the Phase-0 PR. These MEDIUM/LOW items were deferred with
justification (rule 25 permits deferring MEDIUM/LOW). Each protects against a scenario that **cannot
occur until Phase 1 ships node enrollment** (no code path sets `nodeClass='user-owned'` yet), or pins
an invariant the security-auditor confirmed is **already correct** in the current code.

## Deferred items

- [ ] **`node-steps.ts` preferredNodeId cross-tenant test** — the `SELECT ... WHERE id=? AND user_id=?`
      preferredNodeId re-validation (security-critique #7). Code is correct (verified by security-auditor);
      the DO step handler can't be instantiated in isolation (see `node-provisioning.test.ts` note) and
      Miniflare segfaults in the current sandbox. Pin via a Miniflare/CI test or a refactor that extracts
      the query. `node-selector.ts` half is already pinned (`node-selector-user-scope.test.ts`).
- [ ] **`/workspaces/:id/agent-key` resolution test** — assert the LLM credential resolves via
      `workspace.userId`, never `credentialAttributionUserId` (security-critique #7 third sub-point).
      Code at `routes/workspaces/runtime.ts:658-687` is already correct; add a regression pin.
- [ ] **`trial-expire.ts` + `deployment-environment-lifecycle.ts` zombie tests** — the Phase-0 PR added
      `node_class != 'user-owned'` to these 3 teardown-candidate queries (per rule 51). Add two-sweep
      zombie tests mirroring `node-cleanup-user-owned-zombie.test.ts`. The predicates are identical to the
      node-cleanup ones (which ARE tested); a BYO node can't reach these flows until Phase 1.
- [ ] **`toNodeResponse` field-surfacing test** — assert `nodeClass`/`transport`/`tunnelName` appear in
      node responses. Cosmetic (fields are set + typecheck); low risk.
- [ ] **`NodeResponse.vmSize`/`vmLocation`/`cloudProvider` nullable for user-owned** — deferred to the
      Phase-1 enrollment PR (the point at which a user-owned row with no real vmSize/vmLocation exists).
- [ ] **DO `markIdle`/`tryClaim`/`alarm` concurrency mutex (rule 45)** — the Phase-0 PR fixed the race it
      *introduced* (moved the D1 fetch out of the read→put critical section, restoring input-gate
      atomicity). The broader pre-existing DO warm-pool concurrency model (a promise-chain mutex à la
      `codex-refresh-lock.ts` across markIdle/tryClaim/markActive/alarm) is a separate, pre-existing
      hardening opportunity — evaluate whether it's worth it.
- [ ] **Origin-CA fail-open hardening (Phase 1)** — when enrollment ships, set `nodeClass` (and
      `credentialSource='self-hosted'`) atomically in the row-creation INSERT, and consider a positive
      second signal on origin-CA issuance (e.g. require `providerInstanceId` for `vm-public-dns`). Add a
      test proving a mis-classified row can't obtain the wildcard cert (rule 44 — enumerate every writer).

## Acceptance
- [ ] Each item either has a test/fix or is explicitly closed as Phase-1-scoped in the enrollment PR.
