# Knowledge Graph Hardening — Post-Merge Review Findings

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - `get_related` validates `relationType` against the allowlist
>     (`apps/api/src/routes/mcp/knowledge-tools.ts:437–443`).
>   - FTS5 operator safety, done differently: `buildSafeFtsQuery` (`apps/api/src/lib/fts5.ts`)
>     strips punctuation and AND/OR/NOT/NEAR instead of quoting tokens, so those words are
>     dropped rather than searched literally.
>   - MCP half of two items: `search_knowledge` rejects `minConfidence` outside 0..1
>     (`knowledge-tools.ts:48–60,296–298`), and `search_knowledge` / `get_project_knowledge`
>     validate `entityType` (`knowledge-tools.ts:289–295,325–331`).
>   - Mitigated: `ensureProjectId` now runs once per isolate (`ensureOncePerIsolate` in
>     `getStubForOwner`, `apps/api/src/services/project-data.ts`); the first call in each
>     isolate still costs two RPCs.
> - **Still open:**
>   - FTS sync, removal and search failures are swallowed with no log
>     (`apps/api/src/durable-objects/project-data/knowledge.ts:383,726,740`).
>   - Observation routes are still `/observations/:observationId`
>     (`apps/api/src/routes/knowledge.ts:302,353`).
>   - `flagContradiction` still writes a self-loop relation (`project-data/knowledge.ts:699–708`).
>   - `KNOWLEDGE_*` defaults are not in `wrangler.toml [vars]`.
>   - No duplicate-relation guard: no UNIQUE constraint (`durable-objects/migrations.ts:722–732`)
>     and no check in `createRelation` (`project-data/knowledge.ts:638–659`).
>   - REST handlers return raw `err.message` (`routes/knowledge.ts:237,296,346,364`).
>   - REST half of two items: search does not clamp `minConfidence` (`routes/knowledge.ts:108`),
>     and list/search do not validate `entityType` (`routes/knowledge.ts:66,106`).
>   - Duplicate `resolveSessionId` (`knowledge-tools.ts:29–34`; the shared one is
>     `routes/mcp/_helpers.ts:440`).
>   - Hardcoded constants: 30-day recency scale (`project-data/knowledge.ts:40`), fallback
>     minimum confidence 0.5 (`:445`), contradiction penalty 0.8 (`:696`).
>   - `getLimit` uses an unsafe cast and accepts negative values (`routes/knowledge.ts:42–45`).
>   - Deleting a missing entity returns success instead of 404
>     (`durable-objects/project-data/index.ts:2792–2795`).
> - **Moot/dropped:** the five unwired `getMcpLimits` fields (`routes/mcp/_helpers.ts:158–162`)
>   moved to `tasks/backlog/2026-03-16-mcp-page-size-limits-not-configurable.md`.

**Created**: 2026-04-13
**Source**: Late-arriving cloudflare-specialist, constitution-validator, and security-auditor reviews on PR #693

## Problem Statement

PR #693 (Project Knowledge Graph) was merged with all Phase 5 reviewers passing. Three additional review agents completed after merge and identified hardening improvements for FTS5 reliability, route safety, data integrity, input validation, and constitution compliance. Note: the Phase 5 security-auditor's CRITICAL (observation ownership JOIN) and HIGH (FTS5 keyword stripping) were already fixed in commit 6e88f2e2 before merge.

## Checklist

### HIGH
- [ ] FTS5 silent-failure recovery: change try/catch around FTS sync to `log.warn` so failures are visible in tail worker; consider adding a `rebuild` path via `do_meta` flag
- [ ] Route fragility: restructure observation routes under `/entities/:entityId/observations/:observationId` to avoid Hono router ambiguity with `/:entityId`
- [ ] `relationType` not validated against `KNOWLEDGE_RELATION_TYPES` allowlist in `handleGetRelated` (MCP) — copy guard from `handleRelateKnowledge`

### MEDIUM
- [ ] `flagContradiction` creates self-referential entity relation (self-loop) — decide if contradiction tracking needs observation-level links or a separate table
- [ ] `buildFtsQuery` should quote tokens (`words.map(w => '"' + w + '"').join(' ')`) to prevent FTS5 operator interpretation of "OR", "NOT", etc.
- [ ] Add `KNOWLEDGE_*` env var defaults to `wrangler.toml [vars]` section for operator visibility
- [ ] `knowledge_relations` table needs UNIQUE constraint on `(source_entity_id, target_entity_id, relation_type)` or duplicate-check in `createRelation`
- [ ] Replace raw `(err as Error).message` passthrough in REST catch blocks with fixed generic messages; log original internally
- [ ] Clamp `minConfidence` to [0, 1] on REST search route and MCP `search_knowledge` handler
- [ ] Remove local `resolveSessionId` from `knowledge-tools.ts` — import shared version from `_helpers.ts`

### LOW
- [ ] Make algorithmic constants configurable: relevance decay half-life (30 days), fallback min confidence (0.5), contradiction confidence penalty (0.8)
- [ ] Replace `getLimit` unsafe cast in REST routes with typed env access; protect against negative values
- [ ] Consolidate `ensureProjectId` + `getRelevantKnowledge` into single DO method to reduce cold-start round-trips
- [ ] Pre-existing: 5 task/session limits in `getMcpLimits()` (`_helpers.ts:121-125`) missing env var wiring
- [ ] Validate `entityType` on read paths (list + MCP `get_project_knowledge`) against allowlist
- [ ] `deleteKnowledgeEntity` should return 404 when entity doesn't exist instead of silent no-op

## Acceptance Criteria

- [ ] FTS5 sync failures are logged at warn level (not silently swallowed)
- [ ] Observation REST routes are not ambiguous with entity routes
- [ ] No duplicate relations can be created for the same entity pair + relation type
- [ ] FTS5 search handles "OR", "NOT" as literal words, not operators
- [ ] `KNOWLEDGE_*` vars documented in `wrangler.toml`
- [ ] `relationType` validated on read paths
- [ ] Error messages in REST responses do not leak internal IDs or limit values
- [ ] `minConfidence` clamped to [0, 1] on read paths
- [ ] No duplicate `resolveSessionId` implementations

## References

- PR #693: https://github.com/raphaeltm/simple-agent-manager/pull/693
- Cloudflare specialist review: full report in task output `aa47a8b466c965aab`
- Constitution validator review: full report in task output `a59bb35ab786bca12`
- Security auditor review: full report in task output `adbf61ff06ee93711`
