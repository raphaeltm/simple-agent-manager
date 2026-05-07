# P1-01: Reduce Always-Loaded Instruction Budget

**Phase**: 1 (Low-Risk Documentation & Scaffolding)
**Priority**: P0
**Risk Level**: Low — documentation only, no runtime changes
**Effort**: M (1-2 days)
**Source Findings**: F-005 (Track 9: Agent Readiness)
**Recommended Skill(s)**: `$doc-sync-validator`

## Scope

Root instruction files (`AGENTS.md`, `CLAUDE.md`, `.claude/rules/`) consume ~4,041 lines (~28,000 tokens) of agent context on every session. This packet consolidates duplicates, moves specialized content into skills or focused guides, and reduces the always-loaded budget by at least 30%.

## Files Likely Touched

- `AGENTS.md` — consolidate and trim
- `CLAUDE.md` — prune "Recent Changes" section (archive older entries)
- `.claude/rules/*.md` — merge overlapping rules (e.g., rules 13, 30, 33 overlap on staging verification)
- Possibly new files in `.agents/skills/` for extracted specialized content

## Compatibility Constraints

- No hard rule may be removed without a replacement source of truth
- All behavioral requirements must be preserved — only redundancy is eliminated
- Agent behavior should not change, only context efficiency improves

## Automated Tests to Add/Run

- Manual: Measure before/after line count and approximate token count
- Manual: `$doc-sync-validator` review to confirm no rules were lost

## Manual Staging Verification

- N/A — documentation only

## Expected Current Staging State Dependency

- None

## Expected Post-Deploy State

- Agent sessions use ~30% fewer context tokens on instruction loading
- All previously documented rules still accessible (some moved to skills/guides)

## Visible Behavior Changes

- None to end users
- Agents have more context window available for actual work

## Rollback Notes

- Revert the commit(s). Pure documentation change — no migration or state to clean up.

## Acceptance Criteria

- [ ] Duplicate root instructions are consolidated (no rule appears in two places)
- [ ] Specialized content moves into skills or focused guides (e.g., staging verification details into one canonical location)
- [ ] CLAUDE.md "Recent Changes" pruned — keep only last ~10 entries, archive rest
- [ ] A measured before/after line count and approximate token count is documented in commit message or PR description
- [ ] No hard rule is removed without a replacement source of truth
- [ ] `$doc-sync-validator` confirms all behavioral rules are still reachable

## Links

- Track report: `tracks/09-agent-readiness.md` (Section: HIGH — Instruction Budget)
- Finding: F-005 in `findings-index.md`
- Related: `implementation-backlog.md` Wave 2, Task 2A
