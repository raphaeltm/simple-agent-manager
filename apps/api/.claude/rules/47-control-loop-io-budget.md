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

The 2026-08-25 production stability audit found a third failure mode in the
diagnostic feedback loop: evidence capture succeeded, but diagnosis budget
exhaustion was recorded like ordinary failure. Known repeat signatures consumed
the bounded selection window, budget-blocked signatures accumulated as rejected
rows, and no durable dispatch was ever attempted. Token or API budgets are
control-loop capacity, not incident disposition; exhausting them must defer work
until the budget refreshes and must not silently drop the candidate.

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

   Capacity exhaustion such as daily token budget, per-run budget, rate limit,
   or provider 429 is an expiring marker, not terminal failure. Persist the
   retry eligibility time and leave the candidate eligible after that time.
   Prioritize severe/novel candidates ahead of low-severity repeat floods when
   budget is scarce.

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

9. **Warning safety states and exhausted remediation need operator alerts.** A
   control loop that classifies durable resource exhaustion risk (storage, quota,
   billing, queue depth, or similar) MUST route warning-or-worse states through an
   existing operator-visible alert channel, not only logs. If bounded remediation
   exhausts all safe candidates while still above its target, surface an explicit
   target-unreachable health state and emit an error-severity operator alert.

10. **An alarm schedule must come from the record its sweep acts on.** Compute a
    section's next alarm from the same query and per-row "next check" record the
    sweep selects with. Never compute it from a nearby signal the sweep only partly
    acts on (activity plus a check interval, when the sweep acts at activity plus a
    timeout): every row the sweep skips then re-arms the alarm at its floor. Every
    row the sweep examines must leave with a later next check or be deleted, and
    that write must happen before any await, because other requests interleave
    across awaits (`.claude/rules/45`). Incident: the ProjectData workspace idle
    section scheduled rows at `lastActivity + 5 min` while its sweep acted at
    `lastActivity + timeout` (2 h). One quiet active session re-armed the alarm 110
    times at the 60 s floor, and 19 of 25 production objects fired ~1,450 alarms a
    day (PR #2170, `project-data/workspace-idle-timeouts.ts`).

11. **A failure that looks repairable still spends the budget.** Do not exempt a
    failure class from the attempt cap because the next attempt might fix it. Session
    sleep exempted degraded and still-in-flight captures from
    `SESSION_SLEEP_MAX_ATTEMPTS`; an agent that can never produce a complete capture
    makes every attempt look repairable. On 2026-10-04 three idle production
    workspaces had made 93, 101 and 100 attempts that way, pinning two nodes until a
    person deleted them. Keep an attempt count and an elapsed-time bound on the
    durable row, and let only the end of the episode reset them: success, or a human
    action. A new capture generation, a deferral or a restart must not. When the
    budget runs out, act on what already exists: fall back to the cheapest outcome
    that still meets the minimum guarantee, or stop in a terminal state the user can
    see and leave by acting. Automatic retries must skip that terminal state
    (`apps/api/src/services/session-sleep-episode.ts`).

12. **A deferral must not copy another record's deadline into the deferred row.**
    Requirement 10 is only satisfied if the per-row "next check" belongs to that row. When
    a row is blocked by some other record's state, read that record in both the selection
    query and the schedule (one shared predicate), or clear every copy on every exit of
    the blocking state. A copied deadline is a second, unsynchronized representation that
    nothing invalidates. Incident (2026-10-09): one open event wake on a chat made the
    ProjectData wake materializer write that wake's 24 h expiry into the cooldown of every
    other wake subscription on the chat (`deferWakeTarget`). Acknowledging or delivering
    the wake did not release the copies, so a production CI subscription never woke its
    chat. Fix: `WAKE_TARGET_HAS_UNDELIVERED_WAKE_SQL` in
    `project-data/project-events-wake-config.ts`, used by both `selectWakeCandidates` and
    `computeProjectEventMaterializationAlarmTime`.

## Required Tests

For every new or changed sweep/reconcile candidate class, include a zombie
prevention regression test:

- Saturate the configured batch with permanently failing candidates, including
  NULL-deadline and looks-repairable variants, and place valid work behind them.
  Assert bounded repeated ticks reach that work. Every failure persists a future
  retry deadline that the selector and claim predicate both honor, and the retries
  end at the budget (requirement 11), driven through the scheduled trigger with an
  injected clock (`tests/integration/session-sleep-bounded-fallback.test.ts`).
- When a service and its sweep both catch an error, test their real composition.
  Terminal classification must happen in the first ownership-fenced failure write;
  a later catch must not overwrite a renewed intent after the claim was released.
- Run the sweep twice against a permanently failing candidate.
- Assert the candidate is not re-selected on the second run, or that retries are
  explicitly bounded by a persisted/expiring marker.
- If the loop can call a dead target, include a test proving the dead-target
  path does not await the interactive timeout inside the control-loop critical
  path.
- For an alarm state that should terminate, run two alarm ticks and assert the
  first tick deletes or terminalizes durable state and the second tick does not
  re-arm or repeat work.
- For warning-or-worse resource-safety states, assert the existing
  operator-visible alert channel receives the alert. If cleanup candidates
  exhaust above target, assert both the explicit target-unreachable health state
  and the error-severity operator alert.
- For feedback-prone ingestion paths, prove both that the request logger omits
  the ingest edge and that downstream failures cache zero demand.
- For budgeted diagnosis/triage loops, prove budget exhaustion persists a
  retryable deferral, the candidate is skipped before refresh, retried after
  refresh, and is not counted against ordinary failure/rejection limits.
- For an alarm section, drive the real section scheduler and the sweep together in
  a loop, firing the sweep at each time the scheduler returns, and assert the exact
  sequence of fire times. A row the sweep skips while the scheduler keeps re-arming
  it then fails the test instead of passing every single-tick assertion.
- For a row blocked by another record (requirement 12), end the blocking state through
  its real transition without touching the blocked row, and assert the blocked row
  becomes due and runs (`tests/workers/project-event-wake-target-occupancy.test.ts`).

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
- [ ] Do warning-or-worse resource-safety states and target-unreachable remediation
      states reach an existing operator-visible alert channel with tests?
- [ ] Is the section's alarm computed from the same query and per-row next-check
      record its sweep uses, with every examined row pushed out before any await?

## References

- `.claude/rules/43-long-running-mcp-tools.md` — async boundaries for
  long-running VM work
- `.claude/rules/45-durable-object-concurrency-mutex.md` — DO `await`
  interleaving hazards
- `.claude/rules/35-vertical-slice-testing.md` — realistic cross-boundary tests

When cleanup reacts to a terminal task, test the real order in which a tool marks the task complete before the assistant finishes its response. Run both canonical-session and summary-index cleanup between completion and final-message persistence. Assert the remaining response is accepted, and separately prove stale completion protection expires. Task completion alone is not proof that the prompt stream has drained.
