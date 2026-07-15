# Joint PR for CTO Review Remediation PRs

## Problem statement

The prior "Deep CTO codebase review orchestration" session dispatched remediation agents that opened six focused PRs and intentionally left them unmerged. The current task is to combine those PRs into one temporary integration PR, validate the combined result on staging, confirm affected surfaces and core agent message flows still function, merge the joint PR if green, and close the original PRs.

## Research findings

- Parent task `01KXHR1EFYJB1Q2CVAS8500P82` completed and reported six remediation PRs:
  - #1595 Go remediation / race hardening
  - #1596 backend setup/bootstrap token hardening
  - #1597 backend host-header URL hardening
  - #1598 prototype/test route gating
  - #1599 HTML/markdown preview hardening
  - #1600 frontend interaction/accessibility/destructive-action hardening
- Parent session search confirmed #1595, #1596, #1597, and #1599 were reported green and unmerged. Parent task completion evidence also lists #1598 and #1600 as green and unmerged.
- The current task explicitly authorizes merging after successful joint validation, superseding the prior do-not-merge constraint for the individual remediation PRs.
- Staging validation must use the smoke-token browser auth path and should verify both changed surfaces and the core flows for submitting messages to claude/codex/opencode agents.

## Checklist

- [ ] Inspect current GitHub state for PRs #1595-#1600, including branch names, draft state, mergeability, changed files, and CI.
- [ ] Create a joint branch from current `main`.
- [ ] Merge the six PR branches into the joint branch, resolving conflicts deliberately.
- [ ] Run local validation appropriate to affected files.
- [ ] Open a temporary joint PR with source PR references and validation plan.
- [ ] Wait for CI and fix any failures.
- [ ] Deploy the joint PR branch to staging.
- [ ] Validate all affected surfaces from the six PRs.
- [ ] Validate core message submission flows for claude, codex, and opencode agents.
- [ ] Merge the joint PR if CI and staging validation are green.
- [ ] Close the original PRs #1595-#1600 with a comment referencing the merged joint PR.
- [ ] Monitor production deployment after merge and report the result.

## Acceptance criteria

- A joint PR exists and contains the combined changes from #1595-#1600.
- CI is green on the joint PR.
- Staging deployment succeeds for the joint branch.
- Staging verification confirms affected surfaces still function.
- Staging verification confirms claude, codex, and opencode agent message submission flows still work.
- The joint PR is merged only after green CI and successful staging validation.
- Original PRs #1595-#1600 are closed after the joint PR is merged.
- Production deployment after merge is monitored to success or a concrete failure is reported immediately.

## References

- Parent task: `01KXHR1EFYJB1Q2CVAS8500P82`
- Parent session: `c11121d9-9bda-447a-9b48-8e06068c9313`
- Current SAM output branch: `sam/use-sam-mcp-tools-bz4e69`
