# Archive: re-check R2 before a delayed flip; delete orphaned R2 objects after an unwind

## Problem

The resumable archive cursor (PR #2704) keeps the shard's verification verdict once every R2 chunk
was re-read before the flip. If the flip is then delayed (a progressed failure, the failed-retry
delay), an R2 object lost in that window is not noticed before the root reclaims its rows. R2
durability makes this unlikely, and the window is normally under one tick. Separately, a flip
refusal unwinds the shard copy but leaves its compact raw chunk objects and manifest in R2.

## Context

Found by the cloudflare-specialist and adversarial reviews of #2704 (MEDIUM, deferred with
justification). Code: `verifyArchiveTargetPage` (`apps/api/src/durable-objects/project-data/archive-sharding.ts`),
`unwindFlipRefusal` (`apps/api/src/scheduled/project-data-archive-sharding.ts`).

## Acceptance Criteria

- [ ] A completed verdict older than a bound derived from the sweep cadence is re-checked (HEAD of
      every chunk key, or a re-read) before the flip, without counting as progress.
- [ ] An unwind deletes the migration's R2 raw chunks and manifest, idempotently and in pages.
- [ ] Tests: lost object after verification is caught before flip; unwind leaves no R2 objects.
