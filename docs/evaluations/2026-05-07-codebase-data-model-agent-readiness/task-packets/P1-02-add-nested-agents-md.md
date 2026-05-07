# P1-02: Add Nested AGENTS.md Files

**Phase**: 1 (Low-Risk Documentation & Scaffolding)
**Priority**: P1
**Risk Level**: Low — documentation only, no runtime changes
**Effort**: M (1-2 days)
**Source Findings**: F-025 (Track 9: Agent Readiness)
**Recommended Skill(s)**: `$doc-sync-validator`

## Scope

9 of 12 packages lack local `AGENTS.md` files, forcing agents to load broad root context for all work. This packet adds nested instructions for high-traffic packages so agents working in a specific package get relevant local context without loading the full root instructions.

## Files Likely Touched

- `apps/api/AGENTS.md` (new)
- `apps/web/AGENTS.md` (new)
- `apps/www/AGENTS.md` (new)
- `packages/vm-agent/AGENTS.md` (new)
- `packages/ui/AGENTS.md` (new)
- `packages/providers/AGENTS.md` (new)
- `packages/shared/AGENTS.md` (new)
- `packages/cloud-init/AGENTS.md` (new)
- `packages/terminal/AGENTS.md` (new)
- Root `AGENTS.md` — update to explain precedence and link to nested files

## Compatibility Constraints

- Each nested file must be self-contained for agents working in that package
- Root AGENTS.md must explain precedence (local overrides root where applicable)
- No contradictions between root and nested instructions

## Automated Tests to Add/Run

- Manual: Verify each nested file includes local commands, owned paths, verification commands, and local gotchas
- Manual: Spot-check that referenced local commands exist and work

## Manual Staging Verification

- N/A — documentation only

## Expected Current Staging State Dependency

- None

## Expected Post-Deploy State

- Agents working in specific packages load relevant local context
- Root AGENTS.md documents precedence

## Visible Behavior Changes

- None to end users
- Agents get better-targeted instructions per package

## Rollback Notes

- Revert the commit(s). Pure documentation — no state to clean up.

## Acceptance Criteria

- [ ] Nested AGENTS.md exists for: `apps/api`, `apps/web`, `apps/www`, `packages/vm-agent`, `packages/ui`, `packages/providers`, `packages/shared`, `packages/cloud-init`, `packages/terminal`
- [ ] Each file includes: local commands, owned paths, verification commands, local gotchas
- [ ] Root AGENTS.md explains precedence and links to nested files
- [ ] `$doc-sync-validator` confirms consistency

## Links

- Track report: `tracks/09-agent-readiness.md` (Section: Nested AGENTS.md Plan)
- Finding: F-025 in `findings-index.md`
- Related: `implementation-backlog.md` Wave 2, Task 2B
