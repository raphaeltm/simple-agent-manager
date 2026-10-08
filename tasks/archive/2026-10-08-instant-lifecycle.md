# Instant container lifecycle and checkout fixes

## Problem
Sleeping Instant containers are reaped at the four-hour node ceiling, archive cannot confirm a sleeping container deletion, Stop races the onStop writer, and fresh output branches cannot be cloned.

## Research
- Production D1 read 2026-10-08: October 4 Instant nodes created 13:28/14:35 were deleted 17:31/18:36; October 1 nodes created 14:32–14:33 deleted 18:37.
- node-cleanup/node-phases.ts excludes sleeping workspaces from active count; shared.ts claims similarly lack sleeping-container protection. Snapshot retention owns sleeping Instant teardown.
- workspace-deletion.ts asks agent deletion after claiming stopping; container recovery refuses stopping workspaces. Use strict direct teardown without waking, preserving ownership fences.
- vm-agent-container-runtime.ts persistRuntimeEnded overwrites teardown claims; strict-node-deletion.ts correctly rejects changed incarnation/status.
- standalone_workspace.go ignores BaseBranch; VM bootstrap already distinguishes base and existing/new checkout branches.

## Checklist
- [x] Protect sleeping Instant at sweep selection and destructive claim boundary; preserve VM cleanup.
- [x] Directly destroy non-running Instant on archive; include failed archive stopping rows in reconciliation.
- [x] Fence runtime-ended writers and make repeated Stop idempotent with strict proof.
- [x] Clone BaseBranch, then track existing or create new output branch; preserve default behavior.
- [x] Add real SQL lifecycle/order and real git regression tests; prove failures before fixes.
- [x] Run lint/typecheck/tests/build and local specialist reviews.
- [x] Coordinate staging lease, deploy container image, verify real sleep/sweep/wake/archive/stop and required VM smoke.
- [ ] PR/CI/CodeRabbit, merge, production deployment, idea evidence/status, channel completion/unsubscribe.

## Acceptance criteria
Sleeping Instant survives past both node lifetime ceilings until retention expiry. Archive confirms deletion without waking sleeping compute. onStop cannot steal teardown claims; repeated Stop succeeds. Generated branch clones from base while existing branch content survives. Staging and production deployment evidence recorded before ideas completed.

## References
Ideas 01M3KYP55W91YQHV2FN1A2NVBT, 01M4BH36AZV3Q2J8MH43JXY8M6, 01M4AG60D25W5AFX96N2ABA9K8, 01M4B29WPWZSXSVFSKMTEV69T7; queue 01M4DR7MBDD8AAVF1XMC2XYQEX section 9. Coordination reliability-wave-1008. Rules 32, 53, 61, VM rollout rule 54; /do workflow.

## Local verification
Lint, typecheck, build, full Go, focused Go race, real Workers/D1 lifecycle tests, and all three specialist reviews passed. The bounded root suite completed 20/21 tasks successfully: API had 11,621 passing tests and one stale SQL-string assertion; updated that expectation in 3098cb271 and reran cleanup/lifecycle tests (21 passing). No other failures remained. Web passed all 4,023 tests.

## Staging evidence (2026-10-08)
- Lease79 released PASS/cleaned18:32UTC; direct handoff to failed-wake task per queue77.
- Deployment https://github.com/raphaeltm/simple-agent-manager/actions/runs/37820783081 attempt2 succeeded including smoke, runtimeSHA50927588a. Attempt1 failed before upload with transient R210042; read-only bucket lookup confirmed existence before retry.
- CFcontainer rollout44dff7a3-5902-4a21-9f21-29f6d485dbac completed to imageba23077b4f2f5d4f1ad34bfb7f37b990d5870eb09b254d4899729a5063f4640d. An early attempt hit the old image; only the completed-rollout test counts as clone verification.
- Instant task01M4EC8GQPNCBSV3PY095N88WE, workspace01M4EC8HF1SR8E957P5YZZ8R2H: generated branch sam/staging-smoke-test-only-5n88we cloned, agent wrote marker. Sleep200; D1 node/workspace sleeping, snapshot expiresOct15. Read-only future-clock selector probe: old4h selector at+5h=1, new selector at+48h=0; actual full sweep tested with48h injected age in Workers. Wake returned WAKE_OK and exact marker on same workspace/branch.
- Second Sleep200; first UI Archive removed workspace/container and stopped chat with no task error. Harness initially listened for DELETE rather than actual POST /close, so response capture timed out; independent D1/API state confirmed first action succeeded. Repeated close200 with original18:30:18.014Z timestamp.
- Running Instant workspace01M4ECH8EGABJ4Q47JS47KSZ18 Stop200; node/workspace deleted with identical18:31:49.627Z termination proof; repeatStop200stopped. Already-stopped old-image workspace Stop/repeat also200.
- Single cx23 VM01M4EBY1HW4ARC0R2G6HZHEZGJ: created18:20:43, heartbeat18:23:51, agent executed shell/printed branch and replied. Workspace/nodeDELETE200. All test compute and project01M4EAQMNMEAEZSQGZ2NP61231 deleted; D1 activeowned0. Browser dashboard/projects/settings passed with no pageerrors; sleeping screenshot reviewed.
- Observability pre-upload baseline:10x ACP Prompt started/completed noise, telemetry403 under read token; published to noiseowner. No new lifecycle errors in successful flows.
- Full CI Workers1397passed/1failed exposed old VM-recovery fixture using cf-container as fake provider; replaced with existing VMabsenceproof helper, disabled synthetic credential before existing no-placement recovery check. Scheduled Workers27passed, separateInstantWorkers2passed, reviewerPASS. No production code changed after stagingSHA.

## Release tracking
PR https://github.com/raphaeltm/simple-agent-manager/pull/2270. Implementation and staging complete; CI/CodeRabbit/production and idea completion remain gates tracked in PR and SAM task. Do not mark ideas complete before production deployment.

Final review delta: CI37825321086 and Sonar quality gate passed. Sonar nevertheless reported two critical cognitive-complexity findings in the new Go tests. Replaced manual argument-search loops with standard slices helpers, preserving all assertions; independent Go reviewer PASS. Current main merged cleanly; this delta changes no runtime behavior.
