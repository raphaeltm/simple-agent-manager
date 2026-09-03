# Fix session cancel/stop flow: interrupt unreliability and post-stop unresponsiveness

**SAM task:** `01M1M75WA3V528VYZCWQGGM3NT`
**Output branch:** `sam/fix-two-critical-bugs-ggm3nt`
**Related:** `tasks/active/2026-08-16-session-activity-state-machine.md` (rule 57 implementation — this is the
gap it left), `tasks/archive/2026-08-21-manual-session-sleep.md` (the Stop/Sleep/Archive dock contract),
`.claude/rules/57`, `.claude/rules/49`, `.claude/rules/44`, `.claude/rules/47`, `.claude/rules/62`

## Problem Statement

Two user-reported symptoms in project chat:

**A. The red Interrupt button is unreliable.** Hitting it mid-turn often does not stop the agent
quickly, and frequently needs multiple presses. There is zero feedback between press and effect.

**B. After stopping an agent mid-turn, follow-up prompts do not work.** The user has to sleep/wake
the session to recover.

## Research Findings

### F1. The task description conflates two different endpoints — corrected

| UI control | Web handler | Endpoint | Effect |
|---|---|---|---|
| Red **Interrupt** (working) | `useSessionLifecycle.handleCancelPrompt` (`useSessionLifecycle.ts:615`) | `POST /:sessionId/cancel` (`chat-cancel.ts:22`) | Signals the VM, records turn end. **No teardown.** |
| **Sleep** (awake idle) | `useProjectChatState.handleSleepConversation` (`useProjectChatState.ts:890`) | `POST /api/workspaces/:id/sleep` | Snapshot + release compute. |
| **Archive** (sleeping only) | `useProjectChatState.handleCloseConversation` (`useProjectChatState.ts:917`) | `closeConversationTask` if `taskId`, else `stopChatSession` → `POST /:sessionId/stop` (`chat-stop.ts:129`) | Destructive teardown. |

`canArchiveSession` (`project-message-view/index.tsx:447`) requires `lc.sessionState === 'sleeping'`,
so **`/stop` is reachable from the UI only for an already-sleeping, taskless session.** Both reported
symptoms therefore belong to the `/cancel` path, not `/stop`.

### F2. ROOT CAUSE (both symptoms): `recordTurnEnd`'s compare-and-set uses the wrong clock

`recordTurnEnd` (`durable-objects/project-data/session-state.ts:219-269`) is the single terminal-write
helper. Its guard is:

```sql
WHERE session_id = ?
  AND activity IN ('prompting', 'recovering')
  AND activity_at <= ?   -- observedAt
```

Per `.claude/rules/49`, `observedAt` is captured in `chat-cancel.ts:42` **before** the slow VM call so
that "a prompt that started after this instant belongs to a newer turn and is never stomped".

But `activity_at` is **not** a turn-start clock. `refreshWorkingActivityForChatSession`
(`session-state.ts:316`) sets `activity_at = now` on **every persisted message** while the session is
working, and it is called from both message-persistence paths
(`message-persistence.ts:68` and `:130`). It matches by `session_id IN (SELECT id FROM acp_sessions
WHERE chat_session_id = ?) UNION ?`, so it bumps exactly the ACP-keyed row that `recordTurnEnd`
targets.

So the real interleaving during an interrupt is:

```
T0            observedAt = Date.now()                     (chat-cancel.ts:42)
T0 .. T0+D    await cancelAgentSessionOnNode(...)         HTTPS round trip to the VM
   T0+k       agent outbox flushes a message
              -> refreshWorkingActivityForChatSession -> activity_at = T0+k
T0+D          recordTurnEnd(observedAt = T0)
              CAS: activity_at (T0+k) <= observedAt (T0)  -> FALSE -> no-op, returns false
              -> publishTurnEnd NEVER RUNS
```

`activity_at` only needs to advance once inside the round-trip window for the cancel to be silently
discarded. During active agent output that is common — which is exactly why the symptom is
intermittent ("often", "may need multiple presses") rather than deterministic.

The consequences are precisely the three-consumer breakage that `.claude/rules/57` and
`session-activity-reconciliation.ts:1-28` describe, and they map 1:1 onto the two reported symptoms:

- **Symptom A** — `session_state.activity` stays `prompting`. The optimistic
  `setAgentActivity('idle')` (`useSessionLifecycle.ts:620`) is overwritten by the next
  `session.activity` broadcast/poll, the dock morphs back to working, and the user presses again.
  The second press captures a *later* `observedAt` (the agent has now stopped emitting, so
  `activity_at` is frozen), the CAS succeeds, and it "works the second time".
- **Symptom B** — `publishTurnEnd` never fires, so `nudgePromptDeliveriesForTarget` never fires. The
  follow-up is accepted into the durable queue (`chat-prompt-route.ts:46`) and waits; the VM answers
  `409 not_ready` and the delivery parks in `retry_wait` with `'Target VM is currently processing a
  prompt'` (`vm-prompt-delivery-adapter.ts:278`). Sleep/wake recovers it because wake rebuilds the
  state from scratch.

**Fix:** compare against the turn's own start instead of the last-report clock:
`COALESCE(prompt_started_at, activity_at) <= observedAt`. `prompt_started_at` is set once when the
prompt begins and is explicitly *preserved* across same-turn re-reports
(`session-state.ts:115-121`), so it is stable per turn. Rule 49's guarantee is kept intact: a turn
that started **after** `observedAt` still has `prompt_started_at > observedAt` and is still never
stomped. `COALESCE` preserves today's behaviour for rows with no recorded prompt start.

### F3. `stopSession` / `failSession` never clear the working mirror

`markSessionStopped` (`session-state.ts:357`) and `markSessionError` (`session-state.ts:373`) have
**zero production callers** — only definitions and two unit tests
(`tests/unit/durable-objects/session-state-mirror.test.ts:447,463`).

The DO RPCs `stopSession` (`project-data/index.ts:209`) and `failSession` (`:281`) write only
`chat_sessions.status` via `sessions.terminateSession` (`sessions.ts:70`) and broadcast
`session.stopped` / `session.failed`. They never touch `session_state`, never nudge deliveries,
never touch idle cleanup, never `recalculateAlarm`. A session terminated while its mirror is in a
working state stays "working" until the 5-minute staleness probe sweep.

Writer inventory (`.claude/rules/44` — every caller of the DO `stopSession`, all of which are
genuine terminal endings, so clearing the working mirror is correct for all of them):

| # | Caller | Correct to clear mirror? |
|---|---|---|
| 1 | `services/chat-persistence.ts:37` (the `/stop` route) | yes |
| 2 | `services/task-terminal-cleanup.ts:123` | yes |
| 3 | `services/workspace-lifecycle-finalizer.ts:258` | yes |
| 4 | `services/trigger-submit.ts:341` (orphaned session) | yes |
| 5 | `routes/tasks/submit.ts:638` (orphaned session) | yes |
| 6 | `routes/tasks/run.ts:371` (orphaned session) | yes |
| 7 | `routes/mcp/dispatch-tool.ts:698` (orphaned session) | yes |
| 8 | `routes/mcp/orchestration-tools.ts:150` (retry) | yes |
| 9 | `scheduled/d1-retention.ts:454` | yes |
| — | `terminal-session-reconciliation.ts:306` + `idle-cleanup.ts:366,571` use `stopSessionInternal` (raw SQL, not the RPC) | out of scope, unchanged |

`failSession` has the equivalent 7 external callers, all terminal.

**Fan-out must NOT reuse `publishTurnEnd` verbatim.** `publishTurnEnd` calls
`hooks.armIdleCleanup` → `idleCleanup.resetIdleCleanup`, which **re-arms** the idle timer. Handing a
fresh idle timer to a session that was just terminated is wrong and creates an immortal candidate
(`.claude/rules/47` §3). A terminal ending needs `cancelIdleCleanup` (`idle-cleanup.ts:197`, a plain
`DELETE`) instead. The task brief agrees — it says "idle cleanup **disarm**".

### F4. `/stop` never signals the VM agent

`chat-stop.ts` cancels the task row, runs `cleanupTerminalTaskResources`, and calls
`chatPersistence.stopChatSession`. It never calls `cancelAgentSessionOnNode` or
`stopAgentSessionOnNode`. For the sleeping-session case the runtime is already gone, but `/stop` is
also directly reachable via the API on a live session, where archiving currently leaves the agent
running and burning tokens until teardown reaps it. `chat-cancel.ts:33-52` is the reference pattern.

### F5. `destructiveSessionEnd: true` — considered and REJECTED

The brief asks to "consider" flipping this to `false`. Evidence says keep it `true`:

- `/stop` is the **Archive** path. Its confirm dialog says "This action cannot be undone"
  (`CompletionDock.tsx:423-426`), and stored policy `a65b1778` makes archive the deliberately
  irreversible action *after* the reversible sleep boundary.
- It is the **only** production caller passing `true` (all 6 others omit it). It is the flag's
  entire reason for existing (`task-terminal-cleanup.ts:20-21`: "Archive/delete intent: discard the
  seven-day restore state").
- Flipping it would leak the `session_snapshots` row and three R2 objects for the full 7-day TTL on
  every archive, and — because of the `status === 'completed' && !destructiveSessionEnd` early
  return at `task-terminal-cleanup.ts:95-107` — would **skip teardown entirely** for an
  already-completed task, queuing a sleep instead of archiving. That is a worse bug than the one
  being fixed.
- The restorability guard that protects *non-destructive* teardown already exists and deliberately
  exempts explicit archive (`workspace-lifecycle-finalizer.ts:215-247`, PR #1937, `.claude/rules/58`
  / `.claude/rules/66`).

Recorded here as an explicit written rejection per `.claude/rules/63` ("separate tables were
considered and rejected in writing" — same discipline).

### F6. UI gaps (as described in the brief — all confirmed)

- `cancellingRef` (`useSessionLifecycle.ts:614`) is a **ref**, so it is not reactive and cannot drive
  a disabled/spinner prop. Clicks are silently dropped for the whole request (up to
  `DEFAULT_NODE_AGENT_REQUEST_TIMEOUT_MS`).
- The `.catch()` at `:622` is empty — network/server errors vanish.
- `centerDisabled` (`CompletionDock.tsx:260-262`) covers only archive+sleep. `actionError`
  (`:279-284`) maps interrupt to `null`, so there is no error slot for interrupt.
- **Convention to follow:** sleep and archive surface errors *inline* through `actionError`
  (`CompletionDock.tsx:442-446`), not via toast. Use the same mechanism for cancel
  (`.claude/rules/24`, `.claude/rules/59` — extend the existing pattern, do not fork a new one).
- A second copy of the same handler exists at `pages/workspace/WorkspaceChatView.tsx:271-285` with
  the identical empty catch.

### F7. Test landscape

- `apps/web/tests/unit/components/CompletionDock.test.tsx` — already covers `archiving` disables
  Archive (`:204`), `sleeping` disables Sleep (`:210`), **`archiving` does NOT disable Interrupt**
  (`:217`), and the `archiveError`/`sleepError` alert roles (`:224`,`:234`). Extend here.
- `apps/web/tests/unit/components/project-message-view.test.tsx:2210` — one cancel happy-path test;
  **no failure-path test exists.**
- `apps/api/tests/unit/durable-objects/session-state-mirror.test.ts` — real-SQL `session_state`
  harness; the right home for the `recordTurnEnd` CAS regression.
- `apps/api/tests/unit/routes/chat-session-stop-cleanup.test.ts` — the only `/stop` route test;
  mocks `cleanupTerminalTaskResources` entirely.
- `apps/api/tests/unit/routes/chat-prompt-cancel.test.ts` — the `/cancel` route test.

## Design

One root-cause fix plus the two gap fixes the brief identified, each at its single choke point.

1. **`recordTurnEnd` CAS clock** (`session-state.ts`) — the root cause of both symptoms.
2. **Terminal-ending fan-out** (`project-data/index.ts` `stopSession`/`failSession`) — new private
   `publishSessionTerminalEnd()` helper: `markSessionStopped`/`markSessionError` on the chat session
   **and every linked ACP session**, broadcast `session.activity`, nudge deliveries,
   **cancel** idle cleanup, recalculate alarm.
3. **`/stop` signals the VM** (`chat-stop.ts`) — best-effort cancel + stop before teardown, modelled
   on `chat-cancel.ts`, never failing the archive.
4. **UI feedback** (`useSessionLifecycle.ts`, `CompletionDock.tsx`, `project-message-view/index.tsx`)
   — reactive `cancelling` + `cancelError`, disabled interrupt while cancelling, inline error.

No new env knobs are needed; no hardcoded values are introduced (Constitution XI).

## Implementation Checklist

- [ ] `session-state.ts`: `recordTurnEnd` CAS compares `COALESCE(prompt_started_at, activity_at) <= observedAt`, with a comment naming `refreshWorkingActivityForChatSession` as the writer that made `activity_at` unusable here
- [ ] `session-state.ts`: `markSessionStopped` also clears `status_error` and resets probe accounting, and records provenance, so a stopped row cannot be re-probed as a working candidate
- [ ] `project-data/index.ts`: add `publishSessionTerminalEnd()` fan-out (broadcast + nudge deliveries + **cancel** idle cleanup + recalculate alarm)
- [ ] `project-data/index.ts`: `stopSession` RPC calls `markSessionStopped` for the chat session and each linked ACP session, then fans out
- [ ] `project-data/index.ts`: `failSession` RPC does the same via `markSessionError`
- [ ] `chat-stop.ts`: best-effort `cancelAgentSessionOnNode` + `stopAgentSessionOnNode` before teardown; never throws
- [ ] `useSessionLifecycle.ts`: reactive `cancelling` state replacing the ref-only guard; `cancelError` state; populate both; expose in `UseSessionLifecycleResult`
- [ ] `useSessionLifecycle.types.ts`: add `cancelling` / `cancelError` / `clearCancelError`
- [ ] `CompletionDock.tsx`: `cancelling` prop → `centerDisabled` + `'Cancelling…'` title + `aria-busy`; `cancelError` → `actionError` for interrupt
- [ ] `project-message-view/index.tsx`: wire `cancelling`/`cancelError` through to the dock
- [ ] `WorkspaceChatView.tsx`: stop swallowing cancel errors (surface via the existing error affordance)
- [ ] Tests: all listed below, each proven discriminating
- [ ] Playwright visual audit — mobile 375x667 + desktop 1280x800, cancelling state, error state, overflow assertions
- [ ] Docs sync: check `apps/www/src/content/docs/docs/` for statements about interrupt/archive behaviour

## Required Tests

Per `.claude/rules/62` each test must reach the feature the way production does, and each new guard
must be proven discriminating (delete it, confirm exactly the intended test goes red, restore).

**Root cause (F2)** — `session-state-mirror.test.ts`, real SQL:
- [ ] **The incident, reproduced through the real writer**: enter `prompting`, capture `observedAt`,
      then call the real `refreshWorkingActivityForChatSession` (not a hand-written `UPDATE`) to
      advance `activity_at` past `observedAt`, then `recordTurnEnd(observedAt)`. Assert it returns
      `true` and the row is `idle`. **Must fail against pre-fix code.**
- [ ] **Rule-49 control (discriminating)**: a *new* prompt whose `prompt_started_at > observedAt` is
      still NOT stomped. Must stay green after the fix — this is what proves the fix did not simply
      delete the guard.
- [ ] **COALESCE fallback**: a working row with `prompt_started_at IS NULL` behaves as before.

**Terminal fan-out (F3)** — DO tests:
- [ ] `stopSession` on a session whose mirror is `prompting` clears it and nudges queued deliveries.
- [ ] `stopSession` **cancels** rather than re-arms idle cleanup (assert the schedule row is gone).
- [ ] ACP-keyed rows linked to the chat session are cleared too, not just the chat-session-keyed row.
- [ ] `failSession` equivalent via `markSessionError`.
- [ ] Control: a session already `idle` is unaffected and no spurious broadcast/nudge storm occurs.

**`/stop` VM signal (F4)** — `chat-session-stop-cleanup.test.ts`:
- [ ] Ordering: the VM cancel/stop is attempted **before** `cleanupTerminalTaskResources`.
- [ ] Best-effort: a throwing/404 resolver still returns 200 and still tears down (the
      already-sleeping archive case, where there is no live workspace, must not regress).
- [ ] `destructiveSessionEnd: true` is still passed (guards F5 against accidental change).

**UI (F6)**:
- [ ] `CompletionDock`: `cancelling` disables Interrupt and shows the cancelling affordance.
- [ ] `CompletionDock`: `cancelError` renders in the `role="alert"` slot for interrupt.
- [ ] `CompletionDock` control: `cancelling` does **not** disable Sleep/Archive (mirrors the existing
      `:217` test in the other direction).
- [ ] `project-message-view`: clicking Interrupt when the API rejects surfaces the error and
      re-enables the button (the missing failure-path test). Use a deferred promise so the test can
      assert the disabled mid-state before releasing the rejection (`.claude/rules/62` ordering).
- [ ] Absence assertions paired with a positive render assertion (`.claude/rules/62` §5).

## Acceptance Criteria

- [ ] A cancel issued while the agent is actively emitting messages terminalizes the session state on
      the **first** press (root cause fixed, proven by a test that fails pre-fix)
- [ ] A prompt that starts after the cancel's `observedAt` is still never stomped (rule 49 intact)
- [ ] After an interrupt, a queued follow-up prompt is released rather than parking in `retry_wait`
- [ ] Interrupt shows a visible cancelling state and cannot be clicked twice into the void
- [ ] A failed cancel surfaces a visible error and the button becomes usable again
- [ ] `stopSession`/`failSession` leave no session in a working mirror state, and do not re-arm idle
      cleanup on a terminal session
- [ ] Archiving a live session signals the VM agent before teardown; archiving a sleeping session
      (no live workspace) still succeeds unchanged
- [ ] `destructiveSessionEnd: true` is retained for `/stop` with the rationale recorded
- [ ] No hardcoded values; no new env knobs required
- [ ] Mobile + desktop Playwright screenshots reviewed, no overflow or clipping

## Post-Mortem (for the PR)

- **What broke:** interrupting an agent mid-turn frequently did nothing on the first press, and
  follow-up prompts after an interrupt silently stalled until the session was slept and woken.
- **Root cause:** `recordTurnEnd`'s compare-and-set guarded on `activity_at`, a *last-report* clock
  that same-turn message persistence advances, instead of on the turn's own start. A message
  flushing inside the VM cancel round-trip silently voided the cancel's terminal write, so
  `publishTurnEnd` — the single fan-out to the status UI, the delivery nudge and idle scheduling —
  never ran.
- **Class of bug:** *a compare-and-set whose guard column is written by an unrelated path.* The
  sibling of `.claude/rules/53`'s "liveness timestamp used as an idleness signal": here a
  last-activity timestamp is used as a turn-identity signal. Both fail because the column has a
  writer nobody enumerated (`.claude/rules/44`).
- **Why it was not caught:** the rule-57 work added `recordTurnEnd` with CAS tests that set
  `activity_at` directly in the fixture, so no test ever ran the real writer
  (`refreshWorkingActivityForChatSession`) concurrently with a cancel — exactly the
  `.claude/rules/62` failure mode of constructing the condition instead of causing it.
- **Process fix:** extend `.claude/rules/49` with a "the CAS guard column must have no unrelated
  writers" requirement — enumerate every writer of the guard column (rule 44) and prove the
  regression test drives the real writer rather than seeding the column.

## References

- `apps/web/src/components/project-message-view/useSessionLifecycle.ts`
- `apps/web/src/components/project-message-view/CompletionDock.tsx`
- `apps/api/src/routes/chat-stop.ts`, `apps/api/src/routes/chat-cancel.ts`
- `apps/api/src/durable-objects/project-data/sessions.ts`, `session-state.ts`,
  `session-activity-reconciliation.ts`, `message-persistence.ts`, `idle-cleanup.ts`
- `apps/api/src/services/task-terminal-cleanup.ts`
- `apps/api/src/routes/chat-workspace-resolver.ts`
- `.claude/rules/49`, `/53`, `/57`, `/44`, `/47`, `/58`, `/62`, `/66`, `/24`, `/59`
