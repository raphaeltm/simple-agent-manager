# Scheduled Handlers: Isolate Every Step, and Never Use a Liveness Timestamp as an Idleness Signal

## When This Applies

Any **scheduled handler** (Cloudflare `scheduled()`, DO `alarm()`, cron sweep,
reconcile loop) that runs more than one independent unit of work, and any predicate
that decides whether something is **idle**, **stale**, **abandoned**, or **orphaned**.

## Why This Rule Exists

On 2026-08-05T20:25Z the 5-minute cron in `apps/api/src/index.ts` ran thirteen sweeps
as a flat sequence of bare `await`s. `runNodeCleanupSweep` began throwing; the handler
unwound; **every sweep after it was silently skipped**. Thirteen hours later:

- node reaping was dead, so nodes accumulated until the shared 10-server Hetzner
  account filled and staging deploys began failing with `403 server limit reached`
- **21 active USER cron triggers had not fired** (earliest `next_fire_at` five hours
  overdue) because `runCronTriggerSweep` sat downstream of the failure
- observability purge, trigger-execution cleanup, session-task repair, setup-session
  sweep, compose-artifact cleanup, compute-usage cleanup and trial expiry were all
  skipped on every single run

Nothing alerted, because **the only symptom was an absence of effects**. `cron.started`
still logged. No error was persisted. The sweeps simply stopped happening.

A previous change had already noticed the fragility and worked around it by
**reordering** one sweep — `// Recover stuck tasks first so unrelated cleanup failures
cannot suppress lifecycle repair`. Reordering protects whatever runs earliest and
nothing else, which is exactly what happened: stuck-task recovery kept working
perfectly while everything behind it stayed dead.

The same investigation found the orphan-node detector had **never fired once** in the
sweep's entire lifetime. Its predicate was `nodes.updated_at < now - grace`, and the
heartbeat writer rewrites `updated_at` on every beat — in production `updated_at` was
byte-identical to `last_heartbeat_at` on every running node. The predicate was
unsatisfiable for precisely the healthy-but-idle nodes it existed to catch. It could
only ever match a node that had already stopped heartbeating, i.e. one that was broken
rather than merely idle.

## Class of Bug

**A control loop that fails silently, where the symptom is an absence rather than an
error.** Two distinct sub-classes, both present above:

1. **Unisolated sequential steps** — one throwing step silently cancels every later
   step. Severity scales with how much work sits downstream, and the blast radius is
   invisible in logs.
2. **A liveness signal used as an idleness proxy** — `updated_at`, `last_seen_at`,
   `heartbeat_at`, or any column a keepalive path writes. A predicate built on one is
   satisfiable only when the subject is already dead, so the guard silently never fires.

## Hard Requirements

1. **Isolate every step of a multi-step scheduled handler.** Each unit of work runs in
   its own try/catch (or an isolator helper). A failure is contained, logged, and
   persisted durably; it must never prevent a later step from running. Do NOT rely on
   ordering — ordering is not isolation.

2. **A failed step must be distinguishable from an empty one.** Yield `undefined` (or an
   explicit failure marker) rather than a zero-valued result, so a crashed step cannot
   be misread in logs or metrics as "ran and found nothing".

3. **Surface failure counts in the completion log.** Emit the names of failed steps
   (e.g. `failedSweeps: [...]`) so a repeat is visible directly, not inferable only from
   missing downstream effects.

4. **The error handler must not be able to throw.** Persisting a failure record must be
   guarded — a failure while *recording* a failure must not abort the handler and
   reintroduce the very bug the isolation exists to prevent.

5. **Never build an idleness/staleness predicate on a column a keepalive path writes.**
   Before using any timestamp for "is this abandoned?", identify every writer of that
   column. If a heartbeat, health check, poll, or watchdog writes it, it measures
   liveness — pick a different signal (last *work* activity, a dedicated
   `last_activity_at`, or a derived `MAX()` over child rows) and document why.

5b. **A per-SET progress clock cannot bound a per-ITEM stale entry.** When an absolute
   ceiling is anchored on "the last real progress edge" but the reporter tracks a *set*
   of work items behind one shared timestamp, progress on any live item re-stamps the
   clock for every stale one. The ceiling then only fires when the whole set goes quiet
   — precisely never, for an active session. This is rule 5 one level in: the clock is a
   genuine progress signal, it just answers a question about the set rather than the
   item you are asking about. Either track progress per item, or make the *reporter*
   responsible for evicting entries it can no longer vouch for at a boundary it knows is
   authoritative, and name that boundary in a comment. Ask, for every capped/leased set:
   "what removes an entry that never reports a terminal state?" — if the only answer is
   process death, the ceiling is decorative. This was found pre-merge in PR #1874: ACP
   tool calls orphaned by an interrupt stayed in the tracked set forever, and every later
   tool call in every later turn pushed the 30-minute ceiling out again
   (`reconcileHarnessWorkAtPromptTurnEnd` is the fix; the Claude adapter's
   `background_tasks_changed` wholesale-replace was the pre-existing prior art that the
   new reporter had not reproduced).

6. **Precondition deferrals must not consume destructive retry budgets or leave immortal retry
   states.** A lifecycle loop may discover work before a later runtime event makes it safe (for
   example, task completion is recorded before the completing prompt reports idle, or a final
   snapshot is still pending/degraded). Persist an intent/deadline, defer without incrementing the
   bounded snapshot/teardown attempt counter, and ensure every persisted retry state remains in the
   selector or has a separate bounded reconciler. Do not require a prerequisite that the attempted
   operation itself is responsible for producing.

## Required Tests

- **Isolation regression:** a throwing step must not prevent later steps from running.
  Assert execution order across the failure, and assert the failed step's result is
  distinguishable from a zero result.
- **Error-handler resilience:** make the failure-recording path itself throw and assert
  the handler still continues.
- **Idleness-signal immunity:** seed a subject whose liveness column is CURRENT but
  whose real activity is old, and assert the guard fires. This test MUST fail against
  the liveness-based predicate — verify that once before relying on it.
- **Deferred-prerequisite convergence:** start from pending, degraded, and missing prerequisite
  state; run two sweeps; assert the first persists a due intent without spending an attempt and the
  next eligible sweep claims it. A terminal or precondition-failed row must not disappear from all
  candidate selectors.
- Both tests must be proven discriminating: confirm they go red when the isolation or
  the corrected signal is removed.

## Quick Compliance Check

Before merging a change to a scheduled handler or an idleness predicate:
- [ ] Every step is individually isolated; no bare `await` of a fallible unit of work
- [ ] A failed step yields `undefined`/a marker, never a zero-valued result
- [ ] The completion log names failed steps
- [ ] The failure-recording path cannot itself abort the handler
- [ ] No idleness predicate reads a column any keepalive path writes
- [ ] Every leased/capped set has a named answer to "what evicts an entry that never
      reports a terminal state?", and it is not process death
- [ ] Precondition deferrals preserve the destructive retry budget and remain durably selectable
- [ ] Discriminating regression tests exist for both the isolation and the signal

## References

- `.claude/rules/47-control-loop-io-budget.md` — bounded candidate sets, tiered
  timeouts, candidate escape paths (the likely trigger of the throw here)
- `.claude/rules/51-server-side-node-class-gates.md` — role/class gates on destroy paths
- `.claude/rules/39-debug-before-redesign.md` — this outage was found by tracing the
  existing path, not by redesigning it
- Implementation: `apps/api/src/scheduled/sweep-isolation.ts`,
  `apps/api/src/scheduled/node-cleanup/shared.ts` (`LAST_WORKSPACE_ACTIVITY_SQL`)
- Task: `tasks/archive/2026-08-06-fix-node-reaping-orphan-reconciliation.md`
