# Patch Go toolchain floor for VM agent and CLI security validation

## Problem

CTO audit finding CTO3-007 identified that the VM agent and CLI can be built and scanned with older Go toolchains that still contain reachable standard-library vulnerabilities. The remediation must pin a patched Go toolchain floor for VM-agent and CLI validation/build paths while preserving existing Go language compatibility directives unless a technical requirement forces otherwise.

Constraints:

- Work from current `origin/main` on branch `sam/remediation-pr-3-patch-qbmv7r`.
- Keep this task record on the feature branch; do not commit directly to `main`.
- Create at most one tightly targeted, non-draft PR.
- Do not merge.
- Do not deploy or mutate staging; the parent orchestrator owns one consolidated staging pass.
- Preserve all existing API, CLI, UI, configuration, and data-format contracts.
- Do not upgrade third-party modules or perform unrelated cleanup.

## Research findings

- Current branch `sam/remediation-pr-3-patch-qbmv7r` starts at `origin/main` commit `7ccf04622`; `.codex/config.toml` is a pre-existing unrelated local modification and must not be touched.
- SAM task `01M048Y1EGM2310BMQKZGCTZJN` completed the read-only CTO audit and reported CTO3-007 against:
  - `packages/vm-agent/go.mod:3`
  - `packages/cli/go.mod:3`
  - `.github/workflows/ci.yml` Go setup blocks around the govulncheck, VM-agent, and CLI jobs.
- Current active sibling remediation tasks are `01M04B8X773A5QGT4Q1AQQHMF7` (PR 1) and `01M04B98AJ59XNZGA3MJQCQDGA` (PR 2). They are on separate branches and do not own this Go toolchain floor.
- Relevant open PR conflict check:
  - PR #1795 changes `packages/vm-agent/go.mod`/`go.sum` for a dependency bump; this task must avoid unrelated dependency churn.
  - PR #1738 changes CLI behavior/tests but not CLI Go module metadata.
  - PR #1830 is a broad batch PR with many security changes but not the same minimal Go floor remediation.
- Official Go release data from `https://go.dev/dl/?mode=json` on 2026-08-16 reports `go1.26.6` as the latest stable release, and `go1.25.13` as the previous stable release.
- Official Go release history says `go1.26.6` and `go1.25.13` were released 2026-08-13 with security fixes in `go` command and standard-library packages including `crypto/tls`, `encoding/asn1`, `encoding/xml`, `html/template`, `net/http`, and `net/url`.
- Official Go toolchain docs state that `go` and `toolchain` lines in `go.mod` specify the module's Go toolchain dependency. This supports adding a `toolchain` directive without raising the source-language `go` directive.
- Current locked govulncheck tool:
  - Built from `scripts/quality/govulncheck-tool`.
  - Reports `Scanner: govulncheck@v1.6.0`, DB `https://vuln.go.dev`, DB updated `2026-08-14T16:22:54Z`.
- Pre-fix govulncheck evidence with the current DB:
  - `packages/vm-agent`: selected `go1.25.0`; 156 reachable findings across 46 unique OSV IDs.
  - `packages/cli`: selected local `go1.24.13`; 81 reachable findings across 29 unique OSV IDs.
  - The counts differ from the earlier audit because the vulnerability database has advanced, but the vulnerable-toolchain class is the same.
- Current repository Go version drift:
  - `.github/workflows/ci.yml` uses `go-version: '1.25'` in the Go vulnerability diff, VM-agent, CLI, VM-agent integration, and VM-agent E2E jobs.
  - `.github/workflows/deploy-reusable.yml` sets `GO_VERSION: '1.25'` and uses it to build VM-agent deployment artifacts; the CLI build later relies on the same job environment after that setup.
  - `.github/workflows/e2e-smoke.yml` uses `go-version: '1.25'`.
  - `.devcontainer/devcontainer.json` installs Go feature version `1.24`.
  - `apps/www/src/content/docs/docs/guides/local-development.md` says Go 1.25+ is needed for VM-agent work.
  - `CLAUDE.md` and `AGENTS.md` still mention older Go floors.
- Dockerfiles inspected:
  - `apps/api/Dockerfile.vm-agent-container` copies a deploy-built `vm-agent` binary; it does not install or select Go.
  - `apps/api/Dockerfile.sandbox` and `scripts/e2e/workspace-mock/Dockerfile` do not define the VM-agent/CLI build toolchain.

## Implementation checklist

- [x] Preserve `packages/vm-agent/go.mod` `go 1.25.0` and add the patched toolchain directive.
- [x] Preserve `packages/cli/go.mod` `go 1.24.0` and add the patched toolchain directive.
- [x] Update CI Go setup references for govulncheck, VM-agent, CLI, integration, E2E, and smoke jobs to the selected patched release.
- [x] Update deploy/release Go setup references so VM-agent and CLI deployment artifacts are compiled with the selected patched release.
- [x] Add an explicit CI/deploy compiler version assertion so version drift fails fast.
- [x] Update devcontainer and relevant docs/agent instructions to remove stale Go version guidance.
- [x] Add discriminating tests that fail on pre-fix behavior:
  - [x] `go.mod` files must contain the patched `toolchain` directive while preserving their `go` directives.
  - [x] The govulncheck tool module must also contain the patched `toolchain` directive while preserving its `go` directive.
  - [x] CI/deploy/smoke/devcontainer Go references must use the same patched release.
  - [x] CI/deploy workflows must assert `go1.26.6` after setup.
- [x] Run focused tests for the new wiring assertions.
- [x] Run Go package build/test/race/vet/coverage/govulncheck validation for `packages/vm-agent` and `packages/cli`.
- [x] Run VM-agent integration and E2E scenario suites.
- [x] Run proportionate repository gates.
- [x] Run mandatory local reviewers and record truthful evidence.
- [x] Archive the task file only after task-completion-validator passes.
- [x] Open one non-draft PR after local validation; monitor CI until every applicable check is terminal green; do not merge.

## Acceptance criteria

- `packages/vm-agent/go.mod` still declares `go 1.25.0` and also requires the patched stable Go toolchain.
- `packages/cli/go.mod` still declares `go 1.24.0` and also requires the patched stable Go toolchain.
- CI, smoke, deploy, and devcontainer Go version references are consistent with the selected patched toolchain or intentionally absent because they do not compile Go.
- CI/deploy workflows assert the actual Go compiler version after setup.
- No third-party Go modules are upgraded as part of this remediation.
- `govulncheck ./...` passes for both `packages/vm-agent` and `packages/cli` with zero reachable targeted standard-library findings.
- VM-agent and CLI build, race tests, vet/static checks, and CLI coverage expectations pass.
- PR body includes official Go documentation/source evidence and local specialist review evidence.
- Staging is intentionally not deployed or mutated for this task.

## PR and CI evidence

- Pull request: https://github.com/raphaeltm/simple-agent-manager/pull/1832
- PR type: non-draft, open, not merged.
- Staging/deploy: not run and not mutated by explicit orchestration override.
- Branch commit: `a264d7c94` (`Pin Go toolchain floor for VM agent and CLI`).
- PR body evidence checks passed locally against the live PR body:
  - `scripts/quality/check-preflight-evidence.ts`
  - `scripts/quality/check-specialist-review-evidence.ts`
- GitHub checks were monitored to terminal green. Passing checks included:
  - Build
  - CLI Test
  - Code Quality Checks
  - CodSpeed Performance Analysis
  - Detect Changes
  - Devcontainer Validation
  - Devcontainer Volume Mount
  - Durable Object Workers
  - Go Vulnerability Diff
  - Lint
  - Playwright Visual Tests
  - Preflight Evidence
  - Pulumi Infrastructure Tests
  - Run benchmarks
  - Secret Scan
  - SonarCloud Code Analysis
  - Specialist Review Evidence
  - Test
  - Type Check
  - UI Compliance
  - VM Agent E2E
  - VM Agent Integration
  - VM Agent Smoke (mock)
  - VM Agent Smoke (worker)
  - VM Agent Test
  - Validate Deploy Scripts

## Validation evidence

- Discriminating pre-fix test:
  - `pnpm exec vitest run --config scripts/quality/vitest.config.ts go-toolchain-floor.test.ts` failed before implementation on the missing `toolchain go1.26.6` directives, hardcoded `go-version: '1.25'` workflow references, stale devcontainer Go `1.24`, and stale docs.
- Focused post-fix tests:
  - `pnpm exec vitest run --config scripts/quality/vitest.config.ts go-toolchain-floor.test.ts` passed.
  - `pnpm exec vitest run --config scripts/quality/vitest.config.ts go-toolchain-floor.test.ts ci-quality-program.test.ts deploy-reusable-workflow.test.ts` passed.
  - After local reviewer feedback, workflow assertions were tightened from a substring grep to `grep -E '^go version go1\.26\.6 '`, and the focused quality suite above still passed.
- Official/current govulncheck evidence:
  - Built `scripts/quality/govulncheck-tool` with `GOTOOLCHAIN=auto`; `/tmp/sam-govuln-bin-126/govulncheck -version` reported Go `go1.26.6`, scanner `govulncheck@v1.6.0`, DB `https://vuln.go.dev`, DB updated `2026-08-14T16:22:54Z`.
  - `packages/vm-agent`: `GOTOOLCHAIN=auto /tmp/sam-govuln-bin-126/govulncheck -json ./...` selected `go1.26.6` and reported zero findings.
  - `packages/cli`: `GOTOOLCHAIN=auto /tmp/sam-govuln-bin-126/govulncheck -json ./...` selected `go1.26.6` and reported zero findings.
  - `SAM_GOVULNCHECK_BIN=/tmp/sam-govuln-bin-126/govulncheck pnpm quality:govulncheck-diff` passed.
- Go package validation:
  - `cd packages/vm-agent && GOTOOLCHAIN=auto go test -race -coverprofile=/tmp/sam-vm-agent-cover.out -covermode=atomic ./...` passed; total coverage `62.0%`.
  - `cd packages/vm-agent && GOTOOLCHAIN=auto go vet ./... && GOTOOLCHAIN=auto make build-all` passed.
  - `cd packages/cli && GOTOOLCHAIN=auto go test -race -coverprofile=coverage.out -covermode=atomic ./...` passed; total coverage `81.2%`.
  - `cd packages/cli && GOTOOLCHAIN=auto go vet ./... && GOTOOLCHAIN=auto make build-all` passed.
- VM-agent scenario validation:
  - `cd packages/vm-agent && GOTOOLCHAIN=auto go test -race -v -tags e2e -timeout 15m ./internal/e2e/` passed.
  - `bash scripts/ci/prepare-devcontainer-fixture-images.sh` passed.
  - `cd packages/vm-agent && GOTOOLCHAIN=auto go test -race -v -tags integration -timeout 15m ./internal/bootstrap/ ./internal/acp/` passed.
- Repository gates:
  - `pnpm check:fast` passed, including rerun after reviewer-driven assertion/test hardening.
  - `pnpm typecheck` passed.
  - `pnpm test` passed: 21/21 turbo tasks successful.
  - `pnpm build` passed: 9/9 turbo tasks successful.
- Local static-analysis note:
  - `go vet` passed for both Go packages.
  - `golangci-lint run` in `packages/cli` and `packages/vm-agent` currently reports unrelated pre-existing findings. They were not fixed because this remediation is constrained to toolchain pinning and no unrelated cleanup.

## Specialist review evidence

- go-specialist: PASS. Confirmed Go module semantics are correct, `go` language directives are preserved, `toolchain go1.26.6` is applied to VM-agent/CLI/govulncheck-tool, CI/deploy/smoke compiler assertions are consistent, CLI quality rule expectations are satisfied for the changed metadata/CI path, and govulncheck reports no vulnerabilities with Go 1.26.6. Noted unrelated existing `golangci-lint` debt is not caused by this diff.
- security-auditor: PASS. Confirmed official Go evidence supports Go 1.26.6 as a patched stable floor, govulncheck proof is sufficient, no security-sensitive runtime/auth/credential contract is weakened, and workflow drift is closed. Non-blocking recommendation to make the assertion exact was implemented.
- test-engineer: PASS. Confirmed the focused test is discriminating and would fail pre-fix. Non-blocking feedback to include the govulncheck tool module in the test was implemented.
- env-validator: PASS for env/config scope after explicit resolution. Confirmed workflow `GO_VERSION` usage is consistent, no GH/GITHUB secret naming errors or new secrets were added, deploy-reusable uses the same Go setup before VM-agent/CLI artifact builds, and staging was not touched. Flagged unrelated `.codex/config.toml` as out of scope; it remains unstaged and must be excluded from the PR.
- doc-sync-validator: PASS. Confirmed CLAUDE.md, AGENTS.md, public local-development docs, devcontainer, workflows, and Go modules are synchronized to Go 1.26.6+ for the scoped remediation.
- constitution-validator: PASS. Confirmed the literal Go 1.26.6 pin is justified as an intentional security floor and found no newly introduced hardcoded URL, timeout, limit, or internal identifier. Noted assertion duplication is acceptable and covered by the focused test.
- task-completion-validator: PASS on final review. Confirmed PR #1832 is open, non-draft, unmerged, clean, and all checks are terminal green; branch diff implements the planned work; `.codex/config.toml` remains excluded as unrelated local state; staging/deploy skip is correctly recorded.

## Branch hygiene

- Commit `a264d7c94` contains the scoped remediation files only.
- `git diff --name-only origin/main...HEAD` excludes `.codex/config.toml`; that file remains an unrelated unstaged local modification and is not part of this branch/PR.
