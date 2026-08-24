# Follow-ups from knowledge-injection relevance ranking (R3)

Deferred findings from the Phase 5 specialist review of
`tasks/active/2026-08-23-knowledge-injection-relevance-ranking.md`. Each was judged
MEDIUM/LOW and not merge-blocking; the CRITICAL/HIGH findings from that review were fixed
in the PR itself.

## 1. Entity-index truncation ordering is uncorrelated with injection ranking

`getKnowledgeEntityIndex` truncates by `observation_count DESC`, while injection ranks by
confidence x recency. For a project with more than `entityIndexLimit` (200) entities, an
entity can be **injected** into `knowledgeDirectives` yet be **absent from the index**
below it — because it has few but very fresh/high-confidence observations.

`formatKnowledgeEntityIndex` computes `notInjected` by scanning the index for names missing
from the injected set; it cannot detect the inverse. That partially undercuts the rule-65
disclosure guarantee: an agent could see an entity in the ranked block, consult the index
to decide whether more exists, and find it missing entirely.

- Likelihood is low (needs >200 entities; `maxEntitiesPerProject` is 500).
- Options: union the injected entities into the index before truncating; or order the
  index by the same relevance signal; or disclose the inverse case in the lead-in.
- No test currently exercises the >200-entity boundary.

## 2. Split `knowledge.ts` and `instruction-tools.ts` (rule 18)

Both were already over the 500-line "candidate for splitting" threshold before R3 and grew:

| File | before | after |
|---|---|---|
| `apps/api/src/durable-objects/project-data/knowledge.ts` | 513 | ~730 |
| `apps/api/src/routes/mcp/instruction-tools.ts` | 682 | ~791 |

Neither crosses the 800-line mandatory ceiling, so rule 18 did not block the R3 merge — but
`instruction-tools.ts` is now within ~10 lines of it, so the NEXT addition to that file must
split it. Suggested cuts:

- `knowledge.ts` -> entity/observation CRUD vs. search/ranking/index reads.
- `instruction-tools.ts` -> extract the knowledge/policy retrieval + formatting block.

## 3. `parseInt(...) || DEFAULT` silently ignores an explicit `0`

Four sites in `instruction-tools.ts` (2 pre-existing, 2 added by R3) resolve limits with
`parseInt(env.X || '', 10) || DEFAULT`. `parseInt('0')` is `0`, which is falsy, so an
operator setting a limit to `0` silently gets the default instead.

R3 removed the dangerous half of this (a negative value reaching SQL) by clamping at the DO
boundary, so the remaining impact is only "0 is not honoured as 0" — and for these
particular limits 0 is arguably not a meaningful setting anyway. Still, the codebase has a
better idiom already: `Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT`
(`services/credential-mutation-rate-limit.ts`, `services/operational-kill-switch.ts`).
Worth normalising all four together.

## 4. Consider an index on `knowledge_observations(is_active, confidence)`

The ranked query filters `WHERE o.is_active = 1 AND o.confidence >= ?` project-wide. The
existing `idx_knowledge_obs_entity(entity_id, is_active)` does not help, since `entity_id`
is unconstrained. At the documented ceiling (500 entities x 100 observations = 50k rows)
this is a full scan plus a window sort at every session start.

Measure first — DO SQLite is in-process and real projects are far below the ceiling, so this
may not be worth a migration. If added, note that DO SQLite migrations have no time-travel
recovery (rule 31); `CREATE INDEX IF NOT EXISTS` is additive and safe.

## 5. Un-memoized `ensureProjectId` in `project-data-policies.ts`

`services/project-data-policies.ts`'s local `getStub` calls `await stub.ensureProjectId(...)`
unconditionally, unlike `services/project-data.ts`'s `getStub`, which memoizes per isolate.
So the R3 `Promise.allSettled` fan-out still has a 2-round-trip floor because of the policy
leg. Pre-existing, not introduced by R3, but it partially defeats the concurrency win.
Fix by reusing the memoized stub resolver.

## 6. Parity test proves ordering, not magnitude

`computeRelevanceScore` (JS) vs. the SQL expression are compared only by resulting order
over a fixed 5-point fixture, because `relevance_score` is not returned across the RPC
boundary. A magnitude-only divergence (e.g. changing the decay scale on the SQL side alone)
would not reorder that fixture and so would not be caught.

Options: expose `relevance_score` on the row (it is already computed) and assert numeric
parity directly, or widen the fixture so magnitude changes necessarily reorder it.

## References

- Parent task: `tasks/active/2026-08-23-knowledge-injection-relevance-ranking.md`
- `.claude/rules/65-capped-selection-must-rank-and-disclose.md`
- `.claude/rules/18-file-size-limits.md`, `.claude/rules/60-request-io-and-bundle-budgets.md`
