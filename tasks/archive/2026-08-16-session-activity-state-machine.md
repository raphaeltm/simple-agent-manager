# Reconciled session activity state machine (probe-backed staleness + turn-end transitions)

**SAM idea:** `01M0644866Q0000M4HP39WNCZW`
**Related:** PR #1826 (idle-cleanup terminalization identity gates — must not be weakened), PR #1779/#1839 (exactly-once force-stop completion)

## Problem

"Is this session mid-prompt" (`session_state.activity`) is effectively write-only from the VM
side. Three consumers read it and all three break together when the state wedges:

- (a) stop-button / status UI — `routes/chat-agent-state.ts` + `session.activity` broadcast
- (b) durable-message delivery — `prompt-delivery.nudgePromptDeliveriesForTarget` only fires on a
  VM `idle` report (`durability-foundation.reportActivity`), so a wedged "prompting" session never
  releases its queued messages
- (c) idle/sleep scheduling — `services/session-sleep.ts:isActivitySafeForSleep` refuses to sleep a
  `prompting` session, so a wrongly-active session gets no idle timer and leaks to the 45-min/24-h
  backstops

Live incident (2026-08-16, session `36a5bb77-2746-43c1-8669-030b51b8f36d`): the turn ended ~16:15Z;
the control plane still reported "active" at 20:21Z (4h+). The preceding turn ended via a user
tool-call interruption ~16:05Z.

## Research findings

1. **A staleness heal already exists but is structurally unable to fire for a live-but-idle
   session.** `session-state.ts:reconcileStaleActivity` blocks the heal when
   `acp_sessions.status IN ('running','started') AND COALESCE(last_heartbeat_at, updated_at, …) >= cutoff`.
   The vm-agent heartbeats regardless of whether a prompt is in flight, so **liveness is being used
   as a proxy for turn-in-flight** — exactly the anti-pattern in `.claude/rules/53`. For any awake
   session the heal predicate is unsatisfiable, which is why the wedge lasted 4 hours.
   → **Fix:** stale + no-progress means *unproven*, not *trusted*. Probe the authoritative source.

2. **The authoritative probe already exists and needs no vm-agent change.**
   `GET /workspaces/{workspaceId}/agent-sessions`
   (`packages/vm-agent/internal/server/workspaces.go:handleListAgentSessions`) enriches each session
   with `hostStatus` = live `SessionHost.Status()` (`prompting` while a prompt is in flight).
   `services/node-agent.ts:listAgentSessionsOnNode` already calls it. → rules 54/27 do not apply.

3. **Control-plane turn endings do not write a terminal transition.**
   `routes/chat.ts POST /:sessionId/cancel` forwards the cancel to the VM and returns; nothing
   records the terminal activity transition, so a lost VM `idle` report after a cancel wedges the
   state indefinitely (`.claude/rules/49` class). `reconciliation.ts:cancelStalledPrompt` does
   repair the mirror on 409, but reconciliation only runs for **task-mode** sessions — conversation
   mode (the incident) is explicitly excluded.

4. **The DO alarm already performs VM-agent I/O via a short background timeout**
   (`reconciliation-thresholds.ts:reconciliationNodeCallTimeoutMs`, target resolved by
   `resolveWorkspaceDeliveryTarget` from D1). Rule 47 requires the probe stay out of the alarm's
   synchronous critical path → run it via `ctx.waitUntil` after cheap SQL candidate selection, with
   a bounded attempt counter so every candidate leaves the candidate set.

5. **`session_state` has no provenance or probe-attempt columns.** Latest DO migration is
   `028-idle-cleanup-attention-state`; `029` is free. Additive `ALTER TABLE ADD COLUMN` only
   (`.claude/rules/31`).

## Design

One authoritative reconciled state, written from both ends, with an explicit terminal-transition
reason recorded on the row (`activity_reason` ∈ `completed | cancelled | force_stopped | dead |
probe_reconciled | stale_no_evidence`) and provenance (`activity_source` ∈ `vm_report |
control_plane | probe`). The `activity` vocabulary itself is unchanged (no persisted-enum widening
across UI/schema, per rule 31) — `idle` remains the terminal not-prompting state and the *reason*
carries the transition identity.

- **`recordTurnEnd(sql, sessionId, { reason, source, observedAt })`** — the single terminal-write
  helper. Compare-and-set: only flips a row that is still in a working state and whose
  `activity_at <= observedAt`, so a prompt that started *after* the observation is never stomped
  (rule 49 — `observedAt` is captured before the long VM call, not read back at handler time).
  Clears `prompt_started_at` / `prompt_epoch`, resets probe counters.
- **Probe reconciliation** — alarm selects stale working-state candidates in SQL only, then
  `waitUntil`s a bounded probe of each candidate's node:
  - host reports `prompting`/`recovering` → refresh `activity_at` (genuine turn — never flipped)
  - host reports anything else, or the session is absent from the node's list → `recordTurnEnd`
    with reason `probe_reconciled`
  - probe unreachable → increment `activity_probe_attempts`; after
    `SESSION_ACTIVITY_PROBE_MAX_ATTEMPTS` consecutive failures the target is treated as dead and
    the row is terminalized with reason `dead` (escape path, rule 47 #3)
- **All three consumers** are served by routing every terminal write through one path that
  broadcasts `session.activity`, nudges queued prompt deliveries, and re-arms idle cleanup.
- **Cancel path** — `POST /:sessionId/cancel` records the terminal transition (reason `cancelled`)
  on both success and 409-no-prompt-in-flight.

New env knobs (all `DEFAULT_*` constants in `packages/shared`, Constitution XI):
`SESSION_ACTIVITY_PROBE_TIMEOUT_MS` (5s — background, not the interactive 30s),
`SESSION_ACTIVITY_PROBE_MAX_ATTEMPTS` (3), `SESSION_ACTIVITY_PROBE_MAX_CANDIDATES` (10).
Existing `SESSION_ACTIVITY_STALE_THRESHOLD_MS` is reused as the staleness bound.

## Implementation checklist

- [x] Shared: add `DEFAULT_SESSION_ACTIVITY_PROBE_TIMEOUT_MS`, `_MAX_ATTEMPTS`, `_MAX_CANDIDATES`
- [x] DO migration `029-session-activity-reconciliation` (additive columns: `activity_source`,
      `activity_reason`, `activity_probe_at`, `activity_probe_attempts`)
- [x] `session-state.ts`: `recordTurnEnd` (compare-and-set), probe-counter reset on working-state
      entry and on `markPromptAccepted`, expose reason/source in `getSessionState`
- [x] New `session-activity-reconciliation.ts`: candidate selection (SQL only), probe classification,
      outcome application, bounded attempts + dead-target escape
- [x] Wire probe into the ProjectData DO alarm via `ctx.waitUntil` (outside the critical path)
- [x] Terminal writes fan out to all three consumers: broadcast, delivery nudge, idle-cleanup re-arm
- [x] `reconcileStaleActivity` heal path also nudges deliveries + records `stale_no_evidence`
- [x] DO RPC + `services/project-data.ts` wrapper: `recordSessionTurnEnd`
- [x] `routes/chat.ts` cancel: capture `observedAt` before the VM call, record terminal transition
- [x] Env docs: `apps/api/.env.example`, configuration reference
- [x] Tests (each proven to fail pre-fix)

## Acceptance criteria

- [x] A session whose `idle` report was lost after a turn end, with a live heartbeating ACP session,
      is reconciled to idle by the probe, and its idle cleanup arms
- [x] A wedged-"prompting" session with a queued durable message delivers it after reconciliation
- [x] A genuinely prompting session (host reports `prompting`) is **not** flipped by the probe
      (control case)
- [x] The cancel path records a terminal transition even when the VM's `idle` report never arrives
- [x] Probe never runs in the alarm's synchronous critical path; uses a short background timeout
- [x] Every candidate leaves the candidate set (bounded attempts, dead-target terminalization)
- [x] No hardcoded timeouts/limits; #1826 identity gates unchanged

## Deliberate scope decisions

- **`activity='error'` is NOT probe-reconciled.** `WORKING_ACTIVITIES` covers only
  `prompting`/`recovering`. Clearing an `error` state erases user-visible error context, so it
  is a product decision rather than a reliability fix. Tracked in
  `tasks/backlog/2026-08-16-probe-reconcile-wedged-error-activity.md` (rule 42).
- **Per-candidate D1 reads are sequential, not batched.** Each candidate costs one workspace
  lookup plus one node-runtime lookup inside `fetchNodeAgent`. Bounded by
  `SESSION_ACTIVITY_PROBE_MAX_CANDIDATES` (10) and matching the existing `reconciliation.ts`
  pattern; parallelising was judged not worth the added concurrency surface here.

## Control-loop load review (rule 47)

- **Expected candidate volume:** near zero in steady state — a candidate requires a working
  state older than `SESSION_ACTIVITY_STALE_THRESHOLD_MS` (5 min) with no message progress in
  that window. Hard-capped at `SESSION_ACTIVITY_PROBE_MAX_CANDIDATES` (10) per pass.
- **Worst-case per-candidate cost:** two D1 reads plus one vm-agent HTTP call bounded by
  `SESSION_ACTIVITY_PROBE_TIMEOUT_MS` (5 s) — a background budget, not the interactive 30 s.
  Worst case per pass ≈ 50 s, entirely inside `ctx.waitUntil`, never on the alarm's
  synchronous critical path.
- **Tiered timeout:** yes — dedicated `SESSION_ACTIVITY_PROBE_TIMEOUT_MS`, separate from
  `NODE_AGENT_REQUEST_TIMEOUT_MS`.
- **Candidate escape path:** every candidate exits — reconciled (`probe_reconciled`),
  refreshed (`working`), or terminalized (`dead`) once `SESSION_ACTIVITY_PROBE_MAX_ATTEMPTS`
  consecutive probes fail. A claim lease on `activity_probe_at` stops overlapping passes from
  double-probing or burning the attempt budget in one instant.

## Continuation review round 2 (findings the first review missed)

The first agent's workspace was destroyed before it opened a PR (see the anti-reap
incident below). On re-running the specialist reviewers against the final tree, the
cloudflare-specialist found two real defects the first round had missed. Both are
fixed here, each with a regression test proven to fail on the pre-fix code.

- **[HIGH] `computeSessionActivityProbeAlarmTime` ignored the probe lease → DO alarm
  busy-loop.** The scheduler scanned only `MIN(activity_at)`, never `activity_probe_at`.
  For a genuinely wedged session — the exact population this feature exists to fix —
  `earliest + threshold` is always `<= now`, so the alarm re-armed to `now` on every
  tick. The SELECT correctly returned zero candidates (the lease held), but the DO had
  already re-armed, so the **entire** alarm handler (heartbeat timeouts, idle cleanup +
  its D1/NodeLifecycle RPCs, reconciliation, attention expiry, mailbox sweep, prompt
  delivery) re-ran in a tight loop for the whole reconciliation episode — silently,
  because the 0-candidate fast path skips the sweep log. A `.claude/rules/47` / `55`
  violation, and the `Math.max(next, now + minAlarmDelayMs)` clamp that prevents it
  already existed twice in this codebase (`reconciliation.ts:729`,
  `diagnosis-runner.ts:182`) but was not carried over.
  → Fixed by scanning `MIN(MAX(activity_at + threshold, COALESCE(activity_probe_at,0) +
  leaseMs))` — a row is next due at the LATER of its staleness bound and its lease
  expiring — plus the same `minReconciliationAlarmDelayMs` floor (existing env knob;
  no new configuration). Test: `respects an outstanding probe lease instead of
  re-arming to now` (pre-fix returns exactly `now`).

- **[MEDIUM] The `unreachable` attempts bump had no compare-and-set.** It was the only
  write path in the module without one. A stale `unreachable` outcome — whose probe was
  still in flight while the turn ended and a new prompt epoch began — charged an attempt
  against that new epoch, which resets `activity_probe_attempts` to 0 on every
  authoritative write. `recordTurnEnd`'s own CAS still prevented the live prompt being
  terminalized, so the only effect was a silently reduced retry budget — invisible, but
  a real break in the module's otherwise-uniform CAS discipline.
  → Fixed by scoping the UPDATE with the same `activity IN (WORKING_ACTIVITIES) AND
  activity_at <= observedAt` guard as the other two branches. Test: `does not charge an
  attempt against a newer prompt epoch` (pre-fix records 1).

- **[LOW] Cancel-path failure log bypassed the sanitizing helper.** `chat.ts` logged a
  raw `err.message` instead of `serializeError(err)`, the only place in the file doing
  so. Not exploitable (no credential flows through `recordSessionTurnEnd`, and it is a
  server-side structured log never returned to the caller), but inconsistent with the
  convention. → Fixed.

- **[LOW, accepted] `recordTurnEnd`'s CAS uses `<=` not `<`.** Required for the common
  no-change case where the row's own `activity_at` equals the captured observation
  exactly. A same-millisecond collision would be unprotected, but `observedAt` is always
  a server `Date.now()` or a DB-read `activity_at` — no client-controlled clock reaches
  this path. Accepted as designed.

## References

- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md` (liveness ≠ idleness)
- `.claude/rules/47-control-loop-io-budget.md` (tiered timeouts, candidate escape paths)
- `.claude/rules/49-capture-prerequisites-before-async-completion.md` (`observedAt` capture)
- `.claude/rules/31-migration-safety.md` (additive columns only)

## Post-mortem

**What broke.** Session `36a5bb77-2746-43c1-8669-030b51b8f36d` reported `prompting` for
four hours after its turn ended at 16:15Z on 2026-08-16. The red stop button stayed on
screen, the sleep scheduler refused to sleep the session (leaking toward the 45-min/24-h
backstops), and — in the same session earlier that day — a durable message sat in
`retry_wait` with "Target VM is currently processing a prompt" while nothing was in flight.

**Timeline (2026-08-16, all times UTC).**

| Time | Event |
| --- | --- |
| ~16:05Z | Preceding prompt turn ends via a user tool-call interruption — the historically lossy path for lifecycle accounting (rule 49 class). |
| ~16:15Z | The agent's turn genuinely ends; the final assistant message is delivered to chat. The VM's `idle` activity report never lands. |
| 16:15Z–20:21Z | The wedge persists for 4h06m. Red stop button stays visible; the sleep scheduler refuses to sleep the session so it gets no idle timer; earlier the same day durable message `01M04PF2K8VT50HBWX9748H75N` sat in `retry_wait` (deliveryAttempts=4) with "Target VM is currently processing a prompt". |
| 20:21Z | User liveness ping is delivered as a normal prompt **without** tapping stop — proving the harness had returned control and the session was idle-and-receptive the whole time. Divergence confirmed. |
| 20:27Z | Incident captured as SAM idea `01M0644866Q0000M4HP39WNCZW`. |
| 21:11–21:36Z | While the fix was being implemented, production reaped two chat-quiet-but-working task workspaces — including this branch's own author (task `01M064TAJ7B0AX8G115CY85RXM`, terminalized 21:36:06Z, `workspace_deleted`). Captured as idea `01M069W82V937G67WGG1E93937`; this PR is the continuation. |

The bug was not "introduced" by a single commit — the heal added in DO migration `021` was **never able to fire** for an awake session, so the gap existed from the moment the heal was written. It only became visible when a turn ended abnormally and the report was lost.

**Root cause.** `session_state.activity` was write-only from the VM side. The staleness
heal that existed (`session-state.ts:reconcileStaleActivity`, migration `021`) refused to
heal while the ACP session was heartbeating — and a vm-agent heartbeats whether or not a
prompt is in flight. For any awake session the heal predicate was unsatisfiable, so the
only thing that could clear a working state was the VM's own `idle` report. When that
report was lost (the suspected trigger here was a user tool-call interruption at ~16:05Z;
these callbacks also 401'd silently for months per rule 34), the state wedged permanently.

**Class of bug.** Write-only cross-boundary state with a fan-out of consumers and no
reconciliation — compounded by the rule-53 trap of standing a liveness signal in for an
idleness signal. Each component was individually correct; the system was still wrong, and
one dropped report broke three consumers at once in opposite directions.

**Why it wasn't caught.** The heal had tests, but all of them seeded a *dead* session —
none seeded the live-but-idle population the guard was actually meant to catch, so the
unsatisfiable predicate never showed up as a failure. No test covered a control-plane
turn ending (cancel) recording anything at all, because the code recorded nothing.

**Process fix.** `.claude/rules/57-write-only-cross-boundary-state.md` — requires both-ends
writes, a staleness bound, probing the authority instead of a proxy, single-point consumer
fan-out, pre-call observation capture with a CAS guard, and specifically requires a
live-but-idle wedge test plus a genuinely-working control case.
