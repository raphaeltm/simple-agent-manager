# Runtime-neutral session hibernate/wake for cf-container workspaces

## Problem

Cloudflare Container instant workspaces lose their local disk after sleep. That currently means harness-native session state under `$HOME` and uncommitted repository work disappear when a sleeping cf-container workspace wakes. Phase 3a of idea `01KX4KSXEXQMP41KS34TW9EN01` must add a runtime-neutral hibernate/restore contract and wire the first consumer to the cf-container runtime.

Updated authorization from Raphaël, 2026-07-11:

- The earlier draft-only and no-staging hold is superseded.
- Complete the full `/do` workflow on existing PR #1562.
- Staging end-to-end verification is required before merge.
- Merge only after every required gate passes, then monitor production deployment.

## Research Findings

- `apps/api/src/durable-objects/vm-agent-container.ts` owns cf-container launch, active-work keepalive, `sleeping` lifecycle, and currently returns `503` for sleeping containers.
- `apps/api/src/services/vm-agent-container.ts` wraps the DO and already filters active-work calls to `runtime = 'cf-container'`.
- `apps/api/src/services/node-agent.ts` dispatches initial and follow-up prompts, marking cf-container active work started/ended.
- `apps/api/src/routes/projects/agent-activity-callback.ts` receives VM-agent activity with callback JWT auth and ends active work when the harness reports idle/error.
- `packages/vm-agent/internal/server/workspaces.go` creates `SessionHost` instances. Follow-up prompt handling currently requires an in-memory host, so a fresh container after sleep needs a rebuild path.
- `packages/vm-agent/internal/server/standalone_workspace.go` prepares raw cf-container standalone workspaces by cloning the repo. Restore must happen after clone but before fresh runtime-asset injection/harness start.
- R2 access is via Worker binding for metadata/object ownership. VM-agent needs control-plane endpoints or signed URLs for artifact transfer; do not push WIP refs to the user's remote.
- Relevant rules: migration safety, vertical-slice testing, VM-agent callback auth scoping, long-running progress/idle watchdogs, no hardcoded values, DO concurrency, and credential snapshot resilience.

## Implementation Checklist

- [x] Add additive D1 schema/migration for runtime-neutral session snapshots: canonical chat session key, R2 keys, manifest/degradation, expiry, and restore diagnostics.
- [x] Add env-configurable defaults for snapshot TTL, size budgets, per-entry thresholds, progress idle watchdogs, and R2 key prefix.
- [x] Add Worker snapshot service for deterministic one-snapshot-per-session R2 keys, metadata persistence, retention checks, cleanup hooks, and visible degradation state.
- [x] Add VM-agent callback/API endpoints with callback JWT auth for snapshot upload/download coordination, mounted outside browser-session middleware.
- [x] Add VM-agent hibernate implementation: git WIP bundle, `$HOME` tar with generic cache exclusions, size/skip manifest, progress idle watchdogs, and no remote push.
- [x] Add VM-agent restore implementation: restore `$HOME`, restore WIP bundle with soft reset to base, re-run runtime injection afterward, and report visible degraded results.
- [x] Wire cf-container hibernate on control handback before sleep is allowed.
- [x] Wire cf-container wake before proxying a sleeping container and before follow-up prompt dispatch; fall back visibly when no snapshot exists or restore fails.
- [x] Update follow-up prompt handling so a fresh vm-agent can rebuild a `SessionHost` and attempt native harness resume from restored `$HOME`.
- [x] Add local tests: Worker service/unit tests, Miniflare/DO integration tests, VM-agent Go tests including `go test -race`, and a vertical-slice test covering Worker → DO → vm-agent → R2 state.
- [x] Run migration safety checks: `pnpm quality:migration-safety` and `pnpm quality:do-migration-safety`.
- [x] Run local quality gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and package-specific tests.
- [x] Run local specialist review skills and address findings.
- [x] Opened draft PR with the earlier local-only evidence.
- [ ] Replace draft-only evidence with completed specialist, staging, and preflight evidence; remove `needs-human-review` only after all reviews pass.
- [ ] Update idea `01KX4KSXEXQMP41KS34TW9EN01` with final PR, staging, merge, and deployment evidence.

## Verification Notes

- `pnpm quality:migration-safety` passed.
- `pnpm quality:do-migration-safety` passed.
- `pnpm typecheck` passed.
- `pnpm lint` passed with existing warnings and no errors.
- `pnpm build` passed.
- `pnpm test` passed.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/session-snapshots.test.ts tests/unit/routes/workspaces-session-snapshots.test.ts tests/unit/cf-container-runtime-contract.test.ts` passed.
- `pnpm --filter @simple-agent-manager/api typecheck` passed.
- `go test ./internal/server` passed in `packages/vm-agent`.
- `go test -race ./...` passed in `packages/vm-agent`.
- `pnpm --filter @simple-agent-manager/api test:workers -- tests/workers/session-snapshot-wiring.test.ts` was attempted locally, but the Cloudflare `workerd` binary (`@cloudflare/workerd-linux-64@1.20260329.1`) segfaulted during startup before the test body ran. Staging verification remains intentionally deferred by instruction.

## Local Specialist Review Notes

- `$cloudflare-specialist`: additive D1 migration and R2-backed snapshot metadata are in place; app enforces snapshot expiry and avoids cron sweeping. R2 lifecycle policy provisioning remains an operational follow-up before merge.
- `$go-specialist`: vm-agent hibernate/restore uses local git bundles, no remote push, progress/idle transfer watchdogs, tar extraction hardening, and `go test -race ./...` passed.
- `$security-auditor`: callback auth is workspace scoped, R2 keys are server derived, fresh secret/env/file injection reruns after restore, and snapshot errors avoid logging secret material.
- `$constitution-validator` and `$env-validator`: snapshot TTL, budgets, thresholds, watchdogs, JSON body limit, and R2 prefix are env-configurable with `DEFAULT_*` constants.
- `$test-engineer`: unit, route, worker wiring, and Go edge tests cover deterministic keys, auth scoping, oversized entries, git operation degradation, and tar traversal rejection.

## Acceptance Criteria

- A cf-container session snapshots harness `$HOME` state and uncommitted WIP on control handback without pushing anything to origin.
- Snapshot storage is deterministic, private, R2-backed, one object set per canonical chat session, and retention is env-configurable with a 7-day default.
- Oversized or unsafe snapshot content degrades visibly with a manifest; no files are silently dropped.
- Waking a sleeping cf-container provisions a fresh container, restores `$HOME`, restores WIP as uncommitted work, reruns fresh runtime asset injection, and attempts native resume before visible transcript fallback.
- Ungraceful kills or expired/missing snapshots degrade visibly to existing transcript/fork behavior.
- Timeouts for transfer work are progress/idle watchdogs, not fixed wall-clock caps.
- Tests cover edge cases for public-repo privacy, huge files, repo operation states, missing/corrupt artifacts, retention expiry, and no secret leakage in logs/events.
- PR #1562 passes local, specialist, CI, staging E2E, merge, and production-deploy gates under the superseding authorization.

## Continuation Findings (PR #1562 landing pass)

- The original Git WIP bundle path mutated the user's real index and branch; remediation now builds the snapshot commit from a temporary Git index and tests exact status/HEAD/branch preservation.
- Restore checked out a temporary branch and attempted to delete it while current; remediation now imports the advertised bundle ref, materializes its tree, and leaves WIP uncommitted on the original branch.
- R2 cleanup was not provisioned. Pulumi now owns a prefix-scoped lifecycle rule, and its positive TTL configuration is injected into the Worker so application expiry and object deletion stay aligned.
- The initial PR exceeded the API file-size gate and omitted preflight/specialist evidence markers; the node snapshot wrappers are extracted and durable PR evidence must be added after final reviewers complete.
