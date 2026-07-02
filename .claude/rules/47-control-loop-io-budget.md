# Control Loops Need Explicit I/O Budgets

Alarm handlers, cron jobs, and reconcile sweeps are control loops. They must
bound wall time and guarantee that selected candidates eventually leave the
candidate set.

## Problem

Control loops often look cheap in review because each item is small. That is
false when the loop awaits network I/O to a target that can be dead. Worst-case
wall time is `per-item timeout * selected item count`, and a widened candidate
set can turn one unreachable target into a repeated platform-level regression.

## Incident Lesson

PR #1348 widened candidate selection in
`apps/api/src/durable-objects/project-data/reconciliation.ts`. The ProjectData
DO `alarm()` handler then sequentially awaited VM-agent HTTP calls through
`DEFAULT_NODE_AGENT_REQUEST_TIMEOUT_MS = 30_000` in
`apps/api/src/services/node-agent.ts:7`, an interactive timeout. Dead nodes
burned the full timeout per candidate, moving DO P99/P999 wall time from about
5s to 20-22s with spikes above 40s. The regression went undetected for two
weeks because no check watched DO wall-time percentiles, and some candidates
were logged-and-skipped without a terminal disposition.

## Hard Requirements

1. **Alarm/cron/sweep handlers get a wall-time budget.** DO `alarm()` handlers,
   cron sweeps, and reconcile loops may only do cheap local work synchronously
   such as DO SQLite and D1 reads/writes. Any network call to a target that can
   be dead or unreachable (VM agents, external APIs) must be one of:
   - gated by a cheap liveness pre-check;
   - moved to `ctx.waitUntil()` after durable state is written; or
   - queued for out-of-band delivery.

2. **Background loops use tiered timeouts.** Control loops must not inherit
   interactive/user-facing timeouts. Interactive paths may legitimately allow
   about 30s. Background reconcile and sweep calls need a separate, much
   shorter, env-configurable timeout with a `DEFAULT_*` constant. For VM-agent
   control checks, a healthy node answers in milliseconds; 5s of silence is
   "down" for control purposes. The ProjectData reconciliation implementation
   is owned by task `01KWH5WDKF0ZCY7KGNXFPZNDSD`; this rule defines the
   convention for future loops.

3. **Every selected candidate needs an escape path.** Each candidate a sweep or
   reconcile loop selects MUST have a path to leave the candidate set: success,
   terminal failure, or an expiring marker. A code path that logs-and-skips
   creates an immortal candidate retried every sweep.

4. **Selection widening requires load review.** Any PR that changes a WHERE
   clause, status set, join, or other candidate-selection predicate for a
   sweep/cron/alarm loop must state the expected candidate volume and
   worst-case per-candidate cost.

## Required Tests

For every new or changed sweep/reconcile candidate class, include a zombie
prevention regression test:

- Run the sweep twice against a permanently failing candidate.
- Assert the candidate is not re-selected on the second run, or that retries are
  explicitly bounded by a persisted/expiring marker.
- If the loop can call a dead target, include a test proving the dead-target
  path does not await the interactive timeout inside the control-loop critical
  path.

## Reviewer Checklist

Before merging a PR that touches an alarm, cron, sweep, or reconcile loop:

- [ ] Does this loop await a `fetch()` or VM-agent call whose target can be
      unreachable?
- [ ] What is worst-case per-item cost multiplied by selected item count?
- [ ] Is the timeout separate from any interactive/user-facing timeout and
      env-configurable with a `DEFAULT_*` constant?
- [ ] Does each selected candidate have a success, terminal failure, or
      expiring-marker path out of the candidate set?
- [ ] If candidate selection widened, does the PR state expected candidate
      volume and worst-case per-candidate cost?
- [ ] Is the permanent-failure candidate covered by a two-sweep regression test?

## References

- `.claude/rules/43-long-running-mcp-tools.md` — async boundaries for
  long-running VM work
- `.claude/rules/45-durable-object-concurrency-mutex.md` — DO `await`
  interleaving hazards
- `.claude/rules/35-vertical-slice-testing.md` — realistic cross-boundary tests
