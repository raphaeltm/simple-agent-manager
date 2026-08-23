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

- [x] `packages/shared/src/types/knowledge.ts`: add `autoRetrievePerEntityLimit: 8` and
      `entityIndexLimit: 200` to `KNOWLEDGE_DEFAULTS`
- [x] `knowledge.ts`: rewrite `getAllHighConfidenceKnowledge` — scored ranking + per-entity
      cap, deterministic tiebreak, `now` as a bound param; document the formula in a comment
- [x] `knowledge.ts`: add `getKnowledgeEntityIndex` (every entity with ≥1 active observation,
      name + type + active observation count), per-row fault isolation (rule 50)
- [x] `durable-objects/project-data/index.ts`: thread `perEntityLimit`; add index RPC
- [x] `services/project-data.ts`: mirror both signatures
- [x] `instruction-tools.ts`: pass the per-entity limit; fetch the index; append a compact
      complete index to `knowledgeDirectives` with lead-in text pointing at
      `search_knowledge` / `get_relevant_knowledge`
- [x] `instruction-tools.ts`: update `buildKnowledgeInstructions` strings so the injected set
      is described as *ranked and partial*, with the index as the discovery path
- [x] `apps/api/src/env.ts`: document the two new env vars inline. CORRECTED from the
      original plan, which also said `.env.example` — verified that file contains ZERO
      `KNOWLEDGE_*` entries (all 10 pre-existing siblings are documented only in
      `env.ts`), so adding just these two there would break the convention, not follow
      it. Documented in `env.ts` only, consistent with the family.
- [x] Tests (real DO SQLite, `tests/workers/`) — 14 tests, see below
- [x] Verify the window function actually runs on DO SQLite before building on it —
      CONFIRMED empirically; `ROW_NUMBER() OVER (PARTITION BY ...)` works
- [x] Rebase onto `origin/main` (advanced to b36f2358a mid-task; also forced renumbering
      the new rule 64 -> 65 after PR #1890 claimed 64)
- [ ] R1 coordination: R1 (`sam/remove-duplicated-structured-arrays-b6ggy4`) is NOT yet on
      main. Before merge, rebase again and confirm the entity index still renders against
      the deduplicated response shape. This branch neither depends on nor reintroduces the
      `knowledgeContext`/`policyContext` response arrays — it only changes how the
      knowledge FETCH is ranked and formatted, so the two are compatible by construction.

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

- [x] Injection order is relevance-ranked, not alphabetical; formula documented in-code
- [x] No single entity can consume more than the configured per-entity cap
- [x] Every active entity appears in the injected index, with an observation count
- [x] Index lead-in tells the agent how to retrieve what was not injected in full
- [x] Both new limits are env-configurable with `DEFAULT_*`-style constants (Principle XI)
- [x] Ranking test proven to fail against the pre-fix ordering (evidence below)
- [ ] Staging: a real `get_instructions` shows ranked selection + full index
- [ ] Compatible with R1's deduplicated response shape

## References

- `.claude/rules/28` (real SQL engine for SQL-predicate guards, owner controls)
- `.claude/rules/62` (test must reach the feature the way production does)
- `.claude/rules/50` (list reads tolerate a malformed row)
- `.claude/rules/03` / Principle XI (no hardcoded limits)
- `.claude/rules/24`, `.claude/rules/59` (one implementation per operation — reuse the
  existing scoring formula)

## Verification evidence

- **Window functions on DO SQLite**: no `ROW_NUMBER() OVER` precedent existed anywhere in
  `apps/api/src`, so this was proven empirically against a real SQLite-backed Durable
  Object (`@cloudflare/vitest-pool-workers`) rather than assumed. It works.
- **Discriminating-test proof (rule 62)**: restoring the pre-fix
  `ORDER BY e.name, o.last_confirmed_at DESC LIMIT ?` turns the ranking, cap, decay and
  parity tests red while the index tests stay green. Re-verified by an independent
  reviewer, which measured 9 of 11 red at that point.
- **Determinism proof**: the first version of the determinism test asserted only that
  three identical calls agree — which passes with `id ASC` deleted, because SQLite returns
  equal-keyed rows in stable physical order within an unchanged table. That test was
  therefore NOT discriminating. It now asserts the *specified* order (ids ascending among
  ties), which is falsifiable because ids are random UUIDs: removing `id ASC` fails
  exactly that one test and nothing else. Verified in both directions.
- **`* 1.0` real-division promotion is deliberately NOT claimed as tested.** Removing it
  leaves every test green, because `SqlStorage` binds JS numbers as doubles so the
  division was never truncating. It is kept as defence against that driver detail
  changing, and the comment says so rather than implying a guard that does not exist.
- Suites: API unit 8029/8029 (0 collection failures), workers 690/690 pre-review,
  knowledge suite 14/14 after review fixes, shared 590/590. Lint, typecheck, build and
  `check:fast` clean.

## Post-mortem

**What broke.** Session-start knowledge injection silently returned the alphabetically
first observations instead of the most relevant ones. In production every one of the 50
slots went to entities `AccountMap`..`AgentReliability`, 46 of them to the single
`AgentBehavior` grab-bag. Entities the injected instructions explicitly tell agents to
consult — ContentStyle, CodeQuality, User, Architecture, BusinessStrategy — had never been
injected once, and nothing in the payload hinted they existed, so an agent had no reason
to search for them.

**Root cause.** `getAllHighConfidenceKnowledge` selected with
`ORDER BY e.name, o.last_confirmed_at DESC LIMIT ?`. Entity name has no relationship to
usefulness, so the `LIMIT` acted as a filter on spelling. Introduced 2026-04-16 in
`a52e3a2fa` (PR #734, "improve knowledge graph retrieval and agent instructions").

**Timeline.** Introduced 2026-04-16; live for ~4 months; discovered 2026-08-23 by
measuring an actual `get_instructions` payload (166,557 chars) during the token-optimization
research, not by any failure.

**Why it wasn't caught.** Three reinforcing reasons. (1) No test asserted the *composition*
of the injected set — only that knowledge came back at all, which stayed true throughout.
(2) The bias is invisible below production scale: with fewer than 50 total observations
every entity fits and the ordering never matters, so it degrades only as a project
succeeds. (3) The truncation was silent — there was no count, index, or marker, so the
missing entities were indistinguishable from entities that did not exist. Notably a
relevance-scoring path (`getRelevantKnowledge`) already existed one function above and was
not reused.

**Class of bug.** A capped selection whose ordering key is uncorrelated with the cap's
purpose, combined with no disclosure of what was dropped. Either half is a bug; together
they are undetectable from inside the system, because every component is individually
"working" and the payload is well-formed.

**Process fix.** `.claude/rules/65-capped-selection-must-rank-and-disclose.md` — requires
that any bounded subset handed to a consumer who cannot see the rest is ranked by the
consumer's purpose (reusing an existing scoring function where one exists), capped per
group where one group can dominate, and accompanied by a disclosure of the total plus the
tool that retrieves the remainder. It also requires the skew test be proven to fail against
the old ordering, and that ranking expressed as a SQL predicate be tested against a real
SQL engine rather than mirrored in TypeScript.

**Follow-ups filed, deliberately out of scope here**
(write-time hygiene was excluded by the brief to avoid context-collapse risk):

- Write-time observation hygiene: merge/dedupe `" | "`-concatenated blobs, and split the
  `AgentBehavior` grab-bag into narrower entities so ranking has more to work with.
- Optional index `(is_active, confidence)` on `knowledge_observations`: the ranking query
  currently scans all active rows. Bounded (500 entities x 100 observations) and runs once
  per session start, so it is not urgent, and it needs a DO migration.
- Reader-side hardening of the remaining `rows.map(parseRow)` call sites in
  `project-data/` — already tracked in
  `tasks/backlog/2026-07-16-project-data-row-fault-isolation-audit.md`.
