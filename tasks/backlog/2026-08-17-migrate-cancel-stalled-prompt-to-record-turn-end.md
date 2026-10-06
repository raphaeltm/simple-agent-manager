# Migrate `cancelStalledPrompt` onto `recordTurnEnd` / `publishTurnEnd`

**Source:** task-completion-validator finding (MEDIUM) during the session-activity
state machine PR. Related: `.claude/rules/57-write-only-cross-boundary-state.md`,
`.claude/rules/44-dual-write-migration-enumerate-writers.md`,
`tasks/archive/2026-08-16-session-activity-state-machine.md`.

## Problem

`.claude/rules/57` requires that every terminal activity transition route through
one write helper and one consumer fan-out, so no consumer can be forgotten. The
session-activity state machine established those (`session-state.ts:recordTurnEnd`
and `session-activity-reconciliation.ts:publishTurnEnd`) and migrated the probe,
cancel and heal paths onto them — but **one pre-existing writer was not migrated**.

`apps/api/src/durable-objects/project-data/reconciliation.ts:cancelStalledPrompt`
(task-mode reconciliation's 409 stale-mirror repair) still does:

```ts
upsertActivityState(sql, candidate.acpSessionId, { activity: 'idle' });
broadcastEvent('session.activity', { ... }, candidate.sessionId);
```

Consequences for a task-mode session repaired via that specific path:

1. **Provenance is wrong.** `activity_source` falls back to `vm_report` and
   `activity_reason` to `completed`, when the transition was actually observed by
   the control plane after a cancel. The new columns are therefore not reliable
   for this path.
2. **Queued durable messages are not released.** `nudgePromptDeliveriesForTarget`
   is never called, so a message queued behind the stall waits for its existing
   backoff `next_attempt_at` to elapse instead of being delivered immediately — a
   milder recurrence, for task mode, of the delivery-gate bug the state machine
   was built to fix.
3. **Idle cleanup is not re-armed** for that session at the transition.

This is **pre-existing behaviour** — the state-machine PR did not introduce or
worsen it — which is why it was deferred rather than fixed inline: migrating it
changes task-mode reconciliation semantics (deliveries would newly fire at repair
time) and so needs its own regression coverage, in a lifecycle path that PR #1839
had just modified.

## Why this is not just cosmetic

Rule 57's whole thesis is that a fan-out with more than one writer eventually
diverges. Leaving a second writer in place means the next person adding a consumer
to `publishTurnEnd` will silently not get it for this path.

## Acceptance criteria

- [ ] `ReconciliationProcessingHooks` carries `nudgeDeliveries`, `armIdleCleanup`
      and `recalculateAlarm` (the ProjectData DO caller at
      `project-data/index.ts:833` already has all three — it passes them to
      `probeStaleSessionActivity`).
- [ ] `cancelStalledPrompt`'s 409 branch calls `recordTurnEnd` with
      `reason: 'cancelled'`, `source: 'control_plane'` and an `observedAt`
      captured **before** the `cancelAgentSessionOnNode` call (`.claude/rules/49`),
      then `publishTurnEnd` — replacing the direct `upsertActivityState` + manual
      broadcast.
- [ ] Regression test: a task-mode session with a queued durable message, repaired
      via the 409 branch, has the message released and its idle cleanup armed.
      Must be verified to FAIL on the pre-migration code.
- [ ] Regression test: the repaired row records `activity_source='control_plane'`
      and `activity_reason='cancelled'`.
- [ ] CAS control: a prompt that starts after the captured `observedAt` is not
      stomped by the late repair.
- [ ] Remove the "NOT YET UNIVERSAL" caveat from the `recordTurnEnd` doc comment
      in `session-state.ts` once this lands.
- [ ] Grep for any remaining direct `upsertActivityState(..., { activity: 'idle' })`
      writers and either migrate or explicitly track them (`.claude/rules/44` —
      enumerate every writer).
