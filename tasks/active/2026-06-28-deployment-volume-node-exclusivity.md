# Deployment Volume Node Exclusivity

## Problem

Deployment manifests can declare persistent volumes, and the provider/service plumbing exists, but release submission does not create or attach declared volumes and deployment nodes do not mount late-attached block devices before apply. The vm-agent mount guard correctly refuses to start containers when SAM volume paths are plain directories, so stateful deployments fail today.

Implement SAM idea `01KW83WNMQBY7KF51RXWP3R9HM` Design Option B: environments with declared volumes get a fresh exclusive deployment node; volume-free environments continue sharing healthy shared nodes up to `DEFAULT_MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE`.

## Constraints

- Draft PR only. Do not mark ready and do not merge.
- Add `needs-human-review` label to the PR.
- Additive migrations only. Use `ALTER TABLE ADD COLUMN`; never recreate `deployment_environments` or `nodes`.
- mkfs must be format-only-if-empty and covered by a regression test.
- Keep provider-specific volume behavior in `packages/providers` / vm-agent descriptors, not app-level provider branches.
- GCP Persistent Disk support is optional and deferred unless required by tests.

## Research Findings

- Authoritative requirements: SAM idea `01KW83WNMQBY7KF51RXWP3R9HM`, R1-R8 and T1-T6.
- Release submission entry points:
  - `apps/api/src/routes/deployment-release-submission.ts:createDeploymentReleaseFromManifest`
  - `apps/api/src/routes/projects/compose-publish-release-callback.ts`
- Scheduling: `apps/api/src/services/deployment-provisioning.ts` currently bin-packs any deployment env onto running deployment nodes matching provider/location/size.
- Volume lifecycle: `apps/api/src/services/deployment-volumes.ts` has provider-agnostic create/attach/detach/delete helpers, but only manual routes call them.
- Compose bind paths: `apps/api/src/services/compose-renderer.ts` uses `resolveVolumeMountRoot()` and does not need a renderer redesign.
- Signed payload: `apps/api/src/services/deploy-signing.ts` and `packages/vm-agent/internal/deploy/signature.go` currently sign compose, routes, interpolation env, and artifacts, but not volume descriptors.
- vm-agent: `packages/vm-agent/internal/deploy/engine.go` runs `verifyVolumeMounts()` before compose, but no mkfs/mount/fstab step exists.
- Providers: Hetzner returns a stable `linuxDevice`; Scaleway returns raw volumes without `linuxDevice`, requiring node-side discovery.
- Existing tests to extend:
  - `apps/api/tests/unit/deployment-provisioning.test.ts`
  - `apps/api/tests/unit/routes/deployment-release-compose-submission.test.ts`
  - `apps/api/tests/unit/routes/compose-publish-release-callback.test.ts`
  - `apps/api/tests/unit/routes/deploy-release-callback.test.ts`
  - `apps/api/tests/unit/services/deploy-signing.test.ts`
  - `apps/api/tests/unit/services/deployment-volumes.test.ts`
  - `packages/vm-agent/internal/deploy/*_test.go`
  - `packages/providers/tests/unit/volume-operations.test.ts`

## Checklist

- [ ] Add additive D1 migration and Drizzle schema fields for `nodes.node_mode` and `deployment_environments.requires_volumes`.
- [ ] Detect manifest volume need after validation in both release-submission paths and persist `requires_volumes`.
- [ ] Update deployment scheduling so volume envs always create fresh exclusive nodes and stateless envs only reuse shared nodes.
- [ ] Tighten `linkEnvironmentToNode` with an exclusive-node zero-linked-env guard.
- [ ] Add provider-agnostic helper to create missing declared volumes and attach them before any apply can be dispatched.
- [ ] Extend deploy callback/signing to include volume mount descriptors and `volumeMountsHash`.
- [ ] Add vm-agent volume mount step before `verifyVolumeMounts`: discover device, format only when empty, mount, and write nofail fstab.
- [ ] Handle Hetzner stable device paths and Scaleway node-side discovery metadata.
- [ ] Ensure teardown detaches volumes before exclusive node destruction and excludes exclusive nodes from warm-pool reuse.
- [ ] Add T1-T6 coverage required by the idea.
- [ ] Run local quality gates and specialist reviews.
- [ ] Deploy to staging, verify migrations and changed behavior, then open a draft PR with `needs-human-review`.

## Acceptance Criteria

- Volume manifests create and attach environment volumes before deployment apply.
- Volume environments are isolated to fresh exclusive deployment nodes.
- Volume-free environments continue sharing shared nodes up to configured capacity.
- Signed apply payloads contain volume descriptors and the vm-agent verifies the signature over them.
- The vm-agent never formats a non-empty device on re-apply.
- Scaleway raw volumes can be discovered node-side; Hetzner stable by-id paths pass through.
- Staging evidence and specialist review evidence are included in the draft PR.
