# A Capped Selection Must Rank By Its Purpose, And Must Disclose What It Dropped

## When This Applies

Any query, filter, or fan-out that returns **a bounded subset of a larger set to a
consumer who cannot see the rest** — `LIMIT N`, `slice(0, N)`, top-K, "first N matching",
sampling. It applies with full force when the consumer is an LLM, because a model cannot
notice an absence: it will confidently reason from a truncated set as though it were
complete.

It does NOT apply to paginated reads where the consumer receives a cursor, a `hasMore`, or
a total — those already disclose the truncation.

## Why This Rule Exists

`getAllHighConfidenceKnowledge` selected session-start knowledge injection with:

```sql
WHERE confidence >= 0.8 ORDER BY entity_name, last_confirmed_at DESC LIMIT 50
```

`ORDER BY entity_name` is alphabetical. Alphabetical order has nothing to do with how
useful an observation is. So the cap did not select the 50 most useful observations — it
selected the 50 that sorted earliest, which in production meant **all 50 slots went to
`AccountMap` through `AgentReliability`, 46 of them to a single `AgentBehavior`
grab-bag entity.**

Meanwhile the very same payload instructed the agent to consult `ContentStyle`,
`CodeQuality`, `User`, `Architecture`, and `BusinessStrategy` before making decisions.
Every one of those sorts after "A". None of them had **ever** been injected. Worse, the
payload gave no hint they existed, so an agent could not have searched for them — it had
no reason to believe there was anything to search for.

The result was stable, silent, and systematically biased: the same topics were excluded
every session, for months, while the feature looked like it was working. It was found by
measurement, not by failure.

## Class of Bug

**A cap whose ordering key is uncorrelated with the cap's purpose, with no disclosure of
what was excluded.** Two independent defects that compound:

1. *Wrong ranking* — the ordering encodes an incidental property (name, insertion order,
   id) rather than the value the consumer needs. The cap then acts as a systematic filter
   on that incidental property.
2. *Silent truncation* — the consumer receives no count, index, or marker, so the missing
   data is indistinguishable from data that does not exist.

Either alone is a bug. Together they are undetectable from the inside: every component is
"working", the payload is well-formed, and the tests pass.

The tells:

- `ORDER BY <name|id|created_at>` immediately above a `LIMIT` on a set the consumer treats
  as authoritative.
- A comment justifying the cap on size grounds ("for typical projects this is small")
  without saying what happens when it is not typical.
- Instructions that reference specific items by name, with no guarantee those items are in
  the payload.
- A grab-bag entity/bucket/tag that legitimately holds far more rows than its siblings.

## Hard Requirements

1. **Rank by the consumer's purpose.** If the cap exists because the consumer can only use
   N items, order by how useful an item is to that consumer — relevance, confidence,
   recency, priority. Never by a name, id, or insertion order that merely happens to be
   available. If you cannot articulate why the ordering key correlates with usefulness,
   the ranking is wrong.

2. **Reuse the ranking the system already has.** If a sibling read already scores the same
   entities (here `getRelevantKnowledge`'s confidence x recency), use that formula rather
   than inventing a second one, so two paths cannot disagree about what "most relevant"
   means (rules 24, 59).

3. **Cap per group when one group can dominate.** A global `LIMIT` over a skewed
   distribution is a cap in name only — the largest group absorbs it. Add a per-entity /
   per-group / per-tenant bound, env-configurable with a `DEFAULT_*` constant.

4. **Disclose the truncation.** The consumer must receive enough to know the set is
   partial and to retrieve the remainder: a complete lightweight index, a total count, or
   an explicit "N more, retrieve with X". Naming the retrieval tool is part of the
   disclosure — "there is more" without "here is how" is not actionable.

5. **The disclosure must survive the failure of the main read.** Fetch it independently.
   If ranked retrieval throws and the catch swallows it, the consumer should still learn
   what exists rather than silently receiving nothing — which is exactly the pre-existing
   behaviour that made this class invisible.

6. **Give ties a total order.** Equal-scoring rows must be broken deterministically (a
   secondary key, then a unique id). Otherwise the payload permutes between identical
   calls, which defeats prompt caching and makes differences unreproducible.

## Required Tests

- **The skew case**: seed one group large enough to exhaust the global cap on its own, plus
  groups that sort *after* it under the old ordering. Assert the later groups are selected.
  This must FAIL against the old ordering — verify that once.
- **The per-group cap holds**, with an owner control proving the freed slots actually reach
  the other groups rather than vanishing.
- **A raised-cap control** proving the cap parameter is what constrains the dominant group,
  not the shape of the seeded data.
- **Disclosure completeness**: an item excluded from the capped set still appears in the
  index. Assert the count, not just presence.
- **Determinism**: identical repeated calls return an identical sequence.
- Ranking that is a SQL predicate must be tested against a **real** SQL engine, not a
  mock that ignores `ORDER BY` (rule 28). For Durable Object SQLite that means
  `@cloudflare/vitest-pool-workers` in `apps/api/tests/workers/`, driven through the real
  RPC — not the SQL re-implemented in TypeScript, which would pass even if the query never
  ran (rule 62).

## Quick Compliance Check

- [ ] The ordering key is one a reader would call "most useful first", not a name or id
- [ ] An existing scoring formula was reused rather than duplicated
- [ ] A per-group cap exists wherever one group can dominate; both bounds are env-configurable
- [ ] The consumer is told the set is partial, how many exist, and which tool retrieves the rest
- [ ] The disclosure is fetched independently of the capped read
- [ ] Ties break to a total order
- [ ] The skew test was verified to fail against the pre-fix ordering

## References

- Task: `tasks/active/2026-08-23-knowledge-injection-relevance-ranking.md` (moves to
  `tasks/archive/` on completion); research `/engineering/research/token-optimization-research.md` §3.2, §8/R3
- Implementation: `apps/api/src/durable-objects/project-data/knowledge.ts`
  (`getAllHighConfidenceKnowledge`, `getKnowledgeEntityIndex`)
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md` — a signal that
  cannot answer the question being asked of it; "the symptom is an absence"
- `.claude/rules/50-list-read-row-fault-isolation.md` — the other silent-truncation mode
- `.claude/rules/02-quality-gates.md` — the absence of failures and the absence of results
  are indistinguishable if you only look at the failure count
- `.claude/rules/28-credential-resolution-fallback-tests.md` — SQL predicates need a real
  SQL engine, and every case needs a control
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — prove the guard discriminating
- `.claude/rules/24`, `.claude/rules/59` — one implementation per operation
