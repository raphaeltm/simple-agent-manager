# P1-04: Update Constitution & File-Size Enforcement Alignment

**Phase**: 1 (Low-Risk Documentation & Scaffolding)
**Priority**: P1
**Risk Level**: Low — documentation/config only
**Effort**: S (2-4 hours)
**Source Findings**: F-024 (Track 8: Architecture & Debt)
**Recommended Skill(s)**: `$constitution-validator`

## Scope

Constitution Principle IV specifies 400-line file limit; enforced rule uses 500/800. This packet resolves the drift by either amending the constitution to match enforcement or tightening enforcement to match the constitution. The evaluation recommends amending the constitution since 400 lines is aspirational for the current codebase scale.

## Files Likely Touched

- `.specify/memory/constitution.md` — amend Principle IV file/function size limits
- `.claude/rules/18-file-size-limits.md` — ensure consistency with constitution
- Possibly quality scripts if thresholds need updating

## Compatibility Constraints

- Must decide: is the real rule 400, 500, or 800 lines?
- Constitution, rule files, and CI checks must all agree after this change
- Recommendation: amend constitution to 500 (warning) / 800 (mandatory) to match enforced reality

## Automated Tests to Add/Run

- Run `pnpm quality:file-sizes` (if it exists) to verify consistency
- Manual: Verify constitution text matches rule 18 text matches CI script thresholds

## Manual Staging Verification

- N/A — documentation only

## Expected Current Staging State Dependency

- None

## Expected Post-Deploy State

- Constitution, rule files, and CI enforcement agree on file-size thresholds
- No more documented drift between constitutional law and operational enforcement

## Visible Behavior Changes

- None to end users
- Clear, unambiguous file-size guidance for agents and contributors

## Rollback Notes

- Revert the commit(s). Pure documentation — no state to clean up.

## Acceptance Criteria

- [ ] Constitution Principle IV, rule 18, and any CI scripts agree on thresholds
- [ ] Decision documented: which threshold is authoritative and why
- [ ] `$constitution-validator` confirms compliance

## Links

- Track report: `tracks/08-architecture-debt.md` (FINDING-8B1)
- Finding: F-024 in `findings-index.md`
- Related: `implementation-backlog.md` Wave 5, Task 5B
