# Reduce cf-container cold-start latency

## Problem

A fresh raw Cloudflare Container instant session takes approximately 16,674 ms before the start API returns. The staging baseline from PR #1544 reports setup at 10,831 ms and the nested container launch/install phase at 7,879 ms, while agent-ready, workspace creation, and ACP startup together are already roughly 1.1 seconds. The dominant setup/install work must be measured more precisely and materially reduced toward a sub-five-second total without substituting optimistic UI for raw latency improvement.

The runtime boundary is fixed: the container launch environment remains minimal. User, project, profile, and skill runtime assets and secrets are resolved, fetched, and applied at ACP session start. They must never be copied into the image or added to container launch configuration.

## Research Findings

- PR #1544 introduced `VmAgentContainer` and measured the 16,674 ms staging baseline. `apps/api/src/services/instant-session.ts` currently labels the whole API path `setupDurationMs` and aliases `launchDurationMs` as `installDurationMs`, which hides node/DB/session preparation and container-internal boot costs.
- `apps/api/Dockerfile.vm-agent-container` already bakes Git, GitHub CLI, Claude Code, and `claude-agent-acp`, but `apps/api/container-entrypoints/vm-agent-bootstrap.sh` downloads `vm-agent-linux-amd64` from the control plane on every fresh container. The image therefore still has a cold-path network install.
- The deploy workflow currently deploys the API/container image before it builds vm-agent binaries. Baking the binary requires moving or adding a deterministic Linux AMD64 build before Wrangler deploy and making that build artifact part of the Docker context.
- Wrangler binds `VmAgentContainer` to `image = "./Dockerfile.vm-agent-container"`. Worker/container deployments provide the natural atomic version and rollback boundary; the baked binary needs build-SHA/version labels and runtime telemetry so operators can correlate a cold start with the deployed artifact.
- PR #1561 preserves the required runtime-assets boundary: standalone vm-agent fetches profile/skill/project files and env at ACP session start using workspace callback auth. This path remains unchanged.
- PR #1562 and priority task `01KX8ST0S21H18QGN2NV5PQ45W` modify `VmAgentContainer` for hibernate/wake. This work must rebase after that task merges and preserve its lifecycle changes.
- The container image must contain only repository-built runtime/tooling artifacts and public package dependencies. No callback tokens, user credentials, runtime files, or project/profile/skill values may enter Docker build args, layers, or labels.
- Relevant incident lesson: cf-container lifecycle work must assert the external runtime boundary, not only DB state (`tasks/archive/2026-07-10-cf-container-task-teardown-audit.md`). Deployment changes also require staging infrastructure verification and production deployment monitoring.

## Implementation Checklist

- [x] Replace the coarse setup/install aliases with bounded phase timings covering pre-container records/session preparation, launch RPC, container start/port readiness, agent registration/heartbeat, repository materialization, ACP session creation, and ACP start.
- [x] Add container-internal bootstrap timing telemetry that distinguishes baked-binary validation/start from any explicitly supported fallback, without logging secrets.
- [x] Build the Linux AMD64 vm-agent before Wrangler deploy and bake it into `Dockerfile.vm-agent-container`; remove the mandatory fresh-container download path.
- [x] Preserve a safe, explicit rollback/recovery mechanism tied to a configurable/versioned artifact rather than silently accepting a mismatched or missing binary.
- [x] Add image/build SHA and vm-agent version observability to launch/ready telemetry and the deploy summary; keep version values generated from the deployment commit.
- [x] Integrate the build into reusable staging/production/self-host deployment flow with generated defaults and optional configuration overrides, not new manual secrets or environment prerequisites.
- [x] Preserve the minimal launch-env and ACP-start runtime-assets boundary from PR #1561; add contract tests that fail if runtime assets or user secrets move into the image/launch config.
- [x] Add unit/contract/deployment tests for phase timing invariants, baked binary presence/versioning, workflow ordering, rollback behavior, and no-secret image inputs.
- [ ] Rebase on main after priority task `01KX8ST0S21H18QGN2NV5PQ45W` merges and reconcile `VmAgentContainer` lifecycle/session setup changes.
- [ ] Run lint, typecheck, tests, build, targeted Go tests, and local container startup/benchmark validation.
- [ ] Run Cloudflare, Go, security, constitution, env, doc-sync, deployment/test, and task-completion specialist reviews; address all blocking findings.
- [ ] Wait for priority tasks 1–3 to complete their staging turns and for GitHub Actions staging queue to be empty, using exact ten-minute sleep/recheck loops while blocked.
- [ ] Query staging Cloudflare state/logs, deploy the branch, create a fresh container, exercise an actual ACP session, and record every phase plus total cold-start latency.
- [ ] Clean up fresh staging test resources.
- [ ] If total remains above five seconds, append evidence and the next bounded dominant-phase slice to idea `01KX6JK8ZFC1EFWGYQENRMFWFK` rather than claiming the target was met.
- [ ] Open PR, wait for all CI gates, merge only when green, and monitor production deployment to completion.

## Acceptance Criteria

- Fresh-container staging evidence reports the original 16,674 ms baseline alongside post-change bounded phase timings and total.
- The highest-impact measured cold-path network install is removed or demonstrably shortened; raw latency materially improves toward five seconds.
- The image contains the deployment-built vm-agent and public agent tooling but contains no user/project/profile/skill runtime assets or secrets.
- Runtime assets and secrets are still fetched/applied only at ACP session start, with PR #1561 behavior and precedence intact.
- Image and vm-agent versions are observable, deployment-generated, rollback-correlated, and covered by tests.
- Staging and self-host deployment use the same automated build path without manual values or new secret prerequisites.
- Timing telemetry and regression/contract tests make future cold-start regressions visible.
- Priority 1 lifecycle changes are preserved after rebase; staging coordination rules are followed without overlapping another deployment.
- All required specialist reviews, CI, staging E2E, cleanup, merge, and production deploy monitoring pass.

## References

- SAM idea `01KX6JK8ZFC1EFWGYQENRMFWFK`
- Priority 1 task `01KX8ST0S21H18QGN2NV5PQ45W`
- PRs #1544, #1561, and #1562
- `apps/api/Dockerfile.vm-agent-container`
- `apps/api/container-entrypoints/vm-agent-bootstrap.sh`
- `apps/api/src/durable-objects/vm-agent-container.ts`
- `apps/api/src/services/instant-session.ts`
- `.github/workflows/deploy-reusable.yml`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/14-do-workflow-persistence.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/25-review-merge-gate.md`
- `.claude/rules/32-cf-api-debugging.md`
- `.claude/rules/35-vertical-slice-testing.md`
