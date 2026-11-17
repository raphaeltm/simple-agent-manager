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
- [x] Full relevant validation, local specialist reviews and task-completion validation.
- [ ] Complete live staging verification and guard-preserving cleanup after operator repair (deployment and bounded attempts performed; blockers below).
- [x] Draft PR with attribution, `Closes #2848`, CI/evidence and preserved constraint; ideas stay open.

## Validation / post-mortem

Draft [PR #2855](https://github.com/raphaeltm/simple-agent-manager/pull/2855) opened at cc7fb3fb9 with attribution. Both ideas linked to it and remain open. SAM associate_pull_request timed out after 300s; PR exists and is draft.

- Final controlled harness against upstream base e5c5aa4f: SQL **7 failed /98 passed /105 total** (active owner selection, warm discovery-to-claim race, stale INSERT/ATTACH/restart); workerd **9 failed /16 skipped /25 total** (ranked/pinned/warm × exclusive/nonexclusive boot interleaving plus normal/intent/released fallback). Only final tests and additive test schema column copied into detached base worktree; base runtime unchanged.
- Fixed SQL **108 passed** across 3 files including a 100k-task indexed query plan, 125-host bind chunking and post-fallback real pool trigger. Fixed workerd **89 passed** across 4 files including real TaskRunner lifecycle, new-wake reset, VM admission and capacity races. Recovery-retry **36 passed** after the NULL fixture compatibility correction.
- Final lint (22 tasks), typecheck (36 tasks) and build (18 tasks) passed. Full local API: **16,600 passed / 4 skipped / 0 failed** across 1,090 files; other 20 packages: **10,030 passed**. Combined: **26,630 passed / 4 skipped**. Migration safety (247 FKs, zero violations), migration ordering and diff checks passed.
- Cloudflare final runtime review PASS: exact-owner atomic release/proof, guarded replay, per-attempt budget reset and occupied-host safety. Test-engineer, task-completion-validator, constitution-validator and doc-sync-validator final reviews also PASS; no remaining implementation findings. New fallback-admission 3/3 tests retain original pool/user queue deadlines and serialize two fallback owners through one provider request; isolated guard removals failed exactly the queue/deadline assertions.
- [Staging2 deployment 44087824862](https://github.com/raphaeltm/simple-agent-manager/actions/runs/44087824862) passed, including smoke tests, at source `3bd7ca45070d59b15591c5e6b6a0212d027d0894`. Both installation queues were coordinated; the primary reservation was released before the secondary turn. D1 confirms `0257_node_task_provisioned.sql` and `nodes.task_provisioned INTEGER NOT NULL DEFAULT 0`. No new Durable Object migration tag.
- Real A/B boot observation: A `01M7MVAB1429A1B6QM62XHJXEG` owned allocated 8 GB node `01M7MVBSDXTDNW0V5YGH6BN4JF` while unplaced; B `01M7MVC3XPQ4XCFF7QMVZ9JEYG` queued instead of taking it. A subsequently placed workspace `01M7MVHRDSEABRA3YB111WF8C2` on its owned node. B allocated a separate 8 GB host after normal provider-capacity retries but did not finish readiness within the bounded window. This is partial evidence, not a full live pass.
- Full agent/chat verification is blocked: A's actual assistant reply was `API Error: 402 AI inference failed (402). Please try again.` The existing Anthropic proxy passes through the AI Gateway's upstream status. Platform cloud and agent credentials were enabled; this is not a missing-personal-cloud-credential diagnosis. No account funding, credential replacement or guard bypass was attempted.
- Browser baseline initially passed dashboard/project/settings/health with zero console/page errors. Later runs saw `AUTH_UNAVAILABLE` 503 responses and a settings-load timeout; cause unresolved. The unchanged 24-hour noise gate exited 1 both before and after: baseline Operations 240 / Hetzner 32; after Operations 225 / Hetzner 34 / auth unavailable 13. Telemetry subcheck unavailable (403). Historical and new errors are distinguished, with evidence appended to existing [noise idea 01M7KE1VAKJTKGV21CAAK6MQMG](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M7KE1VAKJTKGV21CAAK6MQMG).
- Cleanup: all four test tasks cancelled; temporary profile removed; the only created workspace and both allocated VM node rows removed after strict DELETE returned 200. Final D1 proof at 13:45 UTC confirms those resources absent. Two actual 8 GB VMs were used, within the bounded cost estimate; no further paid retries.
- One pre-create, providerless node `01M7MTMV89F5ZV23VSF0ZVPJPS` remains quarantined in `destroying`, with no provider ID, IP, workspace or termination proof. Normal DELETE refuses 409. The existing [providerless cleanup idea 01M7GVRC956Q8JMGCRP1PQ4R5B](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M7GVRC956Q8JMGCRP1PQ4R5B) was read and updated; no duplicate idea/issue or manual D1 cleanup. Preserve this guard until an operator-supported fix establishes allocation finality.
- Lease release [run 44096040800](https://github.com/raphaeltm/simple-agent-manager/actions/runs/44096040800) passed. Fresh staging2 status at 13:56:14 UTC confirms holder=null and the next queued task has its protected turn; early handoff notification queued under the /do staging workflow (acceptance does not prove it was read). Live staging remains blocked and is not waived. This task and both ownership ideas remain open; PR remains **DRAFT ONLY**.
- CodeRabbit requested once via trusted main workflow [run44059649679](https://github.com/raphaeltm/simple-agent-manager/actions/runs/44059649679), retaining draft status. CodeRabbit returned review rate limited; no review arrived and no retrigger is planned. Full manual [CI run 44060519223](https://github.com/raphaeltm/simple-agent-manager/actions/runs/44060519223) passed at source head `3bd7ca45070d59b15591c5e6b6a0212d027d0894`, including all three API and seven workerd shards. Draft status remains set.

No live reproduction on the external installation. A complete upstream live pass remains required; draft status, no merge and no production deployment remain explicit constraints.

Class: state-interaction race; advisory and atomic admission omitted durable provisioning ownership. Existing tests covered workspace reservations without a second TaskRunner selecting during the boot window. Process fix is discriminating SQL/workerd tests through production selection/admission, plus crash-boundary controls; existing rules 44/62/69 already require this coverage.

## Corrected-account follow-up (15:55 UTC; live rerun pending)

Raphaël clarified that verification must sign in as `test-user@simple-agent-manager.org` (`staging2-test-user`) and use that user's attached Anthropic account. Metadata confirms its active Claude Code OAuth credential and user attachment, GCP credential, and Artifacts `test-project` (`01M7M62YQ2XRZ6HYT1VYJ3WDS2`). The prepared harness explicitly selects OAuth configuration `cc-cfg-01M7M62R81N29Q65EC6PMFF4K8`. The previous bootstrap-user/API-key 402 does not establish a failure of this account.

Exact-user workload login, session verification, project read and sign-out passed at 14:55 after the installation-specific trust was applied by PR #2841's staging deployment. No further human configuration was needed for the earlier target-allowlist 403. No new VM has been created for the corrected-account rerun.

Our branch's old staging workflow still contains the credential-copy path prohibited by project policy 795e72a6. Wait for upstream [PR #2841](https://github.com/raphaeltm/simple-agent-manager/pull/2841) to merge, update this branch from main, review the merge and run appropriate checks before redeploying. At 15:52 it remains open, with no failures and its final CI run 44114588924 progressing. This task does not authorize merging that other PR.

Staging2 reservation 44104898905 succeeded. The preceding branch released early; authoritative 15:51:54 status shows our protected turn through 16:23:58 UTC, holder=null. The handoff event was read and acknowledged. Do not deploy an unsafe workflow or bypass another branch's lease if the queue changes.

A nonsecret, ephemeral verification harness and checkpoint are saved in the Project Library at `/engineering/issue-2848/handoff-2848.tgz`, file ID `01M7N3G4ZEV5FT93QAWF3RHG3E` (download with `download_library_file`). Local ignored files were omitted when SAM replaced the workspace, so this artifact prevents repeated reconstruction. It contains no cookie or credential values. The harness requires our exact candidate lease, uses at most two allocated 8 GB GCP VMs for a 12-minute overall trial, verifies B was accepted while A remained unplaced, checks actual assistant replies and chat DOM, and preserves strict ownership/occupancy cleanup guards. Syntax and browser tooling checks passed; the paid `race` mode remains **UNRUN**. Conservative incremental allowance: USD 1, with regional/disk/IP margin; [published Compute Engine pricing](https://cloud.google.com/products/compute/pricing/general-purpose).

PR #2855 stays **DRAFT ONLY**. Full runtime CI passed at `3bd7ca450`; later evidence-only checks pass except PR Evidence, which fails because the explicit `needs-human-review` label is retained while live verification is incomplete. Do not describe that label gate as green or remove it to bypass review.
