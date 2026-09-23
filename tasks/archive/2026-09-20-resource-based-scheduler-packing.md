# Resource-Based Scheduler Packing and Eviction Relocation

**Created**: 2026-09-20
**Priority**: High
**Type**: Scheduler migration

## Problem

SAM's node-pool scheduler still applies legacy workspace-count, co-tenant, and live-memory-percentage gates after resolving explicit CPU, memory, and disk reservations. These gates underpack capable machines and can provision unnecessary nodes. Resource evictions also stop a workspace without automatically restoring its conversation through normal placement.

## Product Decisions

- Explicit CPU, memory, and disk reservations control shared-node capacity.
- Keep `exclusiveNode`, disk-pressure vetoes, fresh telemetry requirements, and fail-closed malformed-reservation behavior.
- Retain live CPU saturation as overload backpressure and document/test it.
- Keep legacy fields for compatibility and audit, but do not use `maxCoTenants`, `maxWorkspacesPerNode`, or `nodeMemoryThresholdPercent` as placement hard gates.
- `pack` selects the largest allowed offering and then fills existing nodes densely.
- `smallest-fit` selects the smallest/cheapest sufficient offering.
- `spread` provisions separate nodes up to the pool's explicit per-user node limit, then packs onto those nodes; managed workspace nodes are user-isolated.
- Memory/OOM eviction snapshots and stops the old runtime, then idempotently resumes the session through normal placement while excluding the unhealthy source node.

## Implementation Checklist

- [x] Make current reservation JSON valid without `maxCoTenants`, while accepting legacy rows that contain it
- [x] Remove legacy count/co-tenant and live memory-percentage admission gates from in-memory and final SQL placement
- [x] Preserve exclusive-node, disk-pressure, stale/missing telemetry, malformed-reservation, and CPU-saturation safeguards
- [x] Add an explicit capacity-pool node limit and enforce spread-then-pack behavior
- [x] Preserve explicit `pack` and `smallest-fit` offering ranking
- [x] Add fenced, idempotent eviction recovery through normal placement and exclude the source node
- [x] Update public types, API request validation, UI, migration, and scheduler documentation
- [x] Add deterministic unit, worker, and simulation coverage for all requested cases
- [x] Run TypeScript validation and affected tests
- [x] Run required specialist reviews and resolve findings
- [x] Open an unmerged PR, pass CI, trigger CodeRabbit once, and address its initial feedback
- [ ] Obtain parent/orchestrator review before merge or deployment

## Scope and Release Constraints

- This task is CI-only under project policy `f8bed08d-07e5-42ca-b2dd-f7262573bf5d`; do not deploy to staging or production.
- Leave the PR open for parent/orchestrator review. Do not merge.
- The corrected execution task is `01M2Y662382W1FEE18S3VGQQGB` on branch `sam/run-repository-skill-get-vgqqgb`.

## Acceptance Evidence

- Deterministic tests show a 32 GB-class node accepting many 0.4 vCPU / 0.8 GB / 2 GB reservations until an explicit resource is exhausted despite legacy `maxCoTenants=2` metadata.
- Legacy occupants and project count/memory settings do not cap placement.
- Isolation, disk, telemetry, malformed-row, and CPU-overload safety tests remain green.
- Strategy tests prove largest-host `pack`, smallest/cheapest `smallest-fit`, and max-node-limited `spread` semantics.
- Eviction callback tests prove automatic relocation/resume, duplicate callback idempotency, and stale-generation fencing.

## Validation Evidence

- Root lint passed across all packages with existing warning-only baselines.
- Root typecheck passed across all 19 tasks.
- Root build passed across all 9 build tasks.
- The clean full API rerun passes all 741 files and 10,097 tests after correcting the stale assertion that expected the removed workspace-count gate and adding review-driven vertical coverage.
- Focused scheduler, placement, eviction, migration, and capacity-pool suites pass all 225 tests after review fixes; the real-worker callback suite passes all 34 tests.
- OpenAPI drift, Durable Object migration safety, type boundaries, node-pool boundaries, file-size limits, formatting ratchet, and `git diff --check` pass.
- UI unit tests pass. Playwright audit passes all 6 cases on iPhone SE (375x667) and Desktop (1280x800).
- Visual variants considered: a project-wide scaling field, inline pool-policy controls, and a spread-only conditional control. The inline pool-policy layout was selected because the limit belongs to each pool and remains visible across strategy changes.
- Visual rubric: hierarchy 5/5, spacing 5/5, typography 5/5, interaction clarity 5/5, responsive behavior 5/5. No overflow or control collision was observed.
- Local screenshots: `.codex/tmp/playwright-screenshots/default-capacity-pools-project-edit-iphone-se-375x667--375x667.png` and `.codex/tmp/playwright-screenshots/default-capacity-pools-project-edit-desktop-1280x800--1280x800.png`.
- VM-agent resource monitor, server, and persistence tests pass under the repository-pinned Go 1.26.6 toolchain, including race detection; `go vet` and `gofmt -d` are clean.
- All specialist re-reviews pass: task completion, Cloudflare/D1, test engineering, UI/UX, constitution, documentation, Go, and security.
- PR #2108 passes all 25 applicable CI and review checks; CodeRabbit was triggered exactly once and its initial findings are addressed in the follow-up commit.
