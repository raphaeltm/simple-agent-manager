# Cap the chats read per idea, and disclose what was dropped

> **Reconciliation 2026-10-26:** #2436 (`e19aa30c1`), the merge that filed this, already caps chats
> per idea. `listLinksForTargets` (`project-data/links.ts:216`) keeps at most
> `operations.resourceLinkBatchPerTargetCap` link rows per idea (admin setting, default 50), strong
> relations first, then newest link; a capped idea reports `atLeast: ['chats']` ("50+",
> `idea-work.ts:270`). Markers are read only for kept chats, and the `cs.updated_at DESC` query is
> gone. Still open: a ranking that serves `deriveIdeaStatus` (an open question on an older-linked
> chat can be cut), the skew test and the round-trip assertion.

## Problem

`getIdeaWorkSnapshots` (`apps/api/src/durable-objects/project-data/idea-work.ts`) chunks the
_idea_ list against the bound-parameter ceiling, but puts no bound on how many linked chats or
attention markers come back **per idea**. A long-lived idea that people keep returning to can
accumulate chats without limit, and each one:

- grows `sessionTaskIds`, so `readSessionTasks` and `readAssociatedPullRequests` in
  `operations/idea-list-reads.ts` chunk into more D1 round trips (rule 60), and
- grows the Durable Object RPC response, which has a hard serialization ceiling.

Found by the cloudflare-specialist review of the T8 Ideas redesign PR. Not a problem at the
sizes measured there (100 ideas / 300 chats = ~13 round trips, inside the ≤20 aggregation
budget), so it was tracked rather than fixed in that PR.

## The part that needs thought first

A cap is not just a `LIMIT`. `deriveIdeaStatus` reads the returned chats to decide the idea's
state, so dropping the wrong ones changes what the page says. The query orders by
`cs.updated_at DESC`, and a chat that is genuinely working is being updated — so recency
_correlates_ with the thing the derivation cares about without _being_ it, which is exactly
the shape rule 74 warns about. Decide the ranking before writing the cap:

- rank by what the derivation needs (an unanswered question, then live/sleeping work, then
  recency), not by recency alone; or
- keep the full set for the derivation and cap only what the page displays.

## Acceptance criteria

- [ ] A per-idea bound on chats and on attention markers, env-configurable with a `DEFAULT_*`
      constant (constitution XI).
- [ ] The ranking is by the consumer's purpose, written down, with the divergence from plain
      recency stated (rules 65, 74).
- [ ] The response discloses the total and how to get the rest (rule 65 disclosure).
- [ ] A skew test: one idea with more linked chats than the cap, where the state-deciding chat
      sorts last by `updated_at`. It must still derive the right state, and must fail against a
      recency-only cap.
- [ ] A round-trip assertion that the list's D1 cost stops growing past the cap.
- [ ] Tests run in `apps/api/tests/workers/` against real DO SQLite, through the real RPC.

## References

- `apps/api/src/durable-objects/project-data/idea-work.ts`
- `apps/api/src/operations/idea-list-core.ts`, `idea-list-reads.ts`
- `.claude/rules/65-capped-selection-must-rank-and-disclose.md`
- `apps/api/.claude/rules/74` equivalent: `.claude/rules/74-proxy-signals-must-match-the-condition.md`
- `.claude/rules/60-request-io-and-bundle-budgets.md`
