# MCP Knowledge/Policy Validation Hardening

## Problem

The public MCP knowledge and policy tool slice needs remediation after a CTO spot check. Knowledge MCP handlers silently clamp or ignore malformed inputs in places where policy handlers mostly reject invalid input, and public route-level tests do not directly cover the JSON-RPC contract for these tools.

This matters because the tools write durable project knowledge and policy. Silent coercion can store incorrect facts, broaden filtered queries, or make agent behavior depend on malformed MCP arguments.

## Research Findings

- `apps/api/src/routes/mcp/knowledge-tools.ts` currently clamps `confidence`, defaults invalid `sourceType` to `inferred`, accepts invalid `entityType` filters, clamps `limit`, forwards arbitrary `relationType` in `get_related`, and truncates update/contradiction content.
- `apps/api/src/routes/mcp/policy-tools.ts` validates mutation paths more explicitly, but `list_policies` silently ignores invalid category filters and clamps pagination values.
- `apps/api/src/routes/mcp/tool-definitions-knowledge-tools.ts` and `tool-definitions-policy-tools.ts` duplicate enum literals that already exist in `@simple-agent-manager/shared`.
- `packages/shared/src/types/knowledge.ts` exports `KNOWLEDGE_ENTITY_TYPES`, `KNOWLEDGE_SOURCE_TYPES`, and `KNOWLEDGE_RELATION_TYPES`.
- `packages/shared/src/types/policy.ts` exports `POLICY_CATEGORIES` and `POLICY_SOURCES`, plus guards used by handlers.
- Existing route tests under `apps/api/tests/unit/routes/mcp*.test.ts` use Hono with mocked KV, D1, and ProjectData Durable Object namespaces and exercise `tools/call` requests through the public `/mcp` route.
- No UI files are in scope; Playwright visual audit is not required unless scope changes.

## Implementation Checklist

- [x] Add explicit knowledge MCP validation helpers for enum values, confidence, max lengths, and page limits.
- [x] Reject invalid `add_knowledge` confidence/sourceType and preserve defaults only when omitted.
- [x] Reject invalid `search_knowledge`, `get_project_knowledge`, `get_relevant_knowledge`, and `get_related` filters/limits instead of broadening or forwarding malformed values.
- [x] Reject over-limit `update_knowledge` and `flag_contradiction` content instead of implicit truncation.
- [x] Tighten policy `list_policies` filter/pagination validation so invalid filters do not silently broaden lists.
- [x] Derive MCP tool-definition enum values from shared constants where practical.
- [x] Add focused public route-level MCP tests for required/missing params, invalid enums, confidence bounds, filter broadening prevention, sanitized success arguments, and schema enum parity with shared constants.
- [ ] Run focused route tests plus policy/knowledge related tests.
- [x] Run apps/api lint and typecheck commands.
- [ ] Complete specialist review required for API/test changes before PR merge.
- [ ] Deploy and verify staging MCP behavior, or document the exact verified blocker if live MCP endpoint exercise is impossible.

## Acceptance Criteria

- Public MCP JSON-RPC handlers return `INVALID_PARAMS` for malformed knowledge/policy arguments listed in the spot-check plan.
- Success paths pass trimmed/sanitized and validated values to ProjectData service calls.
- Public MCP tool definitions expose enum arrays matching shared constants.
- New tests fail against the previous silent-coercion behavior and pass with the remediation.
- Relevant local quality checks pass.
- PR includes specialist review evidence, staging verification evidence, and is merged only after all gates pass.

## References

- `apps/api/src/routes/mcp/knowledge-tools.ts`
- `apps/api/src/routes/mcp/policy-tools.ts`
- `apps/api/src/routes/mcp/tool-definitions-knowledge-tools.ts`
- `apps/api/src/routes/mcp/tool-definitions-policy-tools.ts`
- `apps/api/tests/unit/routes/`
- `apps/api/tests/unit/policy-system.test.ts`
- `apps/api/tests/workers/policy-do.test.ts`
- `.codex/prompts/do.md`
