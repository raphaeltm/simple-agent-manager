# Add MCP Skill Management Tools

## Problem

SAM has HTTP API routes and services for project skills, but agents using the SAM MCP server cannot directly list, inspect, create, update, or delete skills. That forces agents to work around the product surface instead of using the same project-scoped automation layer used for profiles, triggers, tasks, policies, and knowledge.

## Research Findings

- `apps/api/src/routes/skills.ts` exposes authenticated project-scoped CRUD for skills over HTTP.
- `apps/api/src/services/skills.ts` already implements `listSkills`, `getSkill`, `createSkill`, `updateSkill`, and `deleteSkill`, including project/user access checks and validation through existing service rules.
- `apps/api/src/schemas/skills.ts` derives skill payload schemas from agent profile schemas plus `resourceRequirementsJson` and `defaultProfileId`.
- `apps/api/src/routes/mcp/profile-tools.ts` is the closest MCP pattern: tool handlers validate arguments, call service-layer functions with `tokenData.projectId` and `tokenData.userId`, log mutations, and return JSON text content.
- `apps/api/src/routes/mcp/tool-definitions-profile-tools.ts` contains reusable schema patterns for profile-like fields.
- `apps/api/src/routes/mcp/index.ts` centrally dispatches MCP `tools/call`; new tools must be registered there and listed through `MCP_TOOLS`.
- `apps/api/tests/unit/routes/mcp-profile-tools.test.ts` covers handler-level behavior for profile MCP tools and can guide skill handler tests.
- `apps/api/tests/unit/routes/skills.test.ts` already verifies the HTTP skill route surface, so MCP tests should focus on MCP argument validation, service invocation, and tool registration.
- `.claude/rules/06-api-patterns.md` requires route errors to use the established Hono/AppError patterns; this change should reuse handler-level JSON-RPC errors.
- `.claude/rules/35-vertical-slice-testing.md` requires realistic boundary tests for cross-boundary features. MCP handler tests should mock D1/service boundaries with complete skill shapes, and registration tests should prove `tools/list` exposes the tools.

## Implementation Checklist

- [ ] Add MCP skill tool definitions for `list_skills`, `get_skill`, `create_skill`, `update_skill`, and `delete_skill`.
- [ ] Add MCP skill handlers that call existing skill service functions using the MCP token project/user scope.
- [ ] Wire the skill tools into `apps/api/src/routes/mcp/index.ts` dispatch and `MCP_TOOLS`.
- [ ] Cover create/update field extraction for all skill/profile override fields, including `resourceRequirementsJson` and `defaultProfileId`.
- [ ] Add focused unit tests for skill MCP handlers covering happy paths, validation errors, not-found/conflict handling, and service call payloads.
- [ ] Add or update MCP registration tests so `tools/list` exposes the new skill tools.
- [ ] Run focused API tests, then broader API validation for the changed package.

## Acceptance Criteria

- Agents can list available project skills via MCP.
- Agents can retrieve full skill details by skill ID via MCP.
- Agents can create project-scoped skills via MCP with the same configurable fields available through the HTTP API.
- Agents can update and delete project-scoped skills via MCP.
- Invalid or missing MCP arguments return JSON-RPC invalid-params errors instead of generic internal failures.
- MCP `tools/list` includes all new skill tool schemas.
- Tests prove the MCP handlers pass the correct project ID, user ID, and payloads to the skill service.

## References

- `apps/api/src/routes/mcp/index.ts`
- `apps/api/src/routes/mcp/profile-tools.ts`
- `apps/api/src/routes/mcp/tool-definitions-profile-tools.ts`
- `apps/api/src/routes/skills.ts`
- `apps/api/src/services/skills.ts`
- `.claude/rules/06-api-patterns.md`
- `.claude/rules/35-vertical-slice-testing.md`
