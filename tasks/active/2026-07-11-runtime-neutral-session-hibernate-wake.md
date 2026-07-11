# Runtime-neutral session hibernate/wake for cf-container workspaces

## Problem

Cloudflare Container instant workspaces lose their local disk after sleep. That currently means harness-native session state under `$HOME` and uncommitted repository work disappear when a sleeping cf-container workspace wakes. Phase 3a of idea `01KX4KSXEXQMP41KS34TW9EN01` must add a runtime-neutral hibernate/restore contract and wire the first consumer to the cf-container runtime.

Hard constraints from Raphaël, 2026-07-11:
- Open a draft PR only.
- Do not merge.
- Do not deploy to staging or mutate staging.
- Verification is local only.

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
- [ ] Add local tests: Worker service/unit tests, Miniflare/DO integration tests, VM-agent Go tests including `go test -race`, and a vertical-slice test covering Worker → DO → vm-agent → R2 state.
- [ ] Run migration safety checks: `pnpm quality:migration-safety` and `pnpm quality:do-migration-safety`.
- [ ] Run local quality gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and package-specific tests.
- [ ] Run local specialist review skills and address findings.
- [ ] Open draft PR with `needs-human-review`, explicit no-merge/no-staging language, and local-only verification evidence.
- [ ] Append idea `01KX4KSXEXQMP41KS34TW9EN01` with branch, draft PR, and deferred staging/merge status. Leave the idea open.

## Acceptance Criteria

- A cf-container session snapshots harness `$HOME` state and uncommitted WIP on control handback without pushing anything to origin.
- Snapshot storage is deterministic, private, R2-backed, one object set per canonical chat session, and retention is env-configurable with a 7-day default.
- Oversized or unsafe snapshot content degrades visibly with a manifest; no files are silently dropped.
- Waking a sleeping cf-container provisions a fresh container, restores `$HOME`, restores WIP as uncommitted work, reruns fresh runtime asset injection, and attempts native resume before visible transcript fallback.
- Ungraceful kills or expired/missing snapshots degrade visibly to existing transcript/fork behavior.
- Timeouts for transfer work are progress/idle watchdogs, not fixed wall-clock caps.
- Tests cover edge cases for public-repo privacy, huge files, repo operation states, missing/corrupt artifacts, retention expiry, and no secret leakage in logs/events.
- The PR is draft-only, not merged, and staging verification is explicitly deferred per instruction.
