# Push wake progress over the ProjectData DO socket + phase-level wake banner

Finishes idea `01M0D1WSZ1TD6ZE2YYE268SEHV`. PR #1865 (`3eda6c93a`) shipped the
navigation-persistence half; this task covers the two remaining halves plus the
visual audit that #1865 skipped.

## Problem

When a sleeping VM session wakes, the user gets a single static banner —
`"Waking and restoring session..."` (`project-message-view/index.tsx:583`) — and it
is delivered **pull-only**:

1. **No push.** `claimSessionSnapshotRecovery` (`session-snapshot-recovery-lifecycle.ts:147`)
   writes `session_snapshots.recovery_status='waking'` to **D1**. The ProjectData DO's
   `getSessionState()` reads **DO-local SQLite**, so the DO has no view of that row and
   never broadcasts it. The client only learns of wake transitions on mount-hydrate or
   on the fallback poll (`useSessionLifecycle.ts:509`), so the banner lags a poll
   interval behind reality.
2. **No phases.** A VM wake takes ~6 minutes. One static string cannot distinguish
   "provisioning a server" from "hung", which is the exact confusion that caused
   duplicate task dispatch (see the idea's own history).
3. **No visual audit.** PR #1865 touched `apps/web/` with no Playwright audit; rule 17
   requires mobile + desktop coverage.

## Research findings

### The phase signal already exists — do not invent one (rule 59)

- `TASK_EXECUTION_STEPS` (`packages/shared/src/types/task.ts:55`) already enumerates
  exactly the wake phases: `node_selection`, `node_provisioning`, `node_agent_ready`,
  `workspace_creation`, `workspace_dispatch`, `workspace_ready`, `attachment_transfer`,
  `agent_session`, `running`, `awaiting_followup`.
- `EXECUTION_STEP_LABELS` (`task.ts:75`) and `EXECUTION_STEP_ORDER` (`task.ts:91`)
  already exist. Labels are task-oriented ("Finding a server..."), so wake needs its own
  label map — but the *step vocabulary and ordering* are reused verbatim.
- A waking session's phase is the **recovery task's** `tasks.execution_step`, reachable
  via `session_snapshots.recovery_task_id` (`schema.ts:1217`). **No new column, no
  migration.**

### The push choke point already exists

- `updateD1ExecutionStep` (`task-runner/index.ts:319-335`) is the **single** place every
  step transition is written to D1, and it already loads `currentState` from DO storage
  and is already idempotency-guarded (`currentState.lastD1Step`), so a broadcast added
  there fires exactly once per real transition.
- Recovery tasks are identified by `state.config.resumeSnapshotChatSessionId`
  (`task-runner/types.ts:109`, set at `session-recovery.ts:492`). Non-recovery tasks have
  it `null` — this is the discriminator that keeps normal task runs from broadcasting.
- ProjectData DO already has `broadcastEvent(type, payload, sessionId)` and already emits
  `session.activity` (`durability-foundation.ts:114`), which the client already consumes
  (`useSessionReducer.ts:68`). A new `session.wake_progress` event is additive and follows
  the established pattern.
- TaskRunner currently has **no** `PROJECT_DATA` reference — this task adds the first one.

### Durable-store decision

D1 stays the source of truth (`session_snapshots.recovery_status` + the recovery task's
`execution_step`). The WS push carries only *live* deltas; hydrate-on-mount continues to
rebuild from D1. This means **no DO SQLite migration** (rule 31 / do-migration-safety) and
no new D1 column.

### File-size constraints (rule 18)

Several touch targets are already large. All **new logic goes in new small modules**;
edits to oversized files are thin delegations only:

| File | Lines | Plan |
|---|---|---|
| `project-data/index.ts` | 1643 | thin RPC delegate → new `project-data/session-wake-progress.ts` |
| `useSessionLifecycle.ts` | 798 | extract → new `useWakeProgress.ts` (would breach 800) |
| `project-message-view/index.tsx` | 785 | extract → new `WakeProgressBanner.tsx` |
| `routes/chat.ts` | 738 | extract → new `routes/chat/wake-state.ts` |

## Implementation checklist

### Shared types
- [ ] Add `WAKE_PHASE_LABELS: Record<TaskExecutionStep, string>` + `wakePhaseLabel()` helper
      in `packages/shared/src/types/task.ts` (wake-specific wording: provisioning →
      restoring → starting agent). Export from `types/index.ts`.
- [ ] Add `wakePhase?: TaskExecutionStep | null` to `SessionStateSnapshot`
      (`packages/shared/src/types/session.ts`).

### API — hydration (pull path, survives navigation)
- [ ] New `apps/api/src/routes/chat/wake-state.ts`: resolve `{recoveryStatus, wakePhase}`
      for a sleeping session in **one** D1 query (join `session_snapshots` →
      `tasks.execution_step` via `recovery_task_id`), replacing the existing standalone
      snapshot query so the endpoint's round-trip count does not increase (rule 60).
- [ ] Rewire `chat.ts:325-345` to call it. Preserve the existing non-fatal
      `chat.recovery_status_lookup_failed` warn-and-continue behavior (rule 50).

### API — push path (ProjectData DO)
- [ ] New `apps/api/src/durable-objects/project-data/session-wake-progress.ts`:
      `publishSessionWakeProgress(hooks, {chatSessionId, recoveryStatus, wakePhase})` →
      `broadcastEvent('session.wake_progress', {...}, chatSessionId)`.
- [ ] Thin RPC method on the DO delegating to it.

### API — TaskRunner emits transitions
- [ ] In `updateD1ExecutionStep`, after the D1 write, when
      `currentState.config.resumeSnapshotChatSessionId` is set, publish the wake phase to
      ProjectData. **Best-effort**: wrapped in try/catch, failure logged not thrown — a
      broadcast must never fail a wake (rule 47: off the critical path).
- [ ] Emit a terminal `recoveryStatus` publish when wake completes so the banner clears
      without waiting for a poll.
- [ ] Env-configurable timeout constant for the broadcast call (`DEFAULT_*`, Principle XI).

### Web
- [ ] `SessionStateSnapshot` client type gains `wakePhase` (`lib/api/sessions.ts`).
- [ ] `useSessionReducer.ts`: handle `session.wake_progress`.
- [ ] New `useWakeProgress.ts`: owns wake phase state; hydrates from server snapshot,
      updates from WS; clears on wake completion.
- [ ] New `WakeProgressBanner.tsx`: spinner + phase label + elapsed time.
- [ ] Wire into `project-message-view/index.tsx`, replacing the static banner.

### Tests
- [ ] Shared: label map covers every `TaskExecutionStep` (exhaustiveness).
- [ ] API: wake-state resolver returns phase; missing/failed lookup degrades to null, not 500.
- [ ] API: **discriminating** — TaskRunner broadcasts for a recovery task and does **NOT**
      broadcast for a normal task (assert zero calls).
- [ ] API: broadcast failure does not fail the step transition.
- [ ] Web: reducer maps the event; `useWakeProgress` hydrates + live-updates; banner renders
      the phase label and clears on completion.
- [ ] Playwright visual audit, 375px + 1280px, with `assertNoOverflow` (rule 56).

## Acceptance criteria

- [ ] Wake banner updates from a WS push, not only from the poll
- [ ] Banner shows the current phase ("Setting up a new server..." → "Restoring your
      session..." → "Starting AI agent...") rather than one static string
- [ ] Banner still survives navigate-away-and-back (no regression of PR #1865)
- [ ] Banner clears when wake completes
- [ ] A normal (non-recovery) task run produces **no** wake broadcasts
- [ ] A broadcast failure never fails a wake
- [ ] No new D1 or DO migration; endpoint round-trip count not increased
- [ ] Mobile (375px) and desktop (1280px) audited, no horizontal overflow

## References

- Idea `01M0D1WSZ1TD6ZE2YYE268SEHV`; prior PR #1865, PR #1862
- `.claude/rules/59-understand-before-adding.md` — reuse `TASK_EXECUTION_STEPS`
- `.claude/rules/60-request-io-and-bundle-budgets.md` — no added round-trips
- `.claude/rules/47-control-loop-io-budget.md` — broadcast off the critical path
- `.claude/rules/18-file-size-limits.md` — new logic in new modules
- `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`
