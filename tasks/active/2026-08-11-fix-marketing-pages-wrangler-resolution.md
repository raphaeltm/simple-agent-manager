# Fix marketing Pages Wrangler resolution

## Problem

The `Deploy Marketing Site` workflow has failed on every affected `main` push since PR #1784. The marketing site builds successfully, but the Cloudflare Pages deployment exits with `sh: 1: wrangler: not found`.

The public site remains available from the last successful deployment, but changes under `apps/www` are no longer reaching production. The manually triggered provisioning workflow contains the same vulnerable command pattern.

## Research findings

- `.github/workflows/deploy-www.yml` runs `npx wrangler pages deploy ...` after a frozen pnpm install.
- `.github/workflows/provision-www.yml` runs `npx wrangler pages project create ...` after the same install.
- PR #1784 added root lint dependencies whose transitive graph includes Wrangler. `npm exec` now detects that transitive installation and does not download another copy, but pnpm does not expose its binary at the repository root, so `npx wrangler` exits 127.
- A controlled before/after checkout reproduced the regression: the parent of PR #1784 downloads Wrangler and succeeds, while PR #1784 and current `main` fail with `wrangler: not found`.
- `pnpm --filter @simple-agent-manager/www exec wrangler` currently fails because `apps/www` does not declare Wrangler.
- `apps/api` and `apps/web` already declare the catalog-pinned Wrangler 4.118.0. The marketing workspace should own its own deployment executable rather than depend on another application workspace.
- `scripts/quality/deployment-workflow-hardening.test.ts` already enforces marketing workflow naming contracts, making it the appropriate place for a frozen-Wrangler source contract.
- Cloudflare's current official Wrangler reference confirms `pages deploy [DIRECTORY] --project-name ...` and `pages project create [PROJECT-NAME] --production-branch ...` remain supported.
- The retained Wrangler v4 incident lesson in `tasks/archive/2026-04-25-upgrade-wrangler-v4.md` demonstrates why deployment tooling version and invocation must be explicit and verified end to end.
- Specialist review found that the existing provisioning command's blanket `|| echo` converted authentication, network, CLI, and missing-binary failures into false success. The touched step must distinguish an existing project from real failures.

## Preflight

### Classification

- `external-api-change`: no Cloudflare API contract changes; current official CLI syntax was nevertheless verified.
- `cross-component-change`: the marketing package manifest, two GitHub workflows, lockfile, and quality contract must agree.
- `public-surface-change`: no user-facing interface changes; this restores publication of the existing public site.
- `docs-sync-change`: no public documentation changes are required because commands and configuration inputs remain unchanged.
- `security-sensitive-change`: no permissions, credentials, or secret flow changes.
- `infra-change`: yes; Cloudflare Pages deployment and provisioning workflows change.

### External reference

- Cloudflare Wrangler Pages commands: https://developers.cloudflare.com/workers/wrangler/commands/pages/

### Codebase impact

1. `apps/www/package.json` declares the catalog-pinned Wrangler executable used to deploy that workspace.
2. `pnpm-lock.yaml` records the direct workspace dependency without changing the catalog version.
3. `.github/workflows/deploy-www.yml` invokes the marketing workspace's pinned binary to upload `apps/www/dist`.
4. `.github/workflows/provision-www.yml` invokes the same pinned binary to create the Pages project.
5. `scripts/quality/deployment-workflow-hardening.test.ts` rejects regression to registry-dependent `npx wrangler` in either marketing workflow and verifies the dependency owner.

## Implementation checklist

- [x] Add catalog-pinned Wrangler to the marketing workspace's development dependencies.
- [x] Update the dependency evidence record for the new direct workspace dependency.
- [x] Replace `npx wrangler` in the marketing deployment workflow with the marketing workspace's pinned executable.
- [x] Replace `npx wrangler` in the marketing provisioning workflow with the same pinned executable.
- [x] Add deterministic workflow contract tests covering dependency ownership, deployment, provisioning, and rejection of `npx wrangler`.
- [x] Make Pages project provisioning skip only an existing project and fail on list/create/JSON errors.
- [x] Reproduce the exact CLI resolution path after a frozen clean install.
- [x] Run the complete repository quality suite and specialist reviews.
- [ ] Confirm the final candidate passes CI and the marketing Pages workflow deploys successfully.

## Acceptance criteria

- [x] A frozen pnpm install exposes Wrangler 4.118.0 through `@simple-agent-manager/www` without registry fallback.
- [x] Both marketing workflows use the marketing workspace's pinned Wrangler executable.
- [x] Neither marketing workflow contains an `npx wrangler` invocation.
- [x] Workflow contract tests fail if either invocation regresses to unpinned resolution or the direct dependency is removed.
- [x] Existing marketing project naming, build output, Cloudflare credentials, permissions, and deployment flags remain unchanged.
- [x] Pages provisioning fails closed for list, response-shape, authentication, network, CLI, and create errors.
- [ ] The production marketing workflow succeeds and `https://www.simple-agent-manager.org/` serves the merged commit's deployment.

## Post-mortem

### What broke

Cloudflare Pages publishing stopped after the marketing build because the workflow could no longer resolve the Wrangler executable.

### Root cause

The workflow relied on `npx` registry fallback instead of declaring and invoking a repository-owned executable. A dependency-graph change in PR #1784 made npm detect a transitive Wrangler that pnpm did not link at the root, exposing the hidden assumption.

### Class of bug

Package-manager executable-resolution ambiguity in a post-merge deployment workflow.

### Why it was not caught

PR validation covered the updated staging preflight but did not enforce the same pinned-Wrangler contract across the separate marketing workflows. The marketing deployment runs after merge and was not a required PR check.

### Process fix

Extend `scripts/quality/deployment-workflow-hardening.test.ts` so both marketing workflows must use the directly declared, catalog-pinned marketing workspace executable and may not use `npx wrangler`.

## Validation evidence

- Test-first contract failed against the pre-fix workflow and passed 9/9 after implementation.
- An offline frozen install resolved `@simple-agent-manager/www` Wrangler 4.118.0 without registry access.
- Full local gates passed: 13/13 lint tasks, 19/19 type/build tasks, 21/21 test tasks, 9/9 builds, and 32 quality files with 297 tests.
- Task completion, Cloudflare, test, constitution, and documentation reviewers are PASS or ADDRESSED with no unresolved blocking finding.
- The exact branch head `47774d3deb5a4f12789211c263ccdca812a29d53` completed the live `Deploy Marketing Site` workflow: https://github.com/raphaeltm/simple-agent-manager/actions/runs/31488280296
- Wrangler 4.118.0 uploaded 153 files and produced `https://fbc054e7.sam-www.pages.dev/` plus branch alias `https://sam-looks-merged-couple-prs.sam-www.pages.dev/`; both returned HTTP 200.

## References

- `.github/workflows/deploy-www.yml`
- `.github/workflows/provision-www.yml`
- `apps/www/package.json`
- `scripts/quality/deployment-workflow-hardening.test.ts`
- `scripts/quality/direct-dependency-evidence.json`
- `tasks/archive/2026-04-25-upgrade-wrangler-v4.md`
- `.claude/rules/22-infrastructure-merge-gate.md`
- `.claude/rules/30-never-ship-broken-features.md`
