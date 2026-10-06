# `get_instructions` asks agents to maintain knowledge they cannot address

**Discovered during**: task 01M0QHHVEQY11VC37Y29B6GGY4 (R1 — remove duplicated structured
arrays from `get_instructions`), 2026-08-23.

## Problem

`get_instructions` emits `instructions[12]`:

> The knowledgeDirectives field above contains stored knowledge from previous sessions.
> Apply these preferences and facts to your work. If any observation seems outdated, call
> `update_knowledge` or `remove_knowledge`. If you verify an observation is still accurate,
> call `confirm_knowledge` to keep it fresh.

All three of those tools require an `observationId`. **No observation id is present
anywhere in the `get_instructions` response.** An agent that follows this instruction
literally cannot: it has to guess, or fall back to `search_knowledge` /
`get_project_knowledge` to re-fetch ids it was never given.

## Root cause

`apps/api/src/routes/mcp/instruction-tools.ts` maps the retrieval result to only four
fields:

```ts
knowledgeContext = allHighConfidence.map((r) => ({
  entityName: r.entityName,
  entityType: r.entityType,
  observation: r.content,
  confidence: r.confidence,
}));
```

The underlying query (`apps/api/src/durable-objects/project-data/knowledge.ts:390`)
selects `o.*`, so the observation `id` **is** available at that point — it is simply
dropped by the mapper. This predates the R1 de-duplication change; removing
`knowledgeContext` did not cause it and did not make it worse (that array never carried
the id either).

Contrast with policies: R1 added the full policy id inline to `policyDirectives`
precisely so `update_policy` / `remove_policy` stay usable. Knowledge has the same
instruction but never had the same affordance.

## Proposed fix

Render a compact id alongside each observation in `formatKnowledgeDirectives`, mirroring
what R1 did for policies. Note the current formatter **joins multiple observations per
entity** with `' | '`, so ids must be attached per-observation, not per-entity — this is a
real format change, not a one-line addition.

Estimated cost: ~50 observations × ~40 chars ≈ 2K chars, against the ~81K post-R1 payload.
Weigh against recommendation R3 (knowledge selection ordering), which is reshaping the
same block — coordinate so the two do not conflict.

## Acceptance criteria

- [ ] Every observation rendered in `knowledgeDirectives` carries its exact
      `observationId` (full, untruncated — `knowledge_observations` lookups are
      `WHERE id = ?` exact matches)
- [ ] Multi-observation entities keep each id bound to its own observation
- [ ] A test asserts the rendered id is the exact string `confirm_knowledge` accepts
- [ ] A test asserts the payload growth stays within budget

## References

- `.claude/rules/60-request-io-and-bundle-budgets.md` — payload budgets
- R1 task: `tasks/archive/2026-08-23-remove-duplicated-structured-arrays-get-instructions.md`
- Token-optimization research: library `/engineering/research/token-optimization-research.md`
