# R5 dependency supply-chain pinning

## Problem

R5 findings 1–4 identified CI and development dependency drift in tool downloads, Docker base images, and Go module update coverage. The fix should harden dependency governance only, preserving current CI behavior, platforms, browser versions, build outputs, release semantics, and developer commands.

## Research findings

- `.devcontainer/post-create.sh` registers Playwright MCP through `@playwright/mcp@latest`, which allows unreviewed runtime drift during devcontainer setup.
- `.github/workflows/ci.yml` and `.github/workflows/devcontainer-cache-experiments.yml` install `@devcontainers/cli` without a version, so CI can change behavior without a repository review.
- `.github/workflows/deploy-staging.yml` installs `@playwright/test` without a version, and Playwright browser installation should continue using the reviewed package/runtime version already pinned in the repo.
- `apps/api/Dockerfile.sandbox`, `apps/api/Dockerfile.vm-agent-container`, and `scripts/e2e/workspace-mock/Dockerfile` used tag-only base images. The devcontainer cache experiment workflow also emitted temporary Dockerfiles from heredocs with tag-only `alpine` bases. Digest-only references plus nearby reviewed-source-tag comments preserve immutability and readability. Dependabot Docker coverage handles real Dockerfile manifests; workflow heredocs are covered by the governance test.
- `.github/dependabot.yml` covers only `packages/vm-agent/go.mod`; `packages/cli/go.mod` and `packages/harness/go.mod` are currently omitted.
- Existing quality tests live under `scripts/quality/*.test.ts` and run through `pnpm quality:specialist-review:test`.

## Checklist

- [x] Pin Playwright MCP and staging Playwright package installs to reviewed versions.
- [x] Pin devcontainers CLI installs in CI/development workflows to a reviewed version.
- [x] Pin Docker base images and embedded workflow `FROM` references to digest-only references with automated updater coverage where Dependabot can see the manifest.
- [x] Add Dependabot coverage for every Go module in the repository.
- [x] Add behavior/validation tests that parse dependency-governance surfaces and prove pinning/update coverage.
- [x] Document the safe dependency update procedure for contributors.
- [ ] Run relevant local validation and requested specialist reviews.
- [ ] Open one targeted PR and leave it unmerged.

## Acceptance criteria

- Playwright/action/runtime downloads touched by this task are immutable reviewed versions where the package manager supports it.
- Devcontainers CLI invocations in CI/development workflows are pinned rather than floating.
- Docker base image drift is prevented by digest-qualified references, Dependabot Docker coverage for real Dockerfiles, and governance tests for embedded workflow Dockerfiles.
- Every `go.mod` in the repository has Dependabot `gomod` coverage.
- Tests fail if these governance properties regress.
- Documentation explains how to safely update pins and digests.
