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
- [ ] Protect sleeping Instant at sweep selection and destructive claim boundary; preserve VM cleanup.
- [ ] Directly destroy non-running Instant on archive; include failed archive stopping rows in reconciliation.
- [ ] Fence runtime-ended writers and make repeated Stop idempotent with strict proof.
- [ ] Clone BaseBranch, then track existing or create new output branch; preserve default behavior.
- [ ] Add real SQL lifecycle/order and real git regression tests; prove failures before fixes.
- [ ] Run lint/typecheck/tests/build and local specialist reviews.
- [ ] Coordinate staging lease, deploy container image, verify real sleep/sweep/wake/archive/stop and required VM smoke.
- [ ] PR/CI/CodeRabbit, merge, production deployment, idea evidence/status, channel completion/unsubscribe.

## Acceptance criteria
Sleeping Instant survives past both node lifetime ceilings until retention expiry. Archive confirms deletion without waking sleeping compute. onStop cannot steal teardown claims; repeated Stop succeeds. Generated branch clones from base while existing branch content survives. Staging and production deployment evidence recorded before ideas completed.

## References
Ideas 01M3KYP55W91YQHV2FN1A2NVBT, 01M4BH36AZV3Q2J8MH43JXY8M6, 01M4AG60D25W5AFX96N2ABA9K8, 01M4B29WPWZSXSVFSKMTEV69T7; queue 01M4DR7MBDD8AAVF1XMC2XYQEX section 9. Coordination reliability-wave-1008. Rules 32, 53, 61, VM rollout rule 54; /do workflow.
