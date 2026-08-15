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

The 2026-08-09 billing-risk audit found the complementary failure mode: loops
whose work was cheap but whose state machine had no terminal exit. A
`NodeLifecycle` object in `destroying` re-armed every minute after its D1 row
was gone, a zero-task mission remained active forever, and failed cleanup
candidates stayed at the front of a bounded page. The same audit found an
API/tail-worker feedback cycle where observing the ingest request produced the
next ingest request. Cheap iterations are still runaway spend when iteration
count is unbounded.

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

5. **Every persisted alarm state needs a terminal exit and maximum residence
   time.** For every state that re-arms an alarm, document the durable condition
   that stops re-arming. When external state owns completion, re-read that state
   and self-clean after it becomes terminal or disappears. Also enforce an
   env-configurable maximum age with a `DEFAULT_*` constant so inconsistent
   external state cannot keep the alarm alive forever.

6. **Missing work needs a grace period, not an infinite wait.** Empty task or
   candidate sets may be transient, but the grace period and overall lifecycle
   must both be env-configurable and bounded. Transitional states such as
   `completing` must converge to a final state.

7. **Control-loop edges must not observe themselves.** Logging, telemetry,
   retries, and tail delivery must exclude their own ingestion/control paths.
   A failed downstream observation must update cached demand to the safe idle
   state instead of leaving an open-loop retry condition.

8. **Human-response deadlines require a delivery contract.** A control-plane
   timeout MUST NOT fail work, stop a workspace, or delete recoverable state merely
   because an internal notification or attention row exists. Before destructive
   expiry, the system must have a persisted confirmation that at least one external
   channel accepted delivery, or it must apply an env-configurable, bounded
   escalation/grace policy with a hard maximum residence time. Keep human-response
   timers and machine-liveness watchdogs as explicit, branch-specific classes; when
   one loop handles both, add a discriminating regression test proving the
   machine-liveness branch retains its intended terminal behavior.

## Required Tests

For every new or changed sweep/reconcile candidate class, include a zombie
prevention regression test:

- Run the sweep twice against a permanently failing candidate.
- Assert the candidate is not re-selected on the second run, or that retries are
  explicitly bounded by a persisted/expiring marker.
- If the loop can call a dead target, include a test proving the dead-target
  path does not await the interactive timeout inside the control-loop critical
  path.
- For an alarm state that should terminate, run two alarm ticks and assert the
  first tick deletes or terminalizes durable state and the second tick does not
  re-arm or repeat work.
- For feedback-prone ingestion paths, prove both that the request logger omits
  the ingest edge and that downstream failures cache zero demand.

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
- [ ] Does every re-arming state have both a durable terminal condition and a
      bounded maximum age?
- [ ] Can any log, tail, notification, or retry edge feed its own input?
- [ ] If expiry assumes a human failed to respond, what persisted evidence proves a
      channel accepted delivery, and what bounded grace applies when none did?
- [ ] If the loop also handles machine-liveness markers, does a discriminating control
      test prove that branch was not weakened?

## References

- `.claude/rules/43-long-running-mcp-tools.md` — async boundaries for
  long-running VM work
- `.claude/rules/45-durable-object-concurrency-mutex.md` — DO `await`
  interleaving hazards
- `.claude/rules/35-vertical-slice-testing.md` — realistic cross-boundary tests
