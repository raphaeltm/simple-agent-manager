# P5-01: Backfill Missing Architecture Decision Records

**Phase**: 5 (Architecture Documentation)
**Priority**: P1
**Risk Level**: Low — documentation only
**Effort**: M (1-2 days)
**Source Findings**: Track 8 (Architecture Debt — ADR Gaps)
**Recommended Skill(s)**: General

## Scope

The evaluation identified 6 architectural decisions that lack formal ADRs despite being load-bearing in the codebase. Backfill ADRs for each, documenting the decision, context, alternatives considered, and consequences.

Missing ADRs:
1. **Hybrid D1 + Durable Object storage** — why per-project DOs instead of all-D1 (partially covered by ADR-004, needs expansion)
2. **ProjectData DO as single-DO-per-project** — why one DO holds 15+ tables instead of domain-split DOs
3. **MCP tool surface design** — why 84+ tools in a monolithic registry, tool naming conventions
4. **Warm node pooling** — why warm-then-destroy instead of immediate destroy or persistent pools
5. **Cloud-init vs image-based provisioning** — why cloud-init templates instead of pre-baked VM images
6. **ACP session lifecycle in DO vs VM agent** — why session state moved from VM agent in-memory to DO SQLite (spec 027)

## Files Likely Touched

- `docs/adr/005-single-do-per-project.md` (new)
- `docs/adr/006-mcp-tool-surface.md` (new)
- `docs/adr/007-warm-node-pooling.md` (new)
- `docs/adr/008-cloud-init-provisioning.md` (new)
- `docs/adr/009-acp-session-do-ownership.md` (new)
- `docs/adr/004-hybrid-d1-do-storage.md` (update — expand context)

## Compatibility Constraints

- Documentation only — no runtime changes
- ADR format must follow existing `docs/adr/` conventions
- Each ADR must cite specific code paths that implement the decision

## Automated Tests to Add/Run

- None (documentation only)
- Verify markdown lint passes: `pnpm lint`

## Manual Staging Verification

- N/A — documentation only

## Expected Post-Deploy State

- 5 new ADR files in `docs/adr/`
- 1 updated ADR file
- No runtime changes

## Visible Behavior Changes

- None

## Rollback Notes

- Revert documentation files. No runtime impact.

## Acceptance Criteria

- [ ] 5 new ADR files created following existing format
- [ ] ADR-004 expanded with additional context
- [ ] Each ADR cites specific code paths implementing the decision
- [ ] Each ADR documents alternatives considered and why they were rejected
- [ ] `pnpm lint` passes

## Links

- Track report: `tracks/08-architecture-debt.md` (Section: Missing ADRs)
- Existing ADRs: `docs/adr/`
