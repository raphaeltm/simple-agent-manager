# Staging Test After PR Push

## Problem

The current quality gates only require staging verification for UX changes. All other code changes (API logic, business rules, infrastructure) skip staging testing entirely. This means bugs in backend logic, API routes, or cross-component flows can be merged without ever being tested against real Cloudflare infrastructure (D1, KV, DOs, DNS).

The `do` skill workflow also has no staging testing phase, so autonomous agents never deploy and test on staging.

## What Needs to Change

1. **Expand staging verification scope** in `.claude/rules/02-quality-gates.md` — require staging testing for ALL code changes, not just UX
2. **Add a staging testing phase** to the `do` skill workflow in `.codex/prompts/do.md`
3. **Add staging verification checkbox** to `.github/pull_request_template.md`

## Research Findings

- **Rule 02** (`02-quality-gates.md`): Lines 146-182 define "Pre-Merge Staging Verification" scoped only to UX changes
- **`do` skill** (`.codex/prompts/do.md`): 6-phase workflow with no staging phase; goes directly from review to PR creation
- **PR template** (`.github/pull_request_template.md`): No staging verification checkbox
- **Existing staging deploy method**: `pnpm deploy:setup --environment staging` or GitHub Actions
- **Test credentials**: `/workspaces/.tmp/secure/demo-credentials.md`
- **Live app URL**: `app.simple-agent-manager.org`

## Checklist

- [ ] Update `.claude/rules/02-quality-gates.md` — broaden staging verification from UX-only to all code changes
- [ ] Update `.codex/prompts/do.md` — add Phase 5.5 (Staging Verification) between Review and PR phases
- [ ] Update `.github/pull_request_template.md` — add staging verification checkbox
- [ ] Verify no other docs reference the old UX-only staging scope

## Acceptance Criteria

- [ ] Quality gates rule requires staging testing for any PR with code changes
- [ ] `do` skill workflow includes explicit staging deploy + test phase
- [ ] PR template includes staging verification checkbox
- [ ] Docs-only PRs are explicitly exempted from staging testing
