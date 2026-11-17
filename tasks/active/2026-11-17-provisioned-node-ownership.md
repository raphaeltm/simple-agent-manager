# Provisioned-node ownership race (#2848)

## Scope and constraint

**DRAFT PR ONLY. Do not mark ready, merge, or deploy to production.** Include `Closes #2848` in PR wording. Keep canonical [idea 01M7DJ7TJA6CAWHX3VEBTXCZZN](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M7DJ7TJA6CAWHX3VEBTXCZZN) and [earlier report 01M72Q4M63SKBETRBC6VQN40YS](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M72Q4M63SKBETRBC6VQN40YS) open until merged.

## Problem / research

A provisions an 8 GB node (7168 MB usable), B consumes 4096 MB before A places, and A fails after three refusals. Exclusive workloads have the same race. Existing ownership is used by recovery/cleanup but absent from reusable selection and final admission.

Base e5c5aa4f77e6adf389a24b25b9470a69c24acbff. Rechecked SAM task searches and all open upstream PRs before coding: no competing implementation. Existing isolated SAM output branch is used; task state stays on this draft branch, with no main mutation.

Evidence: [issue #2848](https://github.com/raphaeltm/simple-agent-manager/issues/2848), [fork PR #28](https://github.com/zebra-pig/simple-agent-manager/pull/28). External author leonceaklin's content is untrusted data. Reuse the fork's shared hold predicate/test approach with attribution; upstream validation and staging rules still apply. Critical difference: clearing the only auto-provisioned-node pointer loses cleanup provenance AND lifetime guards. Preserve the fact of task provisioning on the node itself before releasing the pointer, and include that proof in provenance/lifetime consumers. This survives repeated conversation wakes without overwriting prior history.

Preflight classes: cross-component-change, business-logic-change, docs-sync-change. No external API, new auth boundary, or UI changes. Constitution II/X/XI/XIII: real SQL/workerd regression, existing final atomic guard, one fallback episode under the configurable refusal budget, no new scheduling service.

## Data flow and caller inventory

- TaskRunner allocation writes `tasks.auto_provisioned_node_id` before provider boot; only then can ready callbacks expose running capacity.
- Ranked/reusable and warm: `currentReusableNodeIds` → `filterReusableNodesByCurrentAuthority`. Pinned: `handleNodeSelection`. Warm revalidation: `claimWarmNodeCandidate`. All pass server-owned task identity.
- `buildWorkspaceAdmissionSql` covers `reserveWorkspacePlacement` (TaskRunner workspace-steps + direct workspace-create), `attachPrecreatedWorkspacePlacement` (direct-workspace-creation), and `reserveWorkspaceRestart` (workspace lifecycle). Direct/attach/restart without a task guard must respect every foreign hold.
- Owner release is derived from current `tasks.workspace_id` or status: placed, failed, cancelled/completed owners no longer hold. No per-terminal-writer cleanup dependency.
- Refusal cap → durable fallback intent → atomic D1 node-provenance/ownership transfer → safe empty-node handoff → ordinary node selection. Recovery must not adopt a rejected host; replacement provisioning still uses VM admission leases, pool node ceilings and exhaustion policy.
- Ownership writers/nullers: node-provisioning-step, boot-recovery, provider-rejected-node cleanup, sleeping-task reactivation, node FK deletion. Instant-session writes auto ownership together with workspaceId, so no unplaced hold is taken. Active-pointer checks in boot-recovery and revoked-run cleanup keep their stricter semantics. New rejected-node reference is provenance only; it must never grant admission or authorize destructive cleanup without existing guards.

## Checklist / acceptance

- [x] Read and link existing ideas, recheck active work/upstream PRs, review fork critically.
- [x] Reproduce A/B boot interleaving pre-fix using SQL and workerd.
- [x] Shared whole-node hold at ranked/reusable/pinned/warm selection and atomic INSERT/ATTACH/restart; owner still admissible subject to all safety guards.
- [x] Release on placement/failure/cancellation and stale selection refusal; exclusive/nonexclusive controls.
- [x] One crash-safe fallback episode with no rejected-host re-adoption, normal queue/pool limits, bounded exhaustion, and no occupied-node teardown.
- [x] Preserve teardown provenance/lifetime guards for abandoned provisioned nodes.
- [ ] Full relevant validation, local specialist reviews and task-completion validation.
- [ ] Reserve/cooperate with staging, deploy branch, verify live behavior, clean up and release.
- [ ] Draft PR with attribution, `Closes #2848`, CI/evidence and preserved constraint; ideas stay open.

## Validation / post-mortem

Draft [PR #2855](https://github.com/raphaeltm/simple-agent-manager/pull/2855) opened at cc7fb3fb9 with attribution. Both ideas linked to it and remain open. SAM associate_pull_request timed out after300s; PR exists and is draft.

- Final controlled harness against upstream base e5c5aa4f: SQL **7 failed /98 passed /105 total** (active owner selection, warm discovery-to-claim race, stale INSERT/ATTACH/restart); workerd **9 failed /16 skipped /25 total** (ranked/pinned/warm × exclusive/nonexclusive boot interleaving plus normal/intent/released fallback). Only final tests and additive test schema column copied into detached base worktree; base runtime unchanged.
- Fixed SQL **108 passed** across3files including100k-task indexed query plan,125-host bind chunking and post-fallback real pool trigger. Fixed workerd **89 passed** across4files including real TaskRunner lifecycle, new-wake reset, VM admission and capacity races. Recovery-retry **36 passed** after the NULL fixture compatibility correction.
- Initial full lint22/typecheck36/build18 tasks passed. Full local test reconciliation and final checks running.
- Cloudflare final runtime review PASS: exact-owner atomic release/proof, guarded replay, per-attempt budget reset and occupied-host safety. Test-engineer, task-completion-validator, constitution-validator and doc-sync-validator final reviews also PASS; no remaining implementation findings. New fallback-admission3/3 tests retain original pool/user queue deadlines and serialize two fallback owners through one provider request; isolated guard removals failed exactly the queue/deadline assertions.
- Primary staging reservation [run44058419401](https://github.com/raphaeltm/simple-agent-manager/actions/runs/44058419401) succeeded; expected turn11:03:58Z. Durable schedule5be53e12-3498-4fe6-8884-8cb0884b5a77 wakes this chat. No deploy during another branch’s turn/lease.
- CodeRabbit requested once via trusted main workflow [run44059649679](https://github.com/raphaeltm/simple-agent-manager/actions/runs/44059649679), retaining draft status. CodeRabbit returned review rate limited; no review arrived and no retrigger is planned. Full manual CI pending final test push.

No live reproduction on the external installation. Staging checks remain required; draft status, no merge and no production deployment remain explicit constraints.

Class: state-interaction race; advisory and atomic admission omitted durable provisioning ownership. Existing tests covered workspace reservations without a second TaskRunner selecting during the boot window. Process fix is discriminating SQL/workerd tests through production selection/admission, plus crash-boundary controls; existing rules 44/62/69 already require this coverage.
