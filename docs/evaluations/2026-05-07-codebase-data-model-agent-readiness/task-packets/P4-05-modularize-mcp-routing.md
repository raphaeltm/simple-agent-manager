# P4-05: Modularize MCP Tool Routing

**Phase**: 4 (Performance & Code Organization)
**Priority**: P1
**Risk Level**: Medium — modifies MCP tool dispatch
**Effort**: L (2-3 days)
**Source Findings**: F-020, F-026 (Track 5: Performance, Track 9: Agent Readiness)
**Recommended Skill(s)**: General, `$api-reference`

## Scope

MCP tool routing uses a monolithic switch/map with 84+ tools. Tool handlers should be domain-registered instead of centralized. Also add LIMIT to unbounded `search_ideas` query (F-020). Consider progressive tool discovery so agents see relevant tools for their context.

## Files Likely Touched

- `apps/api/src/routes/mcp/index.ts` — refactor from monolithic switch to domain-grouped registration
- `apps/api/src/routes/mcp/*.ts` — organize by domain
- `apps/api/src/routes/mcp/idea-tools.ts` — add LIMIT to search query (F-020)

## Compatibility Constraints

- Existing tool names must remain backward compatible
- Tool metadata must be discoverable and testable
- MCP protocol compliance must be maintained
- No change to tool input/output schemas

## Automated Tests to Add/Run

- Test: all 84+ tools remain registered and callable
- Test: `search_ideas` with LIMIT returns bounded results
- Test: tool discovery endpoint returns correct metadata
- `pnpm --filter @simple-agent-manager/api test`

## Manual Staging Verification

- Verify MCP tools work via agent sessions on staging
- Verify `search_ideas` returns bounded results

## Expected Post-Deploy State

- Tools organized by domain (session, idea, knowledge, orchestrator, etc.)
- Bounded search results for idea tools
- Tool metadata discoverable per domain

## Visible Behavior Changes

- `search_ideas` may return fewer results for very broad queries (now bounded)

## Rollback Notes

- Revert to monolithic routing. No data migration.

## Acceptance Criteria

- [ ] Tool handlers domain-registered instead of centralized monolithic switch
- [ ] Tool metadata is discoverable and testable
- [ ] Existing tool names remain backward compatible
- [ ] `search_ideas` has configurable LIMIT (default: 50, max: 200)
- [ ] `pnpm --filter @simple-agent-manager/api test` passes

## Links

- Track report: `tracks/05-performance-cost.md` (Unbounded MCP Search)
- Track report: `tracks/09-agent-readiness.md` (MCP Tool Scorecard)
- Findings: F-020, F-026 in `findings-index.md`
- Related: `implementation-backlog.md` Wave 4, Task 4D
