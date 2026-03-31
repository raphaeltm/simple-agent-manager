# Forward NEKO_IMAGE and NEKO_PRE_PULL from API Worker to cloud-init

**Created**: 2026-03-31
**Source**: Constitution compliance review of Neko Browser Streaming Sidecar (PR #568)

## Problem

`packages/cloud-init/src/generate.ts` accepts `nekoImage` and `nekoPrePull` variables, but `apps/api/src/services/nodes.ts` never passes them from the Worker environment when calling `generateCloudInit()`. This means an operator setting `NEKO_IMAGE` on the Worker cannot override the default Neko Docker image in the cloud-init pre-pull step.

The VM agent side correctly reads `NEKO_IMAGE` from its own environment, so the runtime image is configurable. The gap is only in the cloud-init pre-pull phase — it will always pre-pull the hardcoded default image.

## Acceptance Criteria

- [ ] Add `NEKO_IMAGE?: string` and `NEKO_PRE_PULL?: string` to the `Env` interface in `apps/api/src/index.ts`
- [ ] Forward both to `generateCloudInit()` in `apps/api/src/services/nodes.ts`
- [ ] Add both to `apps/api/.env.example` with documentation
- [ ] Document in `docs/guides/self-hosting.md` if not already present
- [ ] Unit test verifying the values are passed through to cloud-init output
