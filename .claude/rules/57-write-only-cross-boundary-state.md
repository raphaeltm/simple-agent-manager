# Cross-Boundary State With Multiple Consumers Must Be Reconciled, Not Just Reported

## When This Applies

Any control-plane value that answers a question about **another process's current
internal state** — "is this agent mid-prompt", "is this container still building",
"does this node still hold the lock" — where:

1. the remote side is, or historically was, the only writer (it _reports_; we
   _store_), and
2. more than one consumer branches on the stored value.

The canonical example is `session_state.activity` in the ProjectData DO. The
vm-agent's `reportActivity` callbacks are the authority for remote work
inventory, while the control plane also records transitions it positively
observes, including accepted prompt epochs and identity-fenced turn ends. The
value is read by the stop-button UI, durable-message delivery gating, and
idle/sleep scheduling.

## Why This Rule Exists

On 2026-08-16 session `36a5bb77-2746-43c1-8669-030b51b8f36d` reported `prompting`
for **four hours** after its turn ended at 16:15Z. All three consumers failed
together and in different directions:

- the red stop button stayed on screen for a session that was idle and receptive
- a durable message sat in `retry_wait` with "Target VM is currently processing a
  prompt" while nothing was in flight
- the sleep scheduler refused to sleep the session, so it never got an idle timer
  and leaked toward the 45-min / 24-h backstops (real compute cost)

There _was_ a SQL-only staleness heal. It was unsafe in both directions. A fresh
ACP heartbeat kept a truly wedged mirror alive because heartbeats prove process
liveness, not prompt work; a stale heartbeat let the same heuristic erase a
real long-running prompt. The control plane cannot infer either `working` or
`not_working` from its own stale mirrors. The suspected lossy path was a
cancel/interrupt turn ending, which wrote nothing on the control-plane side.

## Class of Bug

**Write-only remote state with a fan-out of consumers and no reconciliation.**
Every individual piece works: the agent reports correctly, the store persists
correctly, each consumer reads correctly. The system is still wrong, because a
single dropped report is permanent and its blast radius is every consumer at
once. Lost callbacks are not hypothetical here — these same callbacks 401'd
silently for months (rule 34) while logging at Debug (rule 39).

## Hard Requirements

1. **Both ends write.** Any transition the control plane can observe for itself
   must be recorded by the control plane, not left to the remote report alone.
   A user-initiated cancel, a force-stop, a terminal task transition, and the
   persistence of a final assistant message are all first-class turn-end
   evidence. Route every terminal write through ONE helper so a new path cannot
   record a partial transition.

2. **State older than a staleness bound is unproven, not false.** Pick an
   env-configurable bound with a `DEFAULT_*` constant. Past it, with no progress
   evidence, the stored value triggers an authority probe; age alone must never
   manufacture a terminal transition.

3. **Reconcile by probing the authority, not by inferring from a proxy.** Ask the
   process that actually owns the state. Prefer an endpoint that already exists
   on deployed agents so no rollout is coupled to the fix (rule 54). The probe is
   a background control-loop call: short env-configurable timeout, bounded
   candidates per pass, off the alarm's synchronous critical path, and every
   candidate gets an escape path (rule 47). Only a reachable, well-formed,
   identity-matched response may end a turn. Timeout, transport error, malformed
   inventory, a missing identity, duplicate identity, or workspace mismatch is
   inconclusive—not terminal evidence.

4. **Bounded silence quarantines; it does not terminalize.** After the configured
   attempt budget, saturate/back off the row outside the hot candidate set and
   emit an alert/activity event. Preserve the working mirror and any possible
   in-flight work. A later authoritative activity report resets quarantine.

5. **A probe that confirms the working state must refresh it.** Otherwise a
   legitimately long turn is re-probed on every tick and, worse, invites a
   heuristic that would eventually flip it. Positive proof is evidence too.

6. **Every consumer reads the reconciled value, and a terminal transition fans
   out to all of them in one place.** If the fan-out lives in each consumer, the
   next consumer added inherits the bug. Put broadcast + queue release + timer
   re-arm behind a single `publishTurnEnd`-style function.

7. **Capture the observation instant before the slow call** and compare-and-set
   against it (rule 49). A prompt that started after you observed the ending
   belongs to a newer turn and must never be stomped.

## Required Tests

- **The wedge, reproduced**: remote state stale, remote process alive and
  heartbeating. Assert local mirrors cannot heal it and that a reachable,
  well-formed authoritative `not_working` response reconciles it.
- **Every consumer**: one test per consumer proving it observes the transition —
  not just that the stored value changed.
- **The control case**: the remote process genuinely IS working. Assert it is NOT
  flipped. Without this, an over-eager reconciler silently kills live turns.
- **Bounded escape**: run the sweep through its configured budget against a
  permanently unreachable target; assert it leaves the hot candidate set via
  quarantine without changing activity, publishing turn-end, or creating a
  failure-capable marker.
- **Malformed/identity ambiguity**: malformed entries, missing/duplicate session
  IDs, and workspace mismatches remain inconclusive and follow quarantine.
- **CAS discrimination**: a newer working state started after the observation
  instant is not stomped. Verify this test fails when the `<= observedAt`
  predicate is deleted.

## Quick Compliance Check

- [ ] Control-plane-observable transitions are written by the control plane too
- [ ] All terminal writes go through one helper; all consumers through one fan-out
- [ ] Staleness bound + probe timeout + candidate cap are env-configurable `DEFAULT_*`
- [ ] The probe asks the authority; only a matched, well-formed answer may end work
- [ ] Unreachable/malformed/ambiguous cases quarantine after a bound without terminalizing
- [ ] A confirmed working state refreshes rather than re-queues
- [ ] Observation instant captured pre-call; CAS guard proven discriminating

## References

- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md` — liveness ≠ idleness
- `.claude/rules/47-control-loop-io-budget.md` — tiered timeouts, candidate escape paths
- `.claude/rules/49-capture-prerequisites-before-async-completion.md` — pre-call capture
- `.claude/rules/34-vm-agent-callback-auth.md` — why these reports go missing
- Implementation: `apps/api/src/durable-objects/project-data/session-activity-reconciliation.ts`
- Task: `tasks/active/2026-08-16-session-activity-state-machine.md`
