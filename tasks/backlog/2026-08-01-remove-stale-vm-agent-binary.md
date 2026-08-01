# Remove stale tracked VM-agent binary

## Problem

`packages/vm-agent/vm-agent` is a tracked executable binary artifact in source control. It is stale historical build output, roughly 18 MB, and should not be part of the repository. Current deployment flows build VM-agent artifacts from source into dedicated artifact directories, so removing the root binary should not change runtime behavior.

## Research Findings

- `git ls-files packages/vm-agent/vm-agent` confirms the root VM-agent binary is tracked.
- `ls -lh packages/vm-agent/vm-agent` confirms it is executable and roughly 18 MB.
- `.github/workflows/deploy-reusable.yml` builds deployment artifacts with `make -C packages/vm-agent build-all` and uploads from `packages/vm-agent/bin/vm-agent-linux-{amd64,arm64}`.
- `.github/workflows/deploy-reusable.yml` prepares the raw container VM-agent artifact with `make -C packages/vm-agent prepare-container`.
- `apps/api/Dockerfile.vm-agent-container` copies `apps/api/container-artifacts/vm-agent-linux-amd64` into `/usr/local/bin/vm-agent`; it does not copy `packages/vm-agent/vm-agent`.
- `packages/vm-agent/Makefile` writes build outputs under `packages/vm-agent/bin/` and container artifacts under `apps/api/container-artifacts/`.
- `packages/cloud-init/src/template.ts` and `scripts/vm/cloud-init.yaml` download the VM-agent binary from `/api/agent/download` into `/usr/local/bin/vm-agent`; they do not read a repository-root VM-agent binary.
- Existing quality tests already assert deployment VM-agent build/version behavior in `scripts/quality/deploy-reusable-workflow.test.ts`.

## Implementation Checklist

- [ ] Search code, scripts, workflows, docs, and task history for references to the exact stale path `packages/vm-agent/vm-agent`.
- [ ] Remove only `packages/vm-agent/vm-agent` from tracked source control.
- [ ] Add an ignore rule for `/packages/vm-agent/vm-agent` without ignoring valid source or `packages/vm-agent/bin/` artifacts unexpectedly.
- [ ] Add or update a deterministic quality check/test that fails if `packages/vm-agent/vm-agent` is tracked or present as a repository artifact.
- [ ] Wire the guard into existing quality/CI scripts if it is not already covered.
- [ ] Run focused tests for the guard and relevant VM-agent/deployment quality checks.
- [ ] Run repository quality checks required for the PR and confirm GitHub CI is green.
- [ ] Create a PR that explicitly states no runtime behavior change and cites deployment-artifact evidence; do not merge it.

## Acceptance Criteria

- `packages/vm-agent/vm-agent` is deleted from git.
- No runtime code, script, or deployment path references `packages/vm-agent/vm-agent`.
- The repository ignores and/or rejects the exact stale root binary if generated locally.
- Automated quality coverage proves the guard.
- Relevant tests and CI pass.
- PR is open and unmerged, with explicit no-behavior-change wording and evidence that deploy artifacts are built from source elsewhere.

## References

- `packages/vm-agent/`
- `packages/vm-agent/Makefile`
- `package.json`
- `.github/workflows/ci.yml`
- `.github/workflows/deploy-reusable.yml`
- `scripts/quality/deploy-reusable-workflow.test.ts`
- `apps/api/Dockerfile.vm-agent-container`
- `packages/cloud-init/src/template.ts`
