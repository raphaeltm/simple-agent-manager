# Atomic VM-agent rollout artifacts

## Problem

Production task starts failed at `node_agent_ready` for 15 minutes even though each newly provisioned VM agent reported ready and continued to heartbeat. A production deployment can currently overwrite the mutable R2 VM-agent binary before the API Worker requiring that build is live. If Worker deployment fails after the upload, new VMs boot the new agent while the live control plane still requires the old commit SHA. The readiness gate correctly rejects the version mismatch, but the platform becomes unable to start any VM-backed task.

This happened on 2026-09-10. Deploy run `34497277954` uploaded commit `9cbc0b8d4eecabcb7bcf18708a01b3d10ed14a5d`, then `wrangler deploy` failed with `Script startup exceeded CPU time limit`. The live Worker remained on `a1c1d004030e66475368df8ff7301fa6a9867a32`. Tasks `01M268GJQX98HZ3E63AW27D94T`, `01M268N6ENQYPDD43XRZSG0NJZ`, and `01M26AA6VJ6QDDX4NXYKA8QP23` all provisioned healthy `9cbc0b8d4` nodes, waited until the 900000 ms timeout, and deleted them.

## Research findings

- `.github/workflows/deploy-reusable.yml` uploads both architectures to mutable `agents/vm-agent-linux-*` keys before `wrangler deploy`.
- `apps/api/src/routes/binary-artifacts.ts` always resolves downloads from one mutable prefix and gives responses a cacheable URL with no release identity.
- `packages/cloud-init/src/template.ts` downloads `/api/agent/download?arch=...` without the control plane's required agent version.
- `apps/api/src/services/node-provisioning.ts` has `VM_AGENT_REQUIRED_VERSION` when it renders cloud-init but does not pass it into the template.
- `apps/api/src/routes/agent.ts` generates a manual install script with the same unversioned download URL.
- The readiness checks in `task-runner/readiness.ts` behaved correctly. Removing version gating would hide the deployment split and could schedule incompatible agents.
- Rule 54 requires artifact publication before the controller requirement, but a mutable object makes that order unsafe when any later deployment step fails.
- The retained 2026-08-06 node-reaping post-mortem introduced exact rollout compatibility but did not test failure between artifact upload and Worker publication.

## Implementation checklist

- [ ] Publish VM-agent binaries under immutable release keys containing the exact deployment SHA; stop overwriting the legacy mutable keys in normal deploys.
- [ ] Extend binary artifact routing so an explicitly requested, validated VM-agent release resolves to its immutable R2 prefix while legacy/unversioned callers retain the existing fallback.
- [ ] Pass `VM_AGENT_REQUIRED_VERSION` through node provisioning into cloud-init and include it in the download URL so the cache key and R2 object identity match the controller requirement.
- [ ] Make the generated install script request the live Worker's required release when configured.
- [ ] Return immutable cache semantics for version-addressed binaries and retain bounded cache semantics for legacy mutable downloads.
- [ ] Add discriminating tests for release-key routing, invalid release input, legacy fallback, cloud-init propagation, node-provisioning propagation, and deployment workflow ordering/key construction.
- [ ] Update rollout guidance and public documentation to record the immutable artifact contract and partial-deploy behavior.
- [ ] Prove the change locally, then deploy to staging and start a real VM-backed session whose node reports the exact staging-required version.

## Acceptance criteria

- A deployment that uploads a new VM-agent release and then fails before Worker publication leaves the live Worker's download path serving its previously required compatible release.
- Successful deployments provision new VMs from an immutable R2 key derived from the same SHA stored in `VM_AGENT_REQUIRED_VERSION`.
- The download URL changes across agent releases, so cached bytes cannot cross a version boundary.
- Invalid or path-like release identifiers cannot influence R2 keys.
- `skip_agent` and legacy/manual development deployments with no required version retain the existing unversioned fallback behavior.
- Readiness version gates remain enabled and unchanged.
- Focused unit and workflow-contract tests, the full quality suite, Cloudflare specialist review, task completion validation, and a real staging VM startup all pass.

## References

- `.claude/rules/32-cf-api-debugging.md`
- `.claude/rules/54-vm-agent-rollout-compatibility.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/39-debug-before-redesign.md`
- `tasks/archive/2026-08-06-fix-node-reaping-orphan-reconciliation.md`
- Production deploy run `34497277954`
- Emergency recovery deploy run `34530886056`
