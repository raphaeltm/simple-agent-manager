# Task startup hotfix

## Problem and verified evidence

Production selected a 4096 MiB offering for a 4096 MiB reservation, although final admission reserves512 MiB for the host. No workspace was created; retries oscillated until15-minute timeout. Instant profiles with attachments/idea execution/resource overrides enter task-submit, which omits runtime resolution. Submit HTTP durations reached71/103 seconds while synchronously reconciling provider catalogs and default pools.

## Preflight

Classes: business-logic-change, cross-component-change, docs-sync-change, security-sensitive-change.
Trace: chat handleSubmit -> task-submit -> placement resolver -> TaskRunner -> atomic workspace reservation; Instant -> accept/continueInstantSessionLaunch -> node-agent transport -> agent bootstrap.
Use existing runtime, admission, attachment authorization and launch machinery. No new dependencies, no weakening of final capacity/ownership/credential fences. Read rules05,09,14,69 and constitution. Reviewed current production D1/CF telemetry and restricted summaries of the private debug bundle. MCP Instant routing is existing control path; cover it in validation. New feature fields must propagate end to end.

## Implementation checklist

- [x] Align provider offering eligibility with final host-reserve policy; reject impossible fresh allocations before provisioning and prevent retry loop.
- [x] Preserve explicit Instant runtime on task-submit, including attachments, forks and idea execution; validate incompatible VM overrides.
- [x] Use existing runtime-aware attachment transport and preserve original user message/file context.
- [x] Eliminate synchronous catalog reconciliation during submission while preserving effective pool precedence and first-install behavior.
- [x] Investigate revision rejection; preserve legitimate pool invalidation and avoid silently adopting stale authorization.
- [x] Add regression tests for each boundary and run relevant quality checks.
- [x] Update public docs; specialist review; staging.
- [ ] CI/CodeRabbit; merge; production verification (release gates tracked in PR).

## Acceptance criteria

A4 GiB request cannot provision a4 GiB VM with512 MiB reserve; a fitting request succeeds. Instant selection never becomes VM implicitly because of attachment/idea/resource routing. Existing pools can submit without provider catalog refresh; fresh installations still initialize through supported lifecycle. Failed placement has a bounded actionable outcome. Final pool/credential/isolation checks remain enforced.

## Constraints

User authorizes PR and merge ASAP; simplest safe fix. Stop before reported account allowance falls below15%. Starting allowance28% at22:25Z. Preserve a restartable checkpoint if reached.

## References

SAM incident idea01M21G5K3XNKFBGYNP0T2FPBW4; parent session4760beee-29f9-45b6-9f81-2073788c69e2. No raw diagnostic artifact contents in public artifacts.

## Post-mortem

What broke: healthy VM nodes were selected but no workspace could be admitted. Instant uploads and idea execution could silently enter VM placement. Existing-pool submits blocked on catalog refresh.
Root cause: native offering qualification (PR #2030) compared raw memory while final reservation deducted host reserve; task-submit lacked the runtime branch already used by sessions/start and MCP; default pool ensure refreshed catalogs on every placement. Attachment task fallback predates #2030 (commit d590ec5626).
Class: inconsistent policy across entry points and admission boundaries.
Why missed: tests covered raw offering fit and direct Instant starts independently; no reserve boundary or attachment task-route regression.
Process fix: `.claude/rules/69-aggregate-capacity-at-final-reservation.md` now requires reserve-aware offering and persisted-plan tests. New task-route and upload tests cover the cross-entrypoint runtime contract.

## Recovery and shared-node interruption (2026-09-09)

Recovered pushed implementation e9e59cf98 from parent branch; no PR existed. Production logs show the parent node's warm-retention alarm fired at 2026-09-08 22:41:14Z (warm since 22:11:13Z), despite an active workspace and successful heartbeat at 22:40:42Z. Its next heartbeat was rejected with 410 because D1 had been marked stopped. Task reconciliation failed the task at 22:45:20Z; runtime workspace deletion was confirmed at 22:51:36Z and node cleanup ran at 23:25:22Z. The original runtime was responsive after the erroneous stopped label; provider disappearance was not the initiating evidence.

Additional root cause: TaskRunner failure before workspace creation can call markIdle on a shared node; the NodeLifecycle warm alarm and destroying retry blindly marked D1 stopped. Final workspace admission already checks node running state, but teardown lacked the reciprocal atomic occupancy check.

- [x] Preserve active sibling workspaces when markIdle is called after failed placement.
- [x] Atomically fence warm expiry and destroying retries on node ownership, class, role, running state, workspace occupancy, and bounded warm claims.
- [x] Reject warm claims after node shutdown wins.
- [x] Validate real D1/DO occupancy and placement races.
- [x] Complete staging verification and cleanup.
- [ ] Complete release gates (tracked in PR).

Validation runs use serial package execution on this 4 GiB host after unconstrained parallel root checks exhausted memory (exit137); an interrupted run is not passing evidence.

## Recovered implementation validation

Full API discovery completed: 707 files, 9,589 tests; two failures exposed a missing allocation-writer inventory entry and legacy abstract-pool initialization. Both are fixed: the boundary suite passes 83/83, and upgrade/default-pool suites pass 111/111 including new disabled-source and no-repeat-catalog-refresh regressions. Other API tests passed (9,587). The first native offering initialization remains enabled only for active legacy pools, candidates, and sources; explicit disabled or native membership is preserved.

All 19 non-API package test tasks passed (web: 3,744 tests). Lint/typecheck/build completed 35/35 tasks. Focused startup tests pass 166/166; real Worker/D1 lifecycle/admission tests pass 79/79. Local Cloudflare, security, constitution, completion, documentation, and test review passed, including review of the final native-initialization predicate. Staging and release evidence will be appended after execution.

## Staging verification

Deployment [34316492417](https://github.com/raphaeltm/simple-agent-manager/actions/runs/34316492417) passed on 11497f0af, including smoke tests. Playwright executed a saved idea with the Codex Instant profile and a text attachment: submit returned 202 in 5.9 seconds, idea linking returned 201, GET confirmed the linked idea, and the agent returned the exact unique marker stored only in the attachment. An earlier browser harness closed before its asynchronous idea-link request; keeping the browser open until that response confirmed the existing UI behavior.

A 4 GiB VM request returned 202 in 6.8 seconds and selected an 8 GiB cx33. Node creation was 06:03:57Z, ready callback 06:06:24Z, and heartbeat was verified at 06:07:00Z. The workspace reached running, the browser displayed the agent response STARTUP_VM_VERIFIED, and the runtime containers endpoint returned 200. Dashboard, project, settings and chat navigation completed without browser page errors; screenshots were inspected.

Cleanup confirmed deletion of all three test nodes and deletion/removal of their workspaces. Test tasks and ideas were removed. One-hour D1 observability noise check passed. The 24-hour check retained older Sept 8 08:23–09:05 errors from before this deployment. Optional DO monitoring showed no wall-time regression and healthy cron; pre-deployment invocation-rate increases remained in the historical comparison. No runtime code changed after the staging-tested commit.

CI full coverage, lint, types, builds, browser and smoke checks passed. The full Worker run passed978/979 tests; its only failure was a direct-node provisioning lifetime fixture relying on the default4GiB reservation with only a4GiB offering. The fixture now explicitly requests a fitting2GiB small allocation; specialist review confirmed the correction and its4/4 Worker tests plus ESLint passed. No production code changed after staging. Full CI is rerunning for the test-only correction.

## CodeRabbit review follow-up

Raphaël manually triggered the review, which completed on c33715711 with five findings. Four are addressed: zero-row warm handoffs retire absent/terminal node state; Instant acceptance and continuation failures use the shared atomic terminal transition with failure phase preserved; both submission paths share background title/activity hooks. The blanket HTTPS-only upload proposal is declined because VM_AGENT_PROTOCOL=http is explicitly supported and the existing runtime-aware transport handles Instant over its private DO path; HTTPS remains the default. Added transport compatibility coverage.

Independent local review passed. Targeted unit tests34/34 and real Worker/D1 tests82/82 passed. Fresh staging and CI are required for these runtime follow-up changes; release gates remain pending.
