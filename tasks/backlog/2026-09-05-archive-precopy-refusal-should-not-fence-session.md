# Archive sharding: a pre-copy invariant refusal must not leave the session fenced

## Problem

`createCandidateJournal` fences a session (`project_data_session_locations.location_state =
'migrating'`) before `archiveSourcePrepareIntent` runs. When the root object refuses the
session at prepare with a `ProjectDataArchiveInvariantError` (observed in production on
2026-09-05 23:09Z: `ProjectData archive refuses sessions with active session_state rows`,
session `ea87d375-ada4-4bd3-81b3-5c3aa8fc0582`, migration `eeebff46-b72b-4d4c-a875-d37618ba98e9`),
nothing has been written to either object, yet `markFailed` leaves the journal `failed` and the
location `migrating`. The session is unreadable until an operator runs the abandon route
(PR #2024) or a later sweep retry happens to succeed, and a retry cannot succeed while the
refusal condition persists.

## Context

Found while running the operator capacity-relief canary script against the SAM root object
(`01KHRJGANBBWGDY1NZ0KVF0D4J`). The D1 candidate query (`selectScopedCandidates`) cannot see
DO-local eligibility guards (`session_state` rows, comments, active status inside the object),
so any of those refusals fences a session for no benefit. The same session also shows a data
hygiene gap: a terminal session ended more than 7 days ago still holds an active
`session_state` row (rule 57 stale-activity class).

## Acceptance Criteria

- [ ] When `archiveSourcePrepareIntent` refuses with an invariant error and no source intent
      row exists for the migration, the coordinator returns the D1 location to `root` in the
      same tick (reuse the abandon location-restore statement) and records the journal as
      `failed` with an error code that distinguishes "refused before copy" from a mid-copy failure.
- [ ] Sweep candidate selection excludes sessions whose most recent journal is a pre-copy
      refusal until the refusal condition is cleared (or applies a bounded retry marker, rule 47).
- [ ] A discriminating test: refused-at-prepare candidate ends the tick readable (`root`), while a
      mid-copy failure control still ends fenced (`migrating`) pending retry/abandon.
- [ ] Investigate why `ea87d375` carries an active `session_state` row a week after ending, and
      whether idle cleanup should clear it (rule 57).

## References

- `apps/api/src/scheduled/project-data-archive-sharding.ts` (`createCandidateJournal`,
  `migrateCandidate`, `markFailed`, `abandonProjectDataArchiveMigration`)
- `apps/api/src/durable-objects/project-data/archive-sharding.ts` (`prepareArchiveSourceIntent`)
- `tasks/archive/2026-09-05-archive-sharding-streaming-hash-abandon-and-size-budget.md`
- `.claude/rules/47-control-loop-io-budget.md`, `.claude/rules/57-write-only-cross-boundary-state.md`
