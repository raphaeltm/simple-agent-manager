# M1: merge main into sam/selfhost-pass-2

Task `01M7DD7ASW9A0QA4K9FWA4Q7XH`, dispatched by `01M7AF82KG9C78WAABTG3V1MN1` (channel
`feature.selfhost-spike`). Draft PR into `sam/selfhost-pass-2`; never merged by this task.

## Problem

`sam/selfhost-pass-2` (c0935ad06) last took main at 57614ec6b (#2709, L0). Main has 24 commits
since, including two landing slices of the branch's own work (#2714 ws-* proxy move, #2733 tts /
ai-token-budget / agent-loop splits) plus node teardown (#2715, #2718, #2725), build-context
bundles (#2605) and Go 1.26.11 (#2658). Merge main (03230e52b), keep the branch's behaviour on
main's structure, hunt silent breakages, prove green and bootable.

## Research findings

- 17 conflicted files. #2714 and #2733 conflicts: main's versions are pure moves the branch
  already contains; the branch adds only its listed behaviour (verified by diffing main vs branch
  per file).
- Main moved `reconcileStrictProviderlessVm` into `strict-node-providerless-reconcile.ts` and
  added `nodeProviderLabelsMatch` (identical to the branch's `providerInventoryMatchesLabels`).
- Main added a sync `isAiProxyEnabled` in `sam-ai-proxy-fallback.ts`; the branch has an async,
  gateway-aware one in `ai-proxy-availability.ts`. runtime.ts imported both.
- #2605's `build-context-upload.ts` uses `getS3Client` from compose-image-artifacts, which the
  branch removed in favour of the shared R2 presign target.
- Lockfile: main bumped isomorphic-git to 1.44.12; apps/api (branch) asked for ^1.38.7.
- New D1 migrations from main: 0230_publish_job_build_context, 0231_publish_job_context_shadow,
  0237_archive_reclaim_pending, 0238_task_run_agent_configuration,
  0241_node_provider_deletion_request (all additive). 0232 untouched. DO tag v23 free (main at
  v22). ProjectData DO migration 076 new from main. No new encrypted D1 columns.
- Go pins agree after the merge (installer-engine preflight moved to 1.26.11 with main).

## Checklist

- [x] Merge origin/main 03230e52b (merge commit, not rebase)
- [x] Resolve 17 conflicts (table in PR body)
- [x] Build-context upload through the shared presign target + test
- [x] One `isAiProxyEnabled`; `samProxyFallbackAvailable` reads it
- [x] Strict-node deletion: main structure + branch GCP/manual-deletion/reverse-tunnel changes
- [x] Lockfile repair (isomorphic-git)
- [x] Build, typecheck, check:fast, quality gates, selfhost:test
- [x] Full unit suite green (local 3 failures fixed in e08088cca; CI run 43618481233 green)
- [x] celld boot evidence: partial (bundle, /health, capabilities under `celld dev`); D1 probes need the object store (no Docker here); CI live suite 297/297 on real celld
- [x] CI run by hand green (43618481233 on e08088cca; final-head run recorded in the PR)
- [x] task-completion-validator (PASS), scoped security-auditor (PASS)
- [x] Draft PR #2736
- [ ] Report to coordinator, channel post

## Acceptance criteria

- No conflict marker, no duplicate module, no lost change from either side
- CI green on the PR head; selfhost:test green; celld boot evidence or explicit gap
- PR body: main SHA, conflict table, silent breakages, migrations, tests, box checklist,
  shortstat before/after

## Notes

- Silent breakages S1-S7 are in the PR body (S7: a stale doc comment in teardown-gcp.ts, c6dd79553).
- Findings outside the merge (reported, not fixed): `.metadata` name suffix not refused by
  worker-core `classifyName`; manual node deletion does not release reverse-tunnel leases inline;
  agent-key awaits the AI-proxy resolver before the eligibility check (pre-existing branch code).
