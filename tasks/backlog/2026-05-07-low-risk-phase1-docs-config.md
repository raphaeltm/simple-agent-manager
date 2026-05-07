# Low-Risk Phase 1: Documentation/Config Recommendations

**Status**: Backlog
**Source**: 2026-05-07 evaluation, findings F-005, F-025, F-028, F-024
**Priority**: P1
**Branch**: sam/implement-low-risk-phase-01kr0f (PR #925)

## Problem

The 2026-05-07 codebase evaluation identified four low-risk documentation/config improvements. Two (F-005, F-025) are already implemented in PR #925. Two remain: F-028 (missing `.claude/settings.json`) and F-024 (constitution vs enforced file-size limit drift).

## Research Findings

### F-005 / F-025 (already in PR #925)
- AGENTS.md reduced from 410 to 87 lines
- CLAUDE.md reduced from 293 to 246 lines
- 8 new nested AGENTS.md files added (all 11 packages now covered)
- All acceptance criteria met per task file

### F-028: Missing `.claude/settings.json`
- No `.claude/settings.json` exists in the repo
- Agents must manually approve common commands (pnpm, gh, git, etc.)
- Evaluation recommends allow-list for safe commands, avoiding destructive ones
- Must NOT include overbroad permissions (no rm -rf, no force push, etc.)

### F-024: Constitution File-Size Limit Drift
- Constitution Principle IV: "files under 400 lines"
- Rule 18: 500-line warning, 800-line mandatory split
- Quality script (`check-file-sizes.ts`): HARD_LIMIT=800, WARN_LIMIT=500
- 107 files exceed 400 lines, 61 exceed 500, 10 exceed 800
- Evaluation recommends amending constitution to match enforced 500/800
- Decision: smallest compatible change — amend constitution Principle IV

## Implementation Checklist

- [ ] Verify F-005 implementation (instruction budget reduction)
- [ ] Verify F-025 implementation (nested AGENTS.md files)
- [ ] F-028: Create `.claude/settings.json` with minimal safe permissions
- [ ] F-024: Amend constitution Principle IV file-size limits to match enforced 500/800
- [ ] Update task file and PR description

## Acceptance Criteria

- [ ] F-005 and F-025 verified as complete
- [ ] `.claude/settings.json` exists with documented, non-overbroad permissions
- [ ] Constitution Principle IV file-size limit matches enforced thresholds
- [ ] No runtime code changes
- [ ] All changes pushed to PR #925 branch (NOT merged)
