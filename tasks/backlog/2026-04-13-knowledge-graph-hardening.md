# Knowledge Graph Hardening — Post-Merge Review Findings

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
