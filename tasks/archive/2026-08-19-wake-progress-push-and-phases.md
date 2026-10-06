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
- [x] Add `WAKE_PHASE_LABELS: Record<TaskExecutionStep, string>` + `wakePhaseLabel()` helper
      in `packages/shared/src/types/task.ts` (wake-specific wording: provisioning →
      restoring → starting agent). Export from `types/index.ts`.
- [x] Add `wakePhase?: TaskExecutionStep | null` to `SessionStateSnapshot`
      (`packages/shared/src/types/session.ts`).

### API — hydration (pull path, survives navigation)
- [x] New `apps/api/src/routes/chat/wake-state.ts`: resolve `{recoveryStatus, wakePhase}`
      for a sleeping session in **one** D1 query (join `session_snapshots` →
      `tasks.execution_step` via `recovery_task_id`), replacing the existing standalone
      snapshot query so the endpoint's round-trip count does not increase (rule 60).
- [x] Rewire `chat.ts:325-345` to call it. Preserve the existing non-fatal
      `chat.recovery_status_lookup_failed` warn-and-continue behavior (rule 50).

### API — push path (ProjectData DO)
- [x] New `apps/api/src/durable-objects/project-data/session-wake-progress.ts`:
      `publishSessionWakeProgress(hooks, {chatSessionId, recoveryStatus, wakePhase})` →
      `broadcastEvent('session.wake_progress', {...}, chatSessionId)`.
- [x] Thin RPC method on the DO delegating to it.

### API — TaskRunner emits transitions
- [x] In `updateD1ExecutionStep`, after the D1 write, when
      `currentState.config.resumeSnapshotChatSessionId` is set, publish the wake phase to
      ProjectData. **Best-effort**: wrapped in try/catch, failure logged not thrown — a
      broadcast must never fail a wake (rule 47: off the critical path).
- [x] Emit a terminal `recoveryStatus` publish when wake completes so the banner clears
      without waiting for a poll.
- [x] Env-configurable timeout constant for the broadcast call (`DEFAULT_*`, Principle XI).

### Web
- [x] `SessionStateSnapshot` client type gains `wakePhase` (`lib/api/sessions.ts`).
- [x] Handle `session.wake_progress` on the client socket. **Corrected during review:** wired in
      `apps/web/src/hooks/useChatWebSocket.ts`, NOT `useSessionReducer.ts`. The plan named the wrong
      file — `useSessionReducer` feeds the project-wide multiplexed socket, while the banner is
      driven by the per-session socket `ProjectMessageView` actually holds.
- [x] New `useWakeProgress.ts`: owns wake phase state; hydrates from server snapshot,
      updates from WS; clears on wake completion.
- [x] New `WakeProgressBanner.tsx`: spinner + phase label + elapsed time.
- [x] Wire into `project-message-view/index.tsx`, replacing the static banner.

### Tests
- [x] Shared: label map covers every `TaskExecutionStep` (exhaustiveness).
- [x] API: wake-state resolver returns phase; missing/failed lookup degrades to null, not 500.
- [x] API: **discriminating** — TaskRunner broadcasts for a recovery task and does **NOT**
      broadcast for a normal task (assert zero calls).
- [x] API: broadcast failure does not fail the step transition.
- [x] Web: reducer maps the event; `useWakeProgress` hydrates + live-updates; banner renders
      the phase label and clears on completion.
- [x] Playwright visual audit, 375px + 1280px, with `assertNoOverflow` (rule 56).

## Acceptance criteria

- [x] Wake banner updates from a WS push, not only from the poll
- [x] Banner shows the current phase ("Setting up a new server..." → "Restoring your
      session..." → "Starting AI agent...") rather than one static string
- [x] Banner still survives navigate-away-and-back (no regression of PR #1865)
- [x] Banner clears when wake completes
- [x] A normal (non-recovery) task run produces **no** wake broadcasts
- [x] A broadcast failure never fails a wake
- [x] No new D1 or DO migration; endpoint round-trip count not increased
- [x] Mobile (375px) and desktop (1280px) audited, no horizontal overflow

## References

- Idea `01M0D1WSZ1TD6ZE2YYE268SEHV`; prior PR #1865, PR #1862
- `.claude/rules/59-understand-before-adding.md` — reuse `TASK_EXECUTION_STEPS`
- `.claude/rules/60-request-io-and-bundle-budgets.md` — no added round-trips
- `.claude/rules/47-control-loop-io-budget.md` — broadcast off the critical path
- `.claude/rules/18-file-size-limits.md` — new logic in new modules
- `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md`

---

## Implementation notes (filled in during execution)

### Design confirmed by research, not assumed

`TASK_EXECUTION_STEPS` already existed with exactly the right phase vocabulary, and
`session_snapshots.recovery_task_id` already linked a waking session to the task
reporting those phases. So the phase signal needed **no new column and no migration** —
only a join the route was not yet making (rule 59).

### The near-miss: duplicate progress UI

The first Playwright run appeared to show the new banner stacked directly beneath the
pre-existing `pages/project-chat/ProvisioningIndicator` — a 4-stage progress block built
from the same `TaskExecutionStep` vocabulary. That looked like a clear rule-24 duplicate.

It was a **mock artifact**. `useProjectChatState` populates `provisioning` from
`getProjectTask(session.taskId)` and only for a task that is neither terminal nor
`in_progress`. The audit was returning `{}` for that task, so `status` was `undefined`
and the guard passed vacuously. A slept session's own task is `in_progress`, so in
production the provisioning block stays hidden and there is no overlap — the two
components are fed by different tasks (own vs. recovery), which is precisely why a wake
previously showed no phase progress at all.

Resolutions:
- The audit now returns a realistic `in_progress` task.
- `wake-progress-audit.spec.ts` asserts the two indicators never render together, so if
  they ever start to overlap the suite says so.
- `WakeProgressBanner`'s header documents the relationship and the divergence rationale.

### A second test-instrument bug, caught the same way

Before the onboarding wizard was suppressed, every screenshot captured the full-screen
"Do you have a cloud hosting account?" modal rather than the chat. Playwright still
reported the banner as visible (it was in the DOM, behind the overlay), all assertions
passed, and the overflow check was measuring the wizard's layout. The tell was that every
phase's PNG had a byte-identical size. `gotoWakingChat` now fails loudly if the wizard
reappears, so the evidence cannot silently drift back to auditing the wrong surface.

Both findings are the rule-56 class: a check that cannot observe the thing it claims to
verify.

### Discrimination verified (not assumed)

Each guard was temporarily removed and the corresponding test confirmed red:

| Guard removed | Test that went red |
|---|---|
| `eq(sessionSnapshots.chatSessionId, sessionId)` | `does not leak another session's wake` |
| `if (!chatSessionId) return false` | `does NOT broadcast for a normal task run` |
| `useEffect` reset on `sessionId` | `does not carry a wake across a session switch` |

In each case only the intended test failed; the rest of the suite stayed green.

### Deviation from the /do workflow

`main` is branch-protected in this repository, so the Phase 1 "push the task file directly
to main" step was rejected (`Required status check "Durable Object Workers" is expected`).
The task file rides on the feature branch instead.

### Review findings and fixes (Phase 5)

`task-completion-validator` returned **FAIL** on the first pass, with one HIGH finding that
was correct and merge-blocking. All findings were fixed in-branch; none were deferred.

**HIGH — the terminal "wake complete" broadcast was unreachable dead code.**

The design assumed `updateD1ExecutionStep` was the single choke point for *every* step
transition. It is the choke point for every *intermediate* step, but not the last one:
`transitionToInProgress` writes `execution_step = 'running'` through its own guarded raw
`UPDATE` (the optimistic-lock predicate has to be in the same statement), and the alarm
dispatcher then treats `running`/`awaiting_followup` as terminal no-op steps. So
`recoveryStatusForStep('running') === 'restored'` could never be reached in production.

The damning part is that three green tests appeared to cover it — a server unit test, a
client hook test, and a Playwright case — and every one of them hand-fed the terminal value
rather than driving the real trigger. The banner would in fact have cleared only via the
~10s fallback poll: precisely the lag this task exists to remove.

Fixed by adding `notifyWakeSettled` and calling it from the actual completion points in
`state-machine.ts` (both the committed-handoff path and the already-in-progress path), plus
a `failed` emit on the revoked-authority path so a doomed wake does not leave a spinner
running. Three new tests in `task-runner-state-machine.test.ts` drive the **real**
`transitionToInProgress` with a `PROJECT_DATA` mock; the terminal-emit test was verified to
fail when the new call is removed, and the non-recovery control asserts zero broadcasts.

**MEDIUM — checklist named the wrong integration file.** The plan said `useSessionReducer.ts`;
the correct home was `useChatWebSocket.ts`. Checklist corrected above rather than left to
mislead a future reader.

**MEDIUM — the WS parsing branch itself was untested.** The layer that parses untrusted
socket JSON and enforces cross-session isolation had no coverage. Added five cases to
`useChatWebSocket.behavioral.test.ts` mirroring the existing `session.activity` pattern:
valid phase, both terminal states, unknown-phase normalization, unknown-status rejection,
and cross-session isolation.

**LOW — no Miniflare test for the DO RPC delegate.** Accepted as-is; consistent with how
sibling `ProjectData` RPC delegates are covered in this codebase.

**Lesson.** Two of the three defects found across this task were *test instruments that could
not observe the thing they claimed to verify* (the onboarding-modal screenshots, the
hand-fed terminal broadcast). The research claim "updateD1ExecutionStep is the single choke
point" was true enough to pass a reading of the code and false exactly where it mattered —
`.claude/rules/05` assumption-verification applies to a choke point just as much as to a
"this already works" claim.

### Review round 2 — two more CRITICALs, same class

`cloudflare-specialist` and `test-engineer` each found a separate reason the push half
still did not work. Both were the same failure mode as everything before it: the tests
could not observe the thing they claimed to verify.

**CRITICAL (cloudflare-specialist) — the socket was closed for the entire wake.**
`useChatWebSocket` was gated `enabled: session?.status === 'active'`. A waking session is
`sleeping` server-side for the whole wake (`wakeSession()` flips it to `active` only at the
very end, after the agent is live), so the client held NO connection during exactly the
window the broadcasts were sent. Every phase delta was dropped on the floor and the feature
degraded silently to the pre-existing poll. The hook tests missed it because they pass
`enabled` directly; the Playwright audit missed it because it only exercises the pull path.
Fixed by opening the socket while `isWaking` — a bounded window, and only then, so an
ordinary sleeping session still connects nothing. Regression test asserts the gate opens for
a waking session and stays shut for an ordinary sleeping one; verified discriminating.

**CRITICAL (test-engineer, empirically reproduced) — the stale-sleeping guard swallowed
wake progress on the most common trigger.** `handleSendFollowUp` arms
`sleepingWakePendingRef`, and the guard condition (`ref && sleeping && !working`) then holds
for nearly the entire wake. That branch called only `hydratePlan`, and `hydrateWakeProgress`
is reached only through `hydrateState` — so for a user-triggered wake (type into a sleeping
session, the normal path) every phase update was discarded, `isWaking` never flipped, and
the socket gate above could never open. Chicken-and-egg: no poll could set the flag, and no
socket could open to push it. Fixed by calling `hydrateWakeProgress` in the guard branch too
— the guard exists to protect `agentActivity`, not to drop wake state.

That regression test needed two attempts to become discriminating: `isWaking` is sticky, so
the first version let a wake-bearing response land before the guard was armed and passed
against the broken code. The final version gates the fixture on an explicit flag flipped
only after the send completes, and was verified to fail without the fix.

**Also fixed from review round 2:**
- **A11y (ui-ux CRITICAL):** the ticking elapsed timer sat inside a `role="status"` region.
  `role="status"` implies `aria-atomic`, so a screen reader would re-announce the whole
  banner roughly once a second for a multi-minute wake. The live region now wraps only the
  phase label; the timer and the (now `aria-hidden`) spinner are siblings.
- **Composer contradiction (ui-ux HIGH):** the input still read "Send a message to wake the
  agent..." while the banner said "Provisioning a server..." — an invitation to trigger the
  duplicate wake this whole feature exists to prevent. Now wake-aware, asserted in the audit.
- **Duplicate label (ui-ux MEDIUM):** `workspace_ready` and `attachment_transfer` rendered
  identical copy, so a real phase advance looked like a stall. `attachment_transfer` is now
  "Restoring your files..." and the audit covers that phase.
- **Dead audit fixture (ui-ux MEDIUM):** the spec set `title`, but `SessionHeader` renders
  `topic` — every screenshot showed the short `Chat <id>` fallback, so the long-text overflow
  stress case never actually ran. Fixed; the long topic now renders and wraps.
- **Status regression (test-engineer MEDIUM):** a late `waking` poll could re-open a settled
  banner. Added a per-session settled latch, with a test proving a later wake still works.
- **`waitUntil` asymmetry (both reviewers MEDIUM):** the terminal emit blocked the alarm
  while the intermediate emit did not. Both now use `ctx.waitUntil`. This surfaced an
  incomplete `ctx` mock in `task-runner-agent-session.test.ts` (real `rc.ctx` is a
  `DurableObjectState` and always has `waitUntil`) — fixed there too.

### Deferred, with reasons

- **No test drives the real `updateD1ExecutionStep` closure** (test-engineer HIGH). The
  intermediate-step emit is only covered at the function level; deleting the wiring in
  `task-runner/index.ts` would not fail the suite. Not known-broken (unlike the terminal
  path, which was), but the same coverage shape. Needs a Miniflare-level DO test.
- **Terminology drift** (ui-ux MEDIUM): three different phrasings for "provisioning a VM"
  now exist across `EXECUTION_STEP_LABELS`, `ProvisioningIndicator`, and `WAKE_PHASE_LABELS`.
  Consolidating is a separate copy pass.
- **`state-machine.ts` is 717 lines** (architecture-reviewer MEDIUM), over the 500-line
  soft ceiling before this change and not split here.
- **No light-theme screenshots** (ui-ux LOW).
