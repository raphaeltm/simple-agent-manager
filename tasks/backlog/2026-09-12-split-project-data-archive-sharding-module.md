# Split `project-data-archive-sharding.ts` (3,663 lines, 4.5x the mandatory ceiling)

**Status**: backlog
**Raised by**: `architecture-reviewer` and `constitution-validator` during Phase 5 of
`tasks/active/2026-09-12-deadlocked-projectdata-archive-sweep-budget-mismatch.md`

## Problem

`apps/api/src/scheduled/project-data-archive-sharding.ts` is 3,663 lines.
`.claude/rules/18-file-size-limits.md` makes splitting **mandatory** above 800 lines, and the
rule explicitly rejects "it's just N more lines" as a rationale.

The file was already ~3,372 lines before the 2026-09-12 affordability fix, which added ~290 net
lines to it. That fix deliberately did **not** split the file: production was at 96.7% of its
Durable Object storage ceiling with roughly five days of headroom, and a seven-module split
would have made an urgent, security-of-data-relevant diff unreviewable. Deferring was the right
call for that change and is not a licence to defer again.

## Proposed split

Boundaries below follow the file's existing top-level structure, and were proposed by the
architecture reviewer against the post-fix line numbering.

| Module | Contents |
|---|---|
| `config.ts` | `ArchiveCoordinatorConfig`, `ArchiveCoordinatorScope`, `envInt`, `resolveConfig`, `resolveSweepAffordability`, `scopedConfig` |
| `cadence.ts` | cadence row/state types, `emptyCadenceState`, `cadenceStateFromRow`, `emptyStats`, `recordBudgetRefusal`, `sweepStalledOnUnaffordableCandidates`, `claimGlobalSweepCadence`, `finishGlobalSweepCadence`, `globalSweepCadenceLastError`, `budgetStallLastError` |
| `candidate-selection.ts` | `selectReclaimableMigrations`, `precopyRefusalExclusionBinds`, `createMessageBudgetPacker`, `applyMessageBudget`, `selectCandidates`, `selectScopedCandidates`, `selectMigrationWork`, `selectScopedMigrationWork` |
| `journal-lease.ts` | lease/journal CAS lifecycle, `claimMigrationLease` through `alignJournalToLocalSourceProof` |
| `copy-engine.ts` | R2 chunk copy, crash-gap recovery, `migrateCandidate` / `migrateClaimedCandidate` |
| `manual-operations.ts` | freeze / poison / inspect / abandon / copy-back admin entry points |
| `index.ts` (thin remainder) | `processArchiveMigrationBatch`, `runProjectDataArchiveSharding`, `runScopedProjectDataArchiveCanary`, re-exporting the above |

## Acceptance criteria

- [ ] No module above 800 lines; ideally none above 500.
- [ ] `index.ts` is a thin barrel with named re-exports only (no logic) so no consumer import
      path changes — `apps/api/src/scheduled/handler.ts`, the admin routes, and the test suites
      must all keep importing from the same specifier.
- [ ] The split lands as its **own commit with no behavioural change**, so the diff is
      reviewable as a pure move. Verify with a green `pnpm test:workers` run of
      `tests/workers/project-data-archive-sharding.test.ts` and
      `tests/workers/project-data-compact-archive.test.ts` before and after.
- [ ] `pnpm quality:agent-context-budget` re-measured, since this file is one of the largest
      single reads an agent working on the archive path performs.

## Notes

Do this before the next substantial change to the archive sweep, not after. Every additional
feature landed in the monolith makes the move commit larger and the behavioural diff harder to
separate from it.

## References

- `.claude/rules/18-file-size-limits.md`
- `apps/api/src/scheduled/project-data-archive-sharding.ts`
- `tasks/active/2026-09-12-deadlocked-projectdata-archive-sweep-budget-mismatch.md`
