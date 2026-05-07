# P5-02: Define Plugin Architecture Boundary

**Phase**: 5 (Architecture Documentation)
**Priority**: P1
**Risk Level**: Low — documentation and design only
**Effort**: M (1-2 days)
**Source Findings**: Track 8 (Architecture Debt — Plugin Readiness)
**Recommended Skill(s)**: General

## Scope

The evaluation rated plugin architecture readiness at 2/5. The codebase lacks a defined extension boundary — provider registration is hardcoded, MCP tool registration is monolithic, and there is no documented contract for adding new providers or tool domains without modifying core code.

This packet produces a design document (not implementation) that:
1. Defines the plugin boundary for cloud providers (beyond Hetzner)
2. Defines the plugin boundary for MCP tool domains
3. Documents the registration contract for each extension point
4. Identifies what must change in the codebase to support the boundary (filed as future task packets)

## Files Likely Touched

- `docs/architecture/plugin-boundaries.md` (new)
- `docs/architecture/provider-extension-contract.md` (new)
- `docs/architecture/mcp-tool-extension-contract.md` (new)

## Compatibility Constraints

- Documentation and design only — no runtime changes
- Must account for existing provider abstraction in `packages/providers/`
- Must account for existing MCP tool registration in `apps/api/src/routes/mcp/`

## Automated Tests to Add/Run

- None (documentation only)
- Verify markdown lint passes: `pnpm lint`

## Manual Staging Verification

- N/A — documentation only

## Expected Post-Deploy State

- 3 new architecture design documents
- No runtime changes

## Visible Behavior Changes

- None

## Rollback Notes

- Revert documentation files. No runtime impact.

## Acceptance Criteria

- [ ] Provider extension contract documented with interface requirements
- [ ] MCP tool domain extension contract documented with registration pattern
- [ ] Current gaps identified (what must change to support plugins)
- [ ] Future implementation work filed as backlog tasks
- [ ] `pnpm lint` passes

## Links

- Track report: `tracks/08-architecture-debt.md` (Section: Plugin Architecture Readiness)
- Provider abstraction: `packages/providers/src/`
- MCP tools: `apps/api/src/routes/mcp/`
