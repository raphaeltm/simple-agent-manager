# CI/CD Security Hardening

## Problem

Multiple security issues in GitHub Actions workflows:
1. Secrets written to `GITHUB_OUTPUT` without masking (deploy-reusable.yml)
2. Secret expressions expanded directly in shell `if` statements (injection risk)
3. Missing explicit `permissions:` blocks on several workflows (overly broad defaults)
4. No CI concurrency group (wasted compute on superseded runs)
5. Dependabot missing npm and github-actions ecosystems
6. Unnecessary `id-token: write` on claude.yml
7. Go version mismatch: workflows use `1.22` but go.mod requires `1.24`

## Research Findings

### Key Files
- `.github/workflows/deploy-reusable.yml` — lines 246-282 (secret output), line 595 + lines 36-71 (shell expansion)
- `.github/workflows/deploy.yml` — no permissions block
- `.github/workflows/ci.yml` — no permissions block, no concurrency, Go 1.22
- `.github/workflows/teardown.yml` — no permissions block
- `.github/workflows/e2e-smoke.yml` — no permissions block, Go 1.22
- `.github/workflows/claude.yml` — has `id-token: write` at line 25
- `.github/dependabot.yml` — only has devcontainers ecosystem
- `packages/vm-agent/go.mod` — declares `go 1.24.0`
- `deploy-reusable.yml` env var `GO_VERSION: '1.22'` at line 21

### Security Analysis
1. **Secret masking**: Pulumi outputs (encryption_key, jwt keys, CA certs/keys) are written to GITHUB_OUTPUT without `::add-mask::`. If any step echoes these, they appear in logs.
2. **Shell expansion**: `${{ secrets.X }}` in shell `if` conditions is vulnerable to injection if secret values contain shell metacharacters. Best practice: use env vars with boolean checks.
3. **Permissions**: Without explicit permissions, workflows get the repository's default token permissions (often `write` for everything).
4. **Concurrency**: CI runs on every push — without concurrency groups, superseded commits waste compute.
5. **id-token: write**: Only needed for OIDC federation. Claude Code Action doesn't need it.

## Implementation Checklist

- [x] 1. Mask secrets in deploy-reusable.yml before writing to GITHUB_OUTPUT (5 secrets)
- [x] 2. Fix shell expansion of secrets in deploy-reusable.yml (validate step lines 36-71, security keys status line 595)
- [x] 3. Add `permissions: { contents: read }` to ci.yml, deploy.yml, teardown.yml, e2e-smoke.yml
- [x] 4. Add concurrency group to ci.yml
- [x] 5. Add npm and github-actions ecosystems to .github/dependabot.yml
- [x] 6. Remove `id-token: write` from claude.yml
- [x] 7. Update Go version to 1.24 in ci.yml and deploy-reusable.yml

## Acceptance Criteria

- [ ] All 5 Pulumi secret outputs are masked before being written to GITHUB_OUTPUT
- [ ] No `${{ secrets.* }}` expressions appear in shell `if`/`-z`/`-n` conditions
- [ ] All 4 workflows (ci, deploy, teardown, e2e-smoke) have explicit permissions blocks
- [ ] CI has a concurrency group that cancels in-progress runs for the same ref
- [ ] Dependabot monitors npm and github-actions in addition to devcontainers
- [ ] claude.yml does not have id-token: write
- [ ] Go version in CI matches go.mod (1.24)
- [ ] CI passes on the branch (no breaking changes)

## References
- GitHub Actions security hardening: https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions
