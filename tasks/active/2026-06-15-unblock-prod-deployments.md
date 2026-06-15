# Unblock Production Deployments

## Problem

Production deployments are not reaching the deploy step because the latest `main` CI run fails before the `workflow_run` production deploy trigger can proceed.

## Research Findings

- Latest failed `main` CI run: `27579195684` on `f33a95c3f01225b0cde761c54904cd824a91206d`.
- Latest production deployment runs after that CI failure are skipped, not failed in deploy logic.
- Passing jobs include deploy script validation, Pulumi infrastructure tests, lint, typecheck, build, and the main test job.
- Failing jobs are VM-agent/devcontainer jobs:
  - `VM Agent Integration`
  - `VM Agent E2E`
  - `Devcontainer Volume Mount`
- Failure signature is Microsoft Container Registry rate limiting:
  - `TOOMANYREQUESTS`
  - `mcr.microsoft.com/devcontainers/*`
- The workflow pre-pulls MCR images directly and the devcontainer tests also rely on those MCR tags during `devcontainer up`.

## Checklist

- [x] Add a CI helper that prepares local devcontainer fixture image tags without pulling MCR.
- [x] Replace direct MCR pre-pull workflow steps with the helper.
- [x] Cover all MCR tags used by CI devcontainer jobs.
- [x] Validate shell syntax and, if Docker is available, fixture image preparation.
- [ ] Push the branch and verify CI reaches green.

## Validation

- `bash -n scripts/ci/prepare-devcontainer-fixture-images.sh`
- `bash -n scripts/ci/test-devcontainer-volume-mount.sh`
- `git diff --check`
- Confirmed `.github/workflows/ci.yml` has no direct `docker pull mcr.microsoft.com` calls.
- Docker is not installed in this workspace, so fixture image build validation must run in GitHub Actions.

## Acceptance Criteria

- CI devcontainer jobs no longer fail solely because MCR returns `TOOMANYREQUESTS`.
- Production deployment trigger can run after a successful `main` CI workflow.
- The fix does not change production VM-agent runtime defaults.
