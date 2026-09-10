# Atomic VM-agent rollout artifacts

## Problem

Production task starts failed at `node_agent_ready` for 15 minutes even though each newly provisioned VM agent reported ready and continued to heartbeat. A production deployment can currently overwrite the mutable R2 VM-agent binary before the API Worker requiring that build is live. If Worker deployment fails after the upload, new VMs boot the new agent while the live control plane still requires the old commit SHA. The readiness gate correctly rejects the version mismatch, but the platform becomes unable to start any VM-backed task.

This happened on 2026-09-10. Deploy run `34497277954` uploaded commit `9cbc0b8d4eecabcb7bcf18708a01b3d10ed14a5d`, then `wrangler deploy` failed with `Script startup exceeded CPU time limit`. The live Worker remained on `a1c1d004030e66475368df8ff7301fa6a9867a32`. Tasks `01M268GJQX98HZ3E63AW27D94T`, `01M268N6ENQYPDD43XRZSG0NJZ`, and `01M26AA6VJ6QDDX4NXYKA8QP23` all provisioned healthy `9cbc0b8d4` nodes, waited until the 900000 ms timeout, and deleted them.

The emergency recovery deploy then exposed a second deployment-atomicity failure. Active Instant session `de9c5b94-6a45-457e-a115-4b0fb3d4ae04` entered runtime recovery when the first API Worker revision stopped its container at 21:26:11 UTC. The same workflow subsequently published a secret-bulk revision and a final API redeploy. Cloudflare reset the `VmAgentContainer` Durable Object during both allowed recovery launches with `Durable Object reset because its code was updated.` The second deployment-induced reset exhausted the default two-attempt recovery budget at 21:31:13. Production evidence does not show a corrupt checkpoint: both failures occurred during runtime launch, before snapshot restore.

## Research findings

- `.github/workflows/deploy-reusable.yml` uploads both architectures to mutable `agents/vm-agent-linux-*` keys before `wrangler deploy`.
- `apps/api/src/routes/binary-artifacts.ts` always resolves downloads from one mutable prefix and gives responses a cacheable URL with no release identity.
- `packages/cloud-init/src/template.ts` downloads `/api/agent/download?arch=...` without the control plane's required agent version.
- `apps/api/src/services/node-provisioning.ts` has `VM_AGENT_REQUIRED_VERSION` when it renders cloud-init but does not pass it into the template.
- `apps/api/src/routes/agent.ts` generates a manual install script with the same unversioned download URL.
- `.github/workflows/deploy-reusable.yml` publishes up to three API Worker revisions in one established deployment: the initial code deploy, `wrangler secret bulk`, and the final code redeploy. Each revision can reset an active `VmAgentContainer` and interrupt its durable recovery attempt.
- Workers Observability recorded `vm_agent_container_recovery_started` at 21:26:11, launch failures at 21:27:38 and 21:28:55, and `Durable Object reset because its code was updated.` on the recovery alarms. D1 then recorded `Instant runtime recovery exhausted`; no `session_snapshots` row existed because this was active-container recovery rather than an idle-sleep snapshot wake.
- The readiness checks in `task-runner/readiness.ts` behaved correctly. Removing version gating would hide the deployment split and could schedule incompatible agents.
- Rule 54 requires artifact publication before the controller requirement, but a mutable object makes that order unsafe when any later deployment step fails.
- The retained 2026-08-06 node-reaping post-mortem introduced exact rollout compatibility but did not test failure between artifact upload and Worker publication.
- A commit-addressed key is not immutable if a same-commit retry rebuilds with a wall-clock timestamp and overwrites it. Builds must use commit-derived metadata, and publication must reuse only byte-identical existing objects or fail before Worker publication.

## Implementation checklist

- [x] Publish VM-agent binaries under immutable release keys containing the exact deployment SHA; stop overwriting the legacy mutable keys in normal deploys.
- [x] Make same-SHA builds deterministic and make release publication reuse byte-identical objects while rejecting digest-changing overwrites.
- [x] Extend binary artifact routing so an explicitly requested, validated VM-agent release resolves to its immutable R2 prefix while legacy/unversioned callers retain the existing fallback.
- [x] Pass `VM_AGENT_REQUIRED_VERSION` through node provisioning into cloud-init and include it in the download URL so the cache key and R2 object identity match the controller requirement.
- [x] Make the generated install script request the live Worker's required release when configured.
- [x] Return immutable cache semantics for version-addressed binaries and retain bounded cache semantics for legacy mutable downloads.
- [x] Reorder established-installation Worker secret/code publication so recovery has a surviving attempt after the final Worker revision, while retaining first-install bootstrap behavior.
- [x] Add discriminating tests for release-key routing, invalid release input, legacy fallback, cloud-init propagation, node-provisioning propagation, and deployment workflow ordering/key construction.
- [x] Update rollout guidance and public documentation to record the immutable artifact contract and partial-deploy behavior.
- [ ] Prove the change locally, then deploy to staging and start a real VM-backed session whose node reports the exact staging-required version.

## Acceptance criteria

- A deployment that uploads a new VM-agent release and then fails before Worker publication leaves the live Worker's download path serving its previously required compatible release.
- Re-running a deployment for the same commit cannot replace the bytes behind an immutable release URL.
- Successful deployments provision new VMs from an immutable R2 key derived from the same SHA stored in `VM_AGENT_REQUIRED_VERSION`.
- The download URL changes across agent releases, so cached bytes cannot cross a version boundary.
- Invalid or path-like release identifiers cannot influence R2 keys.
- `skip_agent` and legacy/manual development deployments with no required version retain the existing unversioned fallback behavior.
- Readiness version gates remain enabled and unchanged.
- An established deployment cannot consume every Instant recovery attempt solely through its own Worker revision sequence; first-install deployment still configures secrets and publishes a usable Worker.
- Focused unit and workflow-contract tests, the full quality suite, Cloudflare specialist review, task completion validation, and a real staging VM startup all pass.

## References

- `.claude/rules/32-cf-api-debugging.md`
- `.claude/rules/54-vm-agent-rollout-compatibility.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/39-debug-before-redesign.md`
- `tasks/archive/2026-08-06-fix-node-reaping-orphan-reconciliation.md`
- Production deploy run `34497277954`
- Emergency recovery deploy run `34530886056`
- Production Workers Observability events for node `01M26JCP6R9CVYW59KFV4V93FW` and task `01M26JCNWP0XCZ5X5TEW0J67EQ`

## Incident post-mortem

### What broke

The deploy published VM-agent bytes and Worker state as separate mutable revisions. A failed Worker publish left new VMs incompatible with the live controller. The emergency deploy then reset an active Instant container three times and consumed both recovery launches.

### Root cause

The binary URL did not contain the controller's required release, so artifact publication was not atomic with controller publication. The established deployment path also ran an initial API deploy before its secret-bulk and final API revisions, exceeding the two-attempt Instant recovery budget.

### Why existing controls missed it

Version-aware readiness correctly rejected incompatible nodes, but workflow tests checked only that artifact upload preceded deploy. They did not simulate or assert the identity used after a partial deploy. Deployment tests also checked schema ordering and final asset restoration without bounding the number and order of Worker revisions for established installations.

### Process fix

Rule 54 and workflow contract tests now require commit-addressed artifact keys, exact required-version propagation, first-install-only bootstrap publication, and a single final code publication after bulk secrets on established installations.
