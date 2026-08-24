# Relevance-ranked knowledge injection with per-entity caps and a complete entity index

Recommendation **R3** of the token-optimization program.
Companion idea: `01M0QGZQ15WE9DDQENGV6S9XZ5`.
Research source: library file `/engineering/research/token-optimization-research.md`
(fileId `01M0QGYKH9PCSM5E7N58ZD98JT`), sections 3.2 and 8/R3.

This is a **retry** of failed task `01M0QHJVZE21AE1NX0ZJWVGGD5` (agent became
unresponsive mid-work). Substantial prior work exists on
`sam/sam-knowledge-injection-relevance-wvggd5`; see "Prior work" below.

## Problem

Session-start knowledge injection selects observations with:

```sql
-- apps/api/src/durable-objects/project-data/knowledge.ts:393
WHERE o.is_active = 1 AND o.confidence >= ?
ORDER BY e.name, o.last_confirmed_at DESC
LIMIT ?
```

`ORDER BY e.name` is **alphabetical**. Entity name has no relationship to how useful an
observation is, so the `LIMIT` acts as a filter on spelling rather than on relevance.

In production this means all 50 slots go to entities `AccountMap`..`AgentReliability`,
**46 of them to the single `AgentBehavior` grab-bag entity**. Meanwhile the very same
payload instructs the agent to consult `ContentStyle`, `CodeQuality`, `User`,
`Architecture`, and `BusinessStrategy` before making decisions. Every one of those sorts
after "A". **None has ever been injected.** Worse, nothing in the payload hints they
exist, so an agent has no reason to search for them.

This is a **quality bug as much as a token bug**: the instructions tell the agent to use
knowledge that the same response structurally guarantees it will never see.

## Research findings

| Finding | Location | Consequence for this task |
|---|---|---|
| A confidence×recency scoring path **already exists** | `knowledge.ts` `getRelevantKnowledge` | Reuse this exact formula — do not invent a second one (rules 24, 59) |
| Injection deliberately bypasses it | comment at `instruction-tools.ts:130-134` | Rationale ("keyword-matching misses most relevant knowledge") is valid; ranking-without-keywords preserves that property |
| Retrieval failure is already soft | `instruction-tools.ts:160-165` try/catch → warn + empty | A thrown SQL error degrades to **zero knowledge injected**. New SQL must be verified against a real engine, not assumed |
| No `ROW_NUMBER() OVER` precedent in `apps/api/src` | grep, zero hits | Per-entity cap via window function must be **empirically proven** on real DO SQLite |
| Real DO SQLite harness exists | `apps/api/tests/workers/` (`@cloudflare/vitest-pool-workers`, `runInDurableObject`) | This is the discriminating test venue (rule 28: SQL predicates need a real SQL engine) |
| Mirror-logic DO tests are a local norm | `tests/unit/durable-objects/message-materialization.test.ts` re-implements SQL in JS | Explicitly **rejected** here — rule 62 forbids a test that constructs the condition it should detect |
| Entity index needs a new read | no existing "all entities + active observation count" query | New `getKnowledgeEntityIndex`; count `is_active=1` observations (the set `search_knowledge` can actually reach), not just high-confidence ones |
| **R1 has already merged** | `origin/main` = `69e8d1233` (PR #1891) | `knowledgeContext`/`policyContext` are gone from the *emitted payload* but survive as local vars feeding the formatters. Must not reintroduce them in the response |
| `observationId` absent from payload | pre-existing, never present | Out of scope — tracked in `tasks/backlog/2026-08-23-get-instructions-missing-observation-ids.md` |

### Scoring formula (decided)

Reuse the existing precedent verbatim:

```
score = confidence × 1 / (1 + ageMs / RELEVANCE_RECENCY_SCALE_MS)   // scale = 30 days
```

Hyperbolic decay on the recency of the **last confirmation** (not creation), scaled
linearly by confidence. Recency factor is 1.0 today, 0.5 at 30 days, 0.25 at 90 days.
Confirming an observation restores its rank — which is what makes the confirm/prune loop
meaningful. **No randomness.**

`now` is a bound parameter, never SQLite's `strftime('now')`, so a given `(data, now)`
pair always produces the same ordering.

Deterministic total order, ties broken twice:
`relevance_score DESC, last_confirmed_at DESC, id ASC`.

### Prior work (failed task `01M0QHJVZE21AE1NX0ZJWVGGD5`)

Branch `sam/sam-knowledge-injection-relevance-wvggd5`, based at `b36f2358a` (pre-R1).
1382 insertions; it had already been through one specialist review round. Assessment:
the design is sound and is adopted here, **but it is re-reviewed and re-verified
independently rather than trusted** — in particular the discriminating-test proof is
re-run by this task rather than taken on the prior agent's word (rule 62).

Its only R1-overlapping file is `instruction-tools.ts`; that one is hand-merged.

## Implementation checklist

- [x] Rebase/apply prior work onto post-R1 `origin/main`, file by file, reviewing each
- [x] `packages/shared/src/types/knowledge.ts`: add `autoRetrievePerEntityLimit: 8` and
      `entityIndexLimit: 200` to `KNOWLEDGE_DEFAULTS`
- [x] `knowledge.ts`: extract `RELEVANCE_RECENCY_SCALE_MS` + `computeRelevanceScore` as the
      canonical JS definition; use it in `getRelevantKnowledge`
- [x] `knowledge.ts`: rewrite `getAllHighConfidenceKnowledge` — scored ranking + per-entity
      cap via `ROW_NUMBER() OVER (PARTITION BY entity_id)`; per-row fault isolation (rule 50)
- [x] `knowledge.ts`: add `getKnowledgeEntityIndex` returning `{ entries, totalEntities }`
      so a truncated index can never be labelled "full"
- [x] `durable-objects/project-data/index.ts`: thread `perEntityLimit`; add index RPC
- [x] `services/project-data.ts`: mirror both signatures
- [x] `row-schemas/knowledge.ts`: `parseKnowledgeEntityIndexRow` + barrel export
- [x] `instruction-tools.ts` (**hand-merge with R1**): pass the per-entity limit; fetch the
      index; append a compact index section to `knowledgeDirectives`; do NOT reintroduce
      `knowledgeContext`/`policyContext` in the emitted response
- [x] `instruction-tools.ts`: update `buildKnowledgeInstructions` strings so the injected set
      is described as ranked + capped + partial, and point at the index
- [x] `apps/api/src/env.ts`: document the two new env vars inline
- [x] `.claude/rules/65-capped-selection-must-rank-and-disclose.md`: process fix (rule 02
      requires a process fix in the same PR as a bug fix)
- [x] Tests in `apps/api/tests/workers/` against **real** DO SQLite
- [x] Independently re-verify the ranking test fails against the pre-fix `ORDER BY e.name`

## Test plan (discriminating — rules 28, 62)

All against **real** DO SQLite, driven through the production RPC path (never by
re-implementing the SQL in the test):

1. **Ranking replaces alphabetical** — seed >50 observations across early-alphabet
   (`AaaGrabBag`) and late-alphabet (`ZzzRecent`) entities, where the late-alphabet entity
   holds the most recent high-confidence observations. Assert `ZzzRecent` **injects**.
   *Must FAIL on pre-fix code* — verify once by restoring `ORDER BY e.name`.
2. **Per-entity cap** — one grab-bag entity with far more than the cap; assert no entity
   exceeds `perEntityLimit`, and that freed slots go to other entities.
3. **Cap discrimination control** — raising the cap must let one entity dominate again
   (guards against a test that passes for the wrong reason).
4. **Index completeness** — the index lists **every** active entity, including ones with
   zero injected observations (the ContentStyle/User case).
5. **Index truncation honesty** — when more entities exist than are listed, the payload
   says "N of M", never "full".
6. **Determinism** — identical repeated calls return identical ordering, and the assertion
   must be falsifiable (assert the *specified* tiebreak order, not merely self-agreement).
7. **Degradation** — ranked retrieval failing must still leave the index, and vice versa.

## Acceptance criteria

- [x] Injection order is relevance-ranked, not alphabetical; formula documented in-code
- [x] No single entity can consume more than the configured per-entity cap
- [x] Every active entity appears in the injected index, with an observation count
- [x] Index lead-in tells the agent how to retrieve what was not injected in full
- [x] Both new limits are env-configurable with `DEFAULT_*`-style constants (Principle XI)
- [x] Ranking test independently proven to fail against the pre-fix ordering
- [x] Compatible with R1's deduplicated response shape (no reintroduced arrays)
- [x] Staging: a real `get_instructions` shows ranked selection + full index

## Out of scope

- Rewriting or compressing stored observations (explicitly excluded by the task)
- Adding `observationId` to the payload (backlog task above)

## References

- `.claude/rules/28` — real SQL engine for SQL-predicate guards; owner controls
- `.claude/rules/62` — a test must reach the feature the way production does
- `.claude/rules/50` — list reads tolerate a malformed row
- `.claude/rules/60` — request I/O budget
- `.claude/rules/24`, `.claude/rules/59` — one implementation per operation
- `.claude/rules/03` / Constitution Principle XI — no hardcoded limits
- `.claude/rules/02` — bug fixes ship with a process fix

## Verification evidence (attempt 3)

Discrimination proofs re-run independently rather than trusted from the prior agent
(rule 62). Each guard was removed, the suite run, then restored:

| Guard removed | Tests that went red |
|---|---|
| Ranking → restored `ORDER BY entity_name, last_confirmed_at DESC` | 5 — incl. *injects a recent late-alphabet entity that alphabetical ordering starved*, *ranks by confidence and recency…*, *decays continuously within the first 30 days*, *orders exactly as the canonical JS relevance formula*, *keeps the globally highest-scoring rows when the outer limit truncates* |
| Per-entity cap → `entity_rank <= 999999` | 3 — *caps how many observations any single entity contributes*, *keeps the globally highest-scoring rows…*, *applies DO-side defaults when the optional limits are omitted over RPC* |
| Truncation-honesty fix in `buildKnowledgeInstructions` | 1 — *never tells the agent the index is complete when it is truncated* |

All 14 `tests/workers/knowledge-injection-ranking.test.ts` cases pass against real DO
SQLite; 13 `tests/unit/routes/mcp-instruction-context.test.ts` cases pass.

**Note on the inherited "tests passing" claim**: the workers suite initially failed to
*load* (`Failed to resolve entry for package "@simple-agent-manager/providers"`) because
the build-order prerequisites were not built — reporting `no tests` rather than a failure.
This is the rule-02 "a green test count is not a green suite" trap; the suite only became
meaningful after `shared` → `providers` → `cloud-init` were built.

### Defect found and fixed during review

`buildKnowledgeInstructions` unconditionally told the agent the payload carried a
"Full knowledge index" that "lists every entity". When >`entityIndexLimit` entities exist
the index truncates and both claims are false — the rule-65 defect (a capped selection
described as complete) reintroduced one layer up, in prose. Fixed in `c927eed56`.

## Staging verification (2026-08-24)

Deploy: `deploy-staging.yml` run `32674814563` — **success**.

Exercised the REAL deployed path: seeded the production skew into staging project
`01KTKXZ4ZZAT6MJFXRW1ZTQ7RB` via the knowledge REST API (which writes through the real
ProjectData DO), then called `get_instructions` through the live MCP endpoint
`POST https://api.sammy.party/mcp` with a real MCP token. No mocks anywhere in the path.

Seed: `AaaR3GrabBag` (early alphabet, 20 observations @ conf 0.85) plus `ZzzR3ContentStyle`
/ `ZzzR3UserPrefs` / `ZzzR3Architecture` (late alphabet, 3 each @ conf 0.98) — i.e. exactly
the shape that made the production bug invisible.

Result (verbatim from the live payload):

```
**ZzzR3Architecture** (context): ...3 observations...
**ZzzR3UserPrefs** (preference): ...3 observations...
**ZzzR3ContentStyle** (preference): ...3 observations...
**AaaR3GrabBag** (context): ...observations 20,19,18,17,16,15,14,13...   <- exactly 8 of 20

### Full knowledge index (4 entities)
AaaR3GrabBag (context, 20), ZzzR3Architecture (context, 3),
ZzzR3ContentStyle (preference, 3), ZzzR3UserPrefs (preference, 3)
```

| Acceptance criterion | Evidence |
|---|---|
| Ranked, not alphabetical | All three `Zzz*` entities rank ABOVE `AaaR3GrabBag`. Pre-fix `ORDER BY e.name` guarantees the exact opposite. |
| Per-entity cap enforced | `AaaR3GrabBag` contributed exactly 8 of its 20 observations (default `autoRetrievePerEntityLimit`). |
| Every active entity in the index | All 4 listed with counts; the index discloses `AaaR3GrabBag (context, 20)` while only 8 were shown. |
| Index names the retrieval path | `search_knowledge` and `get_relevant_knowledge` both named in the lead-in. |
| Truncation honesty | 4 <= `entityIndexLimit` (200), so the heading correctly reads "Full knowledge index". |
| Deterministic | 3 identical calls returned byte-identical `knowledgeDirectives`. |
| R1 compatible | Payload keys are exactly `context, instructions, knowledgeDirectives, project, session` — no `knowledgeContext` / `policyContext`. |
| Instruction strings updated | Payload asserts RANKED, CAPPED, "knowledge-index section", "Do not assume an entity is empty", "raises its rank". |

Regression (rule 13): API `/health` 200; `app.sammy.party` 200; `/api/projects`,
`/api/nodes`, `/api/workspaces`, `/api/auth/me`, project-scoped `/tasks`, `/knowledge` all
200; MCP `tools/list` exposes 113 tools. Real-browser pass (Playwright/chromium against
staging, authenticated via `token-login`): dashboard, projects and settings all render,
no horizontal overflow, **0 console errors**. Screenshots in
`.codex/tmp/playwright-screenshots/r3-*.png` (3 distinct files, verified not duplicates).

Cleanup: all 9 seeded entities deleted from both staging projects; both verified back to
their pre-test state.

