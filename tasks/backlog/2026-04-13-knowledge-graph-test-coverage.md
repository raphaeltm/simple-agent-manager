# Knowledge Graph Test Coverage — Post-Merge Gap

**Created**: 2026-04-13
**Source**: Late-arriving test-engineer review on PR #693

## Problem Statement

PR #693 shipped the knowledge graph feature with Playwright visual audits for the UI but near-zero functional test coverage for the backend (DO service, MCP tools, REST routes, row parsers, get_instructions integration). The test engineer estimates ~0% coverage on all backend components.

## Checklist

### CRITICAL — MCP Tool Handler Tests
- [ ] `add_knowledge` — missing params, invalid enum, happy path (entity+observation created)
- [ ] `update_knowledge` — missing params, happy path (superseding observation)
- [ ] `remove_knowledge` / `confirm_knowledge` — missing params, happy path
- [ ] `get_knowledge` — neither name nor ID provided, entity not found, happy path
- [ ] `search_knowledge` — missing query, happy path
- [ ] `get_project_knowledge` / `get_relevant_knowledge` — happy paths
- [ ] `relate_knowledge` — missing params, invalid relationType, source/target not found, happy path
- [ ] `flag_contradiction` — missing params, happy path
- [ ] `get_related` — happy path
- [ ] All 11 tool names in `toContain()` block of `'should return all SAM tools'` test

### CRITICAL — DO Service Module Tests
- [ ] `createEntity` — happy path + max entities limit enforcement
- [ ] `addObservation` — happy path + max observations per entity limit
- [ ] `updateObservation` — creates superseding obs, marks old inactive
- [ ] `removeObservation` — soft delete (is_active = 0)
- [ ] `deleteEntity` — cascades to observations and relations
- [ ] `searchObservations` — FTS5 path + LIKE fallback
- [ ] `getRelevantKnowledge` — confidence x recency scoring + fallback
- [ ] `buildFtsQuery` — multi-word, empty/special-chars return null
- [ ] `createRelation` — fails if source/target missing
- [ ] `flagContradiction` — reduced confidence + self-relation

### HIGH — REST Route Tests
- [ ] `GET /` — entity list with entityType filter
- [ ] `GET /search` — missing `q` returns 400, happy path
- [ ] `GET /:entityId` — 404 on not found, happy path
- [ ] `POST /` — missing name returns 400, invalid entityType returns 400, happy path 201
- [ ] `PATCH /:entityId` — entity not found returns 404
- [ ] `DELETE /:entityId` — happy path
- [ ] `POST /:entityId/observations` — missing content returns 400, happy path 201
- [ ] `PATCH /observations/:observationId` — confidence-only path calls confirm, not update
- [ ] `DELETE /observations/:observationId` — happy path

### HIGH — get_instructions Integration
- [ ] When `getRelevantKnowledge` returns results, response includes `knowledgeContext` + 3-item instructions
- [ ] When `getRelevantKnowledge` returns empty, response omits `knowledgeContext` + 2-item instructions
- [ ] When `getRelevantKnowledge` throws, `get_instructions` still succeeds (error swallowed)

### MEDIUM — Row Parser Tests
- [ ] `parseKnowledgeEntityRow` — valid row, missing id throws, observation_count defaults to 0
- [ ] `parseKnowledgeObservationRow` — valid row, null superseded_by, is_active boolean conversion
- [ ] `parseKnowledgeObservationSearchRow` — includes entityName and entityType
- [ ] `parseKnowledgeRelationRow` — valid row, null description

### MEDIUM — UI Behavioral Tests
- [ ] Click entity card sets selection and loads detail
- [ ] Create form submit calls API and refreshes list
- [ ] Delete button calls API and clears selection
- [ ] Add observation form submits and refreshes detail
- [ ] Filter chips set entityType filter
- [ ] Client-side search filters by name and description

## Acceptance Criteria

- [ ] MCP tool handlers have happy-path + error-path tests for all 11 tools
- [ ] DO service module has functional tests for CRUD, search, limits, and cascading deletes
- [ ] REST routes have request/response tests covering validation and auth
- [ ] `get_instructions` knowledge integration path tested (with/without knowledge, error case)
- [ ] Row parsers tested for field mapping and error handling

## Test File Locations

- MCP tools: `apps/api/tests/unit/routes/mcp.test.ts` (extend existing)
- DO service: `apps/api/tests/workers/project-data-do.test.ts` (extend existing)
- REST routes: `apps/api/tests/unit/routes/knowledge.test.ts` (new file)
- Row parsers: `apps/api/tests/unit/durable-objects/row-schemas.test.ts` (extend existing)
- UI behavioral: `apps/web/tests/unit/pages/knowledge-page.test.tsx` (new file)

## References

- PR #693: https://github.com/raphaeltm/simple-agent-manager/pull/693
- Test engineer review: full report in task output `a15f153ab3a343436`
