# Archive: serve `frozen` sessions from the root; back off repeated flip refusals

## Problem

1. A poisoned or operator-frozen migration sets the location `frozen`, and exact reads fail closed
   even though, before the flip, the root still holds every row. Routing could serve `frozen`
   from the root the way `migrating` now is (`resolveExactReadOwner`), leaving the DO's
   `isSourceExactReadFenced` as the arbiter.
2. A session whose flip is refused for a recurring reason (an alarm that keeps touching an anchor
   column, a marker raised again) is re-copied once per `PROJECT_DATA_ARCHIVE_PRECOPY_REFUSAL_RETRY_MS`
   (1 day), each time spending a full write reservation. Visible as `flipUnwound`, but not backed off.

## Context

Deferred LOW/MEDIUM findings from the #2704 reviews.

## Acceptance Criteria

- [ ] `frozen` locations read from the root while the root intent is pre-flip; tests for poisoned and
      operator-frozen sessions.
- [ ] Consecutive flip refusals of one session back off exponentially (or are capped with an
      operator-visible signal); test with a recurring refusal cause.
