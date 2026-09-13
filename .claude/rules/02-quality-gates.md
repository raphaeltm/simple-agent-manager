# Quality Gates

Keep this root rule compact. The full historical quality-gate text is preserved at `.agent-instructions/reference/rules/02-quality-gates-full.md`; load it only when a task needs the detailed checklist or incident rationale.

## Always Validate Before Completion

- Re-read the user request and confirm the delivered work satisfies every requested item.
- Validate blockers with direct evidence and try the documented recovery path before stopping.
- Run relevant local checks and inspect failures before claiming success.
- Bug fixes need regression coverage that would have caught the broken invariant.
- Cross-boundary features need a capability or vertical-slice test that exercises the real data path.
- Source-string tests are only valid for static structure; interactive behavior needs rendered behavioral tests.
- Report test totals and collection status, not only assertion failures.

## Merge Gates

- Task-driven PRs require local specialist review, including task-completion validation.
- Code PRs require staging deployment and live verification unless the change is documentation-only, config-only, or task-file-only.
- Infrastructure changes require real VM provisioning, heartbeat, access, and cleanup checks.
- After merge, monitor production deploy and alert the user immediately if it fails.

## Scoped Details

- Staging procedure: `.claude/rules/13-staging-verification.md`
- Visual UI audit: `apps/web/.claude/rules/17-ui-visual-testing.md` and package-scoped copies
- Cross-boundary tests: `.claude/rules/23-cross-boundary-contract-tests.md` and `.claude/rules/35-vertical-slice-testing.md`
- Data migrations: `apps/api/.claude/rules/31-migration-safety.md`
- VM/cloud-init infrastructure: `.claude/rules/22-infrastructure-merge-gate.md` plus package-scoped VM/cloud-init rules
