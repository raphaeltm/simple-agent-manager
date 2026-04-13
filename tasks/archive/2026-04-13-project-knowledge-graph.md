# Project Knowledge Graph — Persistent Agent Memory via MCP

## Problem Statement

Agents operating across sessions in a project have no shared memory. Each new session starts from scratch, unaware of user preferences, coding style, workflow habits, or project conventions learned in prior sessions. The Knowledge Graph provides per-project structured memory that agents build incrementally through MCP tools, with a UI for users to browse, edit, and manage learned facts.

## Research Findings

### Key Files & Patterns

**MCP Tool Pattern:**
- Handler functions in `apps/api/src/routes/mcp/<domain>-tools.ts` with signature `(requestId, params, tokenData, env) => Promise<JsonRpcResponse>`
- Schema definitions in `apps/api/src/routes/mcp/tool-definitions-<domain>.ts`
- Dispatch in `apps/api/src/routes/mcp/index.ts` switch statement
- All tools exported via `tool-definitions.ts` `MCP_TOOLS` array
- Validation: type checks + `sanitizeUserInput()` + `getMcpLimits(env)`
- Responses: `jsonRpcSuccess(requestId, { content: [{ type: 'text', text: JSON.stringify(...) }] })`

**ProjectData DO Pattern:**
- Service modules in `apps/api/src/durable-objects/project-data/<domain>.ts` with direct `SqlStorage` access
- Row validation via Valibot schemas in `row-schemas.ts` — every SELECT result parsed
- DO methods in `index.ts` delegate to service modules, add side effects (broadcast, alarms)
- Service wrapper in `apps/api/src/services/project-data.ts` — `getStub()` → `stub.method()`
- Current migration count: **15** (next = 016)
- FTS5 pattern: virtual table with `content=` pointing to source table, `content_rowid=rowid`, search via MATCH + rank ordering

**REST API Pattern:**
- Mounted at `/api/projects/:projectId/<resource>` in `apps/api/src/index.ts`
- Auth middleware at subrouter level
- Routes call service wrapper → DO RPC

**UI Pattern:**
- Nav items in `PROJECT_NAV_ITEMS` array in `NavSidebar.tsx`
- Routes nested under `/projects/:id` in `App.tsx`
- Pages use `useProjectContext()`, `useState`, `useCallback` for data loading
- API functions in `apps/web/src/lib/api/<domain>.ts`
- Responsive with `useIsMobile()` hook

### Relevant Post-Mortem Lessons
- **Scaleway failure**: Every UI input must reach the backend — verify complete data path
- **Missing initial prompt**: Write capability tests that cross system boundaries
- **Duplicate controls**: Search for existing controls before adding new ones

## Implementation Checklist

### Phase 1: Data Model + MCP Tools

- [x]1.1 Add shared types in `packages/shared/src/types/knowledge.ts`
  - `KnowledgeEntity`, `KnowledgeObservation`, `KnowledgeRelation` types
  - Request/response types for all operations
  - Constants: `KNOWLEDGE_ENTITY_TYPES`, `KNOWLEDGE_SOURCE_TYPES`, `KNOWLEDGE_RELATION_TYPES`
  - Configurable defaults: `KNOWLEDGE_DEFAULTS`
- [x]1.2 Export shared types from `packages/shared/src/types/index.ts`
- [x]1.3 Add migration 016 in `apps/api/src/durable-objects/project-data/migrations.ts`
  - `knowledge_entities` table
  - `knowledge_observations` table with FTS5 triggers
  - `knowledge_relations` table
  - `knowledge_observations_fts` FTS5 virtual table
  - Indexes on entity_type, entity_id, source_type, is_active
- [x]1.4 Add Valibot row schemas in `row-schemas.ts`
  - `KnowledgeEntityRowSchema`, `KnowledgeObservationRowSchema`, `KnowledgeRelationRowSchema`
  - Parser functions: `parseKnowledgeEntityRow()`, etc.
- [x]1.5 Create DO service module `apps/api/src/durable-objects/project-data/knowledge.ts`
  - `createEntity()`, `getEntity()`, `listEntities()`, `updateEntity()`, `deleteEntity()`
  - `addObservation()`, `updateObservation()`, `removeObservation()`, `confirmObservation()`
  - `searchObservations()` — FTS5 MATCH with LIKE fallback
  - `getRelevantKnowledge()` — FTS5 + recency/confidence weighting
  - `createRelation()`, `getRelated()`, `flagContradiction()`
- [x]1.6 Add DO methods in `project-data/index.ts`
  - Delegate to knowledge service module
  - Broadcast events on mutations
- [x]1.7 Add service wrapper methods in `apps/api/src/services/project-data.ts`
- [x]1.8 Add configurable limits to `_helpers.ts` `getMcpLimits()`
  - `KNOWLEDGE_MAX_ENTITIES_PER_PROJECT` (default: 500)
  - `KNOWLEDGE_MAX_OBSERVATIONS_PER_ENTITY` (default: 100)
  - `KNOWLEDGE_SEARCH_LIMIT` (default: 20)
  - `KNOWLEDGE_AUTO_RETRIEVE_LIMIT` (default: 20)
  - `KNOWLEDGE_OBSERVATION_MAX_LENGTH` (default: 1000)
  - `KNOWLEDGE_ENTITY_NAME_MAX_LENGTH` (default: 200)
- [x]1.9 Create MCP tool handlers in `apps/api/src/routes/mcp/knowledge-tools.ts`
  - `handleAddKnowledge`, `handleUpdateKnowledge`, `handleRemoveKnowledge`
  - `handleGetKnowledge`, `handleSearchKnowledge`
  - `handleGetProjectKnowledge`, `handleGetRelevantKnowledge`
  - `handleRelateKnowledge`, `handleGetRelated`
  - `handleConfirmKnowledge`, `handleFlagContradiction`
- [x]1.10 Create tool definitions in `apps/api/src/routes/mcp/tool-definitions-knowledge-tools.ts`
- [x]1.11 Register tools in `tool-definitions.ts` MCP_TOOLS array
- [x]1.12 Add switch cases in `apps/api/src/routes/mcp/index.ts`
- [x]1.13 Write capability tests for MCP knowledge tools

### Phase 2: Agent Integration

- [x]2.1 Add knowledge system prompt injection
  - When agent session starts, inject guidance about knowledge tools
  - Located in agent prompt construction (check existing system prompt injection patterns)
- [x]2.2 Implement auto-retrieval of relevant knowledge on session start
  - Call `getRelevantKnowledge()` with task description/initial prompt as context
  - Inject top-N observations into system prompt

### Phase 3: UI — Knowledge Browser

- [x]3.1 Add REST API routes for knowledge CRUD
  - `GET /api/projects/:projectId/knowledge` — list entities
  - `GET /api/projects/:projectId/knowledge/:entityId` — get entity with observations
  - `POST /api/projects/:projectId/knowledge` — create entity
  - `PATCH /api/projects/:projectId/knowledge/:entityId` — update entity
  - `DELETE /api/projects/:projectId/knowledge/:entityId` — delete entity
  - `POST /api/projects/:projectId/knowledge/:entityId/observations` — add observation
  - `PATCH /api/projects/:projectId/knowledge/observations/:observationId` — update observation
  - `DELETE /api/projects/:projectId/knowledge/observations/:observationId` — delete observation
  - `GET /api/projects/:projectId/knowledge/search?q=` — search
- [x]3.2 Add API client functions in `apps/web/src/lib/api/knowledge.ts`
- [x]3.3 Add "Knowledge" nav item to `PROJECT_NAV_ITEMS` in `NavSidebar.tsx` (Brain icon)
- [x]3.4 Add route in `App.tsx`: `<Route path="knowledge" element={<KnowledgePage />} />`
- [x]3.5 Build `KnowledgePage` component
  - Entity list with search + entity type filter chips
  - Entity detail panel (slide-over on mobile, side panel on desktop)
  - Observation list with confidence indicators, source badges
  - Entity CRUD, observation inline editing
  - Empty state, loading state, error state
- [x]3.6 Mobile responsive layout
- [x]3.7 Playwright visual audit (mobile 375px + desktop 1280px, diverse mock data)

### Quality

- [x]Q.1 All configurable values use env vars with defaults (Constitution Principle XI)
- [x]Q.2 No files exceed 500 lines (rule 18)
- [x]Q.3 Documentation updated (CLAUDE.md recent changes)
- [x]Q.4 Lint + typecheck + test pass

## Acceptance Criteria

1. Agents can add, update, remove, search, and retrieve knowledge via 11 MCP tools
2. Knowledge persists across agent sessions within a project
3. FTS5 search returns relevant observations ranked by relevance
4. Knowledge entities support relations and contradiction flagging
5. Agent sessions receive relevant knowledge context automatically on start
6. Users can browse all knowledge entities in the UI at `/projects/:id/knowledge`
7. Users can create, edit, and delete entities and observations through the UI
8. Users can search and filter knowledge by entity type
9. UI is responsive (works on 375px mobile and 1280px desktop)
10. All limits are configurable via environment variables

## References

- Idea: `01KP39RP4TTVHR16HHP5YYK9HD` (full design)
- Pattern: `apps/api/src/routes/mcp/idea-tools.ts`
- Pattern: `apps/api/src/durable-objects/project-data/ideas.ts`
- Pattern: `apps/web/src/pages/IdeasPage.tsx`
