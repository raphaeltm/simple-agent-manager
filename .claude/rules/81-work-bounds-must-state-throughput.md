# A Work Bound Must State Its Throughput at the Outer Probable Limit

## When This Applies

Any cap on how much work one attempt, tick, pass or request does: entries per walk, items
per batch, rows per sweep, files per pass, candidates per alarm. Also any retry schedule
that decides when unfinished work is looked at again.

## Why This Rule Exists

#2463 capped VM workspace deletion at 512 filesystem entries per attempt, one attempt per
minute, and listed the cap as a cost-safety property. Nobody did the division: a normal
10k-entry repository took ~20 minutes to delete, and the control plane's exponential retry
(1, 2, 4, 8, 16 min) confirmed it at ~31. Unit tests used 4-file directories and staging
used a tiny fixture repository, so every check passed. Lifecycle latency was not recorded
anywhere, and every stop in production took ~31 minutes for six days before a human
noticed (`tasks/archive/2026-11-03-fast-workspace-physical-deletion.md`).

A second instance, 2026-11-09: compute pool catalog publication wrote 200 candidate rows per
refresh and returned, with refreshes daily or user-triggered, and a pool cannot place VMs until its
catalog is fully written. A ~1,000-row GCP catalog therefore left a production user's whole pool
unplaceable for days. The 200 was a sensible chunk size used as the whole per-pass budget
(`ensureCandidatesForSource()`, `tasks/archive/2026-11-09-capacity-pool-publication-deadline-loop.md`).
When work gates availability, ask what the user is blocked on while the bound defers the rest.

## Hard Requirements

1. **Do the division in the PR.** For every bound, state the implied throughput and the
   worst-case completion time at the outer probable limit of the input, not the typical
   one. Name the limit: a 100k-file monorepo, a million-file directory, a 10k-row project.
   Include the retry or tick schedule in the arithmetic.
2. **Work that must finish is bounded by time, not by count.** Use the attempt deadline
   and make progress resumable. A count bound is acceptable only as a memory or batch
   size inside a deadline-bounded loop that keeps going until the deadline.
3. **Test at the limit.** At least one test drives the real entry point with input larger
   than every count in the path (for example, more entries than one batch), and asserts
   the operation completes in one attempt or within its stated time.
4. **User-visible lifecycle operations have a latency budget.** Stating it in the PR is
   the minimum. A stuck or slow operation must be detectable from stored data, not only
   from logs.

## Quick Compliance Check

- [ ] Every new or changed bound has throughput and worst-case time stated at the outer limit
- [ ] Retry schedules are included in that worst case
- [ ] Must-finish work is deadline-bounded and resumable
- [ ] A test exceeds every count in the path through the real entry point

## References

- `.claude/rules/62-tests-must-observe-the-real-trigger.md`: realistic triggers
- `.claude/rules/74-proxy-signals-must-match-the-condition.md`: a cap is a proxy for the condition it protects
- `apps/api/.claude/rules/47-control-loop-io-budget.md`: bound cost, and this rule: prove the bound still finishes
