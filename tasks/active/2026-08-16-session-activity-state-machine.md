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

- [ ] Shared: add `DEFAULT_SESSION_ACTIVITY_PROBE_TIMEOUT_MS`, `_MAX_ATTEMPTS`, `_MAX_CANDIDATES`
- [ ] DO migration `029-session-activity-reconciliation` (additive columns: `activity_source`,
      `activity_reason`, `activity_probe_at`, `activity_probe_attempts`)
- [ ] `session-state.ts`: `recordTurnEnd` (compare-and-set), probe-counter reset on working-state
      entry and on `markPromptAccepted`, expose reason/source in `getSessionState`
- [ ] New `session-activity-reconciliation.ts`: candidate selection (SQL only), probe classification,
      outcome application, bounded attempts + dead-target escape
- [ ] Wire probe into the ProjectData DO alarm via `ctx.waitUntil` (outside the critical path)
- [ ] Terminal writes fan out to all three consumers: broadcast, delivery nudge, idle-cleanup re-arm
- [ ] `reconcileStaleActivity` heal path also nudges deliveries + records `stale_no_evidence`
- [ ] DO RPC + `services/project-data.ts` wrapper: `recordSessionTurnEnd`
- [ ] `routes/chat.ts` cancel: capture `observedAt` before the VM call, record terminal transition
- [ ] Env docs: `apps/api/.env.example`, configuration reference
- [ ] Tests (each proven to fail pre-fix)

## Acceptance criteria

- [ ] A session whose `idle` report was lost after a turn end, with a live heartbeating ACP session,
      is reconciled to idle by the probe, and its idle cleanup arms
- [ ] A wedged-"prompting" session with a queued durable message delivers it after reconciliation
- [ ] A genuinely prompting session (host reports `prompting`) is **not** flipped by the probe
      (control case)
- [ ] The cancel path records a terminal transition even when the VM's `idle` report never arrives
- [ ] Probe never runs in the alarm's synchronous critical path; uses a short background timeout
- [ ] Every candidate leaves the candidate set (bounded attempts, dead-target terminalization)
- [ ] No hardcoded timeouts/limits; #1826 identity gates unchanged

## References

- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md` (liveness ≠ idleness)
- `.claude/rules/47-control-loop-io-budget.md` (tiered timeouts, candidate escape paths)
- `.claude/rules/49-capture-prerequisites-before-async-completion.md` (`observedAt` capture)
- `.claude/rules/31-migration-safety.md` (additive columns only)
