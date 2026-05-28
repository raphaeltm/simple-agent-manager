# CLI Artifact Distribution Pipeline

## Problem

SAM deployments need to own and serve their own CLI binaries from the same deployment-owned R2 bucket used for other binary artifacts. The CLI currently lives in `packages/cli`, but there is no cross-build target, deployment upload step, or API download surface for web links and installer flows.

## Research Findings

- `packages/cli` is a Go CLI with `./cmd/sam` as the build entry point. CLI changes must follow `.claude/rules/36-cli-quality.md`, including `go test -race -coverprofile=coverage.out -covermode=atomic ./...`.
- `packages/vm-agent/Makefile` already cross-compiles platform binaries into `bin/` using `GOOS` and `GOARCH`; the CLI should use the same simple Makefile pattern.
- `.github/workflows/ci.yml` already has a `cli-test` job and CLI path filter. It runs race+coverage tests but does not verify cross-builds yet.
- `.github/workflows/deploy-reusable.yml` builds and uploads VM agent binaries to the Pulumi-provisioned R2 bucket using `pnpm --filter @simple-agent-manager/api exec wrangler r2 object put ... --remote`. CLI upload should extend this deployment-owned R2 pattern rather than adding another storage service.
- `apps/api/src/routes/agent.ts` already exposes R2-backed binary download and version endpoints for the VM agent. CLI endpoints can use the same Hono/R2 response pattern while returning unavailable metadata when `cli/version.json` is missing.
- `apps/api/src/env.ts` exposes the existing `R2: R2Bucket` binding; no new binding should be added.
- Relevant postmortems:
  - `docs/notes/2026-03-30-r2-cors-upload-failure-postmortem.md`: infrastructure configuration must be automated and staging verification must exercise the actual feature.
  - `docs/notes/2026-04-25-artifacts-broken-merge-postmortem.md`: do not rationalize missing bindings/config as acceptable; failed staging feature verification blocks merge.
  - `docs/notes/2026-05-19-cli-sonar-quality-gap-postmortem.md`: CLI CI must enforce coverage and quality gates.

## Implementation Checklist

- [x] Add `packages/cli/Makefile` with cross-build targets for `linux/amd64`, `linux/arm64`, `darwin/amd64`, and `darwin/arm64`.
- [x] Update ignore rules for generated `packages/cli/bin/` artifacts if needed.
- [x] Update CI CLI job to run the cross-build in addition to the existing race+coverage test command.
- [x] Update deployment workflow to build the CLI and upload four binaries plus `cli/version.json` to the Pulumi-provisioned R2 bucket.
- [x] Add `GET /api/cli/download?os=<linux|darwin>&arch=<amd64|arm64>` using the existing R2 binding, with binary streaming headers and cache headers.
- [x] Add `GET /api/cli/version` returning available metadata from `cli/version.json` and unavailable metadata when missing or unconfigured.
- [x] Add focused API route tests for successful macOS arm64 download, unsupported platform, missing R2 binding, missing object, available version metadata, and missing version metadata.
- [x] Run focused local checks: CLI race+coverage tests, CLI cross-build, API route tests, and relevant typecheck/build.
- [ ] Run specialist validation for task completion, Cloudflare/R2 deployment, tests, CLI quality, and hardcoded-value compliance.
- [ ] Deploy to staging through the normal workflow, verify real R2/API evidence for version and download endpoints, then open PR, wait for CI, merge, and verify production endpoints.

## Acceptance Criteria

- CLI cross-build produces `sam-linux-amd64`, `sam-linux-arm64`, `sam-darwin-amd64`, and `sam-darwin-arm64`.
- CI verifies the CLI race+coverage test command and the cross-build.
- Staging and production deploys upload CLI artifacts to the existing deployment R2 bucket under `cli/*`.
- `GET /api/cli/download` returns the selected private R2 object with `application/octet-stream`, attachment filename, content length, and cache headers.
- `GET /api/cli/version` returns `{ available, version, buildDate }` from `cli/version.json`, or unavailable metadata when missing.
- Focused API tests cover successful download, invalid platform, missing binding, missing object, present version metadata, and missing version metadata.
- Real staging evidence confirms version metadata and at least macOS arm64 plus one Linux binary download endpoint.
- Real production evidence confirms version metadata and macOS arm64 download endpoint after merge/deploy.
