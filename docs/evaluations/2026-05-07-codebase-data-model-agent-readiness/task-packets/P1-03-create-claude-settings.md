# P1-03: Create .claude/settings.json

**Phase**: 1 (Low-Risk Documentation & Scaffolding)
**Priority**: P1
**Risk Level**: Low — configuration file, no runtime changes
**Effort**: S (2-4 hours)
**Source Findings**: F-028 (Track 9: Agent Readiness)
**Recommended Skill(s)**: General

## Scope

Permission and hook configuration is not versioned with the repo. This packet creates a minimal `.claude/settings.json` with repo-appropriate permissions and hooks.

## Files Likely Touched

- `.claude/settings.json` (new)
- Possibly `.claude/rules/` — reference the new settings file

## Compatibility Constraints

- Avoid overbroad permissions — only grant what agents actually need
- Document why each hook/permission is included (inline comments or companion doc)

## Automated Tests to Add/Run

- Manual: Verify JSON is valid
- Manual: Review that permissions match actual agent workflow needs

## Manual Staging Verification

- N/A — configuration file only

## Expected Current Staging State Dependency

- None

## Expected Post-Deploy State

- Claude Code agents pick up repo-specific permission and hook settings from version control

## Visible Behavior Changes

- None to end users
- Agents see consistent permission prompts across sessions

## Rollback Notes

- Delete the file. No state to clean up.

## Acceptance Criteria

- [ ] `.claude/settings.json` exists with minimal repo-appropriate settings
- [ ] Each hook/permission entry has documentation (inline or companion) explaining why it's included
- [ ] No overbroad permissions (e.g., no blanket `allow: ["*"]`)
- [ ] JSON validates successfully

## Links

- Track report: `tracks/09-agent-readiness.md`
- Finding: F-028 in `findings-index.md`
- Related: `implementation-backlog.md` Wave 2, Task 2C
