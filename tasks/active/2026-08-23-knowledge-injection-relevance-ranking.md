# Relevance-ranked knowledge injection with per-entity caps and a complete entity index

**Task ID:** 01M0QHJVZE21AE1NX0ZJWVGGD5
**Idea:** 01M0QGZQ15WE9DDQENGV6S9XZ5
**Branch:** `sam/sam-knowledge-injection-relevance-wvggd5`
**Research:** library `/engineering/research/token-optimization-research.md` §3.2, §8/R3

## Problem

`getAllHighConfidenceKnowledge` (`apps/api/src/durable-objects/project-data/knowledge.ts:384`)
selects:

```sql
WHERE o.is_active = 1 AND o.confidence >= ?
ORDER BY e.name, o.last_confirmed_at DESC
LIMIT ?
```

Ordering by `e.name` makes session-start knowledge injection **alphabetical**, not relevant.

Measured in production (this very task's `get_instructions` payload, 166,557 chars): all 50
slots went to the alphabetically-first six entities — AccountMap, AdminAccessControl,
AgentBehavior, AgentOrchestration, AgentProfiles, AgentReliability — with 46/50 consumed by
the `AgentBehavior` grab-bag alone.

Entities that `buildKnowledgeInstructions` **explicitly tells agents to consult** —
ContentStyle, CodeQuality, User, Architecture, BusinessStrategy — sort after "A" and are
therefore **never injected and never even mentioned**. The agent has no way to know they
exist. This is a knowledge-quality bug as much as a token bug: the truncation is silent.

## Research findings

| Finding | Location | Consequence for this task |
|---|---|---|
| A confidence×recency scoring path **already exists** | `knowledge.ts:359` (`getRelevantKnowledge`) | Reuse this exact formula — do not invent a second one (rules 24, 59) |
| Injection deliberately bypasses it | comment at `instruction-tools.ts:130-134` | Rationale ("keyword-matching misses most relevant knowledge") is valid; ranking-without-keywords keeps that property |
| Retrieval failure is already soft | `instruction-tools.ts:160-165` try/catch → warn + empty | A thrown SQL error degrades to **zero knowledge injected**. So new SQL must be verified against a real engine, not assumed |
| No `ROW_NUMBER() OVER` precedent in `apps/api/src` | grep, zero hits | Per-entity cap via window function must be **empirically proven** on real DO SQLite, not assumed |
| Real DO SQLite harness exists | `apps/api/tests/workers/` (`@cloudflare/vitest-pool-workers`, `runInDurableObject`) | This is the discriminating test venue (rule 28: SQL predicates need a real SQL engine) |
| Mirror-logic DO tests are the local norm | `tests/unit/durable-objects/message-materialization.test.ts` re-implements SQL in JS | Explicitly **rejected** for this task — rule 62 forbids a test that constructs the condition it should detect |
| Entity index needs a new read | no existing "all entities + active observation count" query | New `getKnowledgeEntityIndex`; count `is_active=1` observations (the set `search_knowledge` can actually reach), not just high-confidence ones |
| Sibling task R1 not yet on main | `origin/main` = 220b4ce18 | Must not depend on or reintroduce `knowledgeContext`/`policyContext` arrays; rebase before push |

### Scoring formula (decided)

Reuse the existing precedent verbatim (`knowledge.ts:359`):

```
score = confidence × 1 / (1 + ageDays / 30)
```

`ageDays = (now − lastConfirmedAt) / 86_400_000`. Hyperbolic decay: recency factor is 1.0
today, 0.5 at 30 days, 0.25 at 90 days. Confidence scales it linearly. No randomness.
`now` is passed in as a bound parameter (never `strftime('now')`) so results are reproducible.

Deterministic total order — ties broken twice so the result is stable across identical calls:
`relevance_score DESC, last_confirmed_at DESC, id ASC`.

## Implementation checklist

- [ ] `packages/shared/src/types/knowledge.ts`: add `autoRetrievePerEntityLimit: 8` and
      `entityIndexLimit: 200` to `KNOWLEDGE_DEFAULTS`
- [ ] `knowledge.ts`: rewrite `getAllHighConfidenceKnowledge` — scored ranking + per-entity
      cap, deterministic tiebreak, `now` as a bound param; document the formula in a comment
- [ ] `knowledge.ts`: add `getKnowledgeEntityIndex` (every entity with ≥1 active observation,
      name + type + active observation count), per-row fault isolation (rule 50)
- [ ] `durable-objects/project-data/index.ts`: thread `perEntityLimit`; add index RPC
- [ ] `services/project-data.ts`: mirror both signatures
- [ ] `instruction-tools.ts`: pass the per-entity limit; fetch the index; append a compact
      complete index to `knowledgeDirectives` with lead-in text pointing at
      `search_knowledge` / `get_relevant_knowledge`
- [ ] `instruction-tools.ts`: update `buildKnowledgeInstructions` strings so the injected set
      is described as *ranked and partial*, with the index as the discovery path
- [ ] `apps/api/src/env.ts` + `apps/api/.env.example`: document the two new env vars
- [ ] Tests (real DO SQLite, `tests/workers/`) — see below
- [ ] Verify the window function actually runs on DO SQLite before building on it

**Explicitly out of scope** (per brief): rewriting/compressing stored observations. Write-time
hygiene is a tracked follow-up; doing it here risks context collapse.

## Test plan (discriminating — rules 28, 62)

All against **real** DO SQLite in `apps/api/tests/workers/`, driven through the production
RPC path (not by re-implementing the SQL in the test):

1. **Ranking replaces alphabetical** — seed >50 observations across early-alphabet
   (`AaaGrabBag`) and late-alphabet (`ZzzRecent`) entities, where the late-alphabet entity
   holds the most recent high-confidence observations. Assert `ZzzRecent` **injects**.
   *Must FAIL on pre-fix code* — verify once by restoring `ORDER BY e.name`.
2. **Per-entity cap** — one grab-bag entity with far more than the cap; assert no entity
   exceeds `perEntityLimit`, and that the freed slots go to other entities.
3. **Index completeness** — assert the index lists **every** active entity, including ones
   with zero injected observations (the ContentStyle/User case).
4. **Determinism** — identical repeated calls return identical ordering.
5. **Cap discrimination control** — a high cap must NOT starve other entities (guards against
   a test that passes for the wrong reason).

## Acceptance criteria

- [ ] Injection order is relevance-ranked, not alphabetical; formula documented in-code
- [ ] No single entity can consume more than the configured per-entity cap
- [ ] Every active entity appears in the injected index, with an observation count
- [ ] Index lead-in tells the agent how to retrieve what was not injected in full
- [ ] Both new limits are env-configurable with `DEFAULT_*`-style constants (Principle XI)
- [ ] Ranking test proven to fail against the pre-fix ordering
- [ ] Staging: a real `get_instructions` shows ranked selection + full index
- [ ] Compatible with R1's deduplicated response shape

## References

- `.claude/rules/28` (real SQL engine for SQL-predicate guards, owner controls)
- `.claude/rules/62` (test must reach the feature the way production does)
- `.claude/rules/50` (list reads tolerate a malformed row)
- `.claude/rules/03` / Principle XI (no hardcoded limits)
- `.claude/rules/24`, `.claude/rules/59` (one implementation per operation — reuse the
  existing scoring formula)
