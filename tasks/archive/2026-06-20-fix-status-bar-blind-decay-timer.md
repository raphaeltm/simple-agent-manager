# Fix Status Bar Blind Decay Timer (disappears during long tool calls)

## Problem

The "Agent is working..." status bar — and the Cancel button rendered alongside it —
disappears during long tool calls (e.g. `npm install`, long builds) even though the
agent is still actively prompting. This regressed the Cloudflare-proxied activity
signal added in the 2026-06-11 fix.

User-observed symptom: "during long tool calls, among other things, the status bar
disappears (along with the cancel button)".

## Root Cause

In `apps/web/src/components/project-message-view/useSessionLifecycle.ts`, two
WebSocket handlers share a single `idleTimerRef` (and `verifyAbortRef`):

1. **`onAgentActivity` (lines 146-177)** — the *correct* handler. On a `'prompting'`
   event it arms a **verify-before-decay** timer: after `IDLE_TIMEOUT_MS` (30s) it
   fetches DO session state via `getChatSession` and only decays to idle if
   `state.activity !== 'prompting'`; otherwise it re-arms.

2. **`onMessage` (lines 118-132)** — the *buggy* handler. On every non-user message it
   sets `agentActivity = 'responding'`, clears `idleTimerRef`, and arms a **blind**
   30s `setTimeout(() => setAgentActivity('idle'))` with no server verification.

Because agent output streams through `onMessage` after the `prompting` event, the blind
timer is the **last writer** to the shared `idleTimerRef`. It overwrites the
verify-before-decay timer. During a >30s tool-call silence (no streamed tokens), the
blind timer fires → `setAgentActivity('idle')`. The status bar condition in
`index.tsx` (`lc.agentActivity !== 'idle' && isActive`) goes false, so both the
"Agent is working..." indicator AND the Cancel button vanish — even though DO
`state.activity` is still `'prompting'`.

The verify-before-decay fix from 2026-06-11 is effectively dead during streaming. The
3s polling fallback (lines 276-307) refreshes messages/session but does NOT re-hydrate
`agentActivity`, so it cannot rescue the false idle.

## Research Findings

- `IDLE_TIMEOUT_MS = 30_000` in `types.ts:25`.
- Status bar + Cancel button render together under one condition
  (`index.tsx` lines ~401-421): `lc.agentActivity !== 'idle' && isActive`. This is why
  both disappear at once.
- `onAgentActivity` already contains the correct `armVerifyTimer` recursive verify
  logic (lines 156-175); it just isn't shared with `onMessage`.
- The 2026-06-11 task (`tasks/archive/2026-06-11-fix-agent-status-indicator.md`)
  item 1b deliberately KEPT the blind message timer "as a heuristic for 'responding'",
  and deferred tests T1/T2 (React async timer tests). That deferral is the regression
  gap — no test covered the timer interaction.
- Per rule 39 (debug before redesign): fix the existing verify path so the two timers
  stop fighting. No new architecture (no extra WebSocket, no heartbeat).

## Implementation Checklist

- [x] **1.** Extract the verify-before-decay timer into a shared `startVerifyDecayTimer`
  callback (stable via `useCallback([projectId, sessionId, clearActivity])`) defined
  before `useChatWebSocket`. It clears `idleTimerRef`, aborts any prior `verifyAbortRef`,
  creates a fresh `AbortController`, and arms the recursive verify timer (re-arm while
  DO `state.activity === 'prompting'`, else `clearActivity()`).
- [x] **2.** Convert `clearActivity` to a stable `useCallback`.
- [x] **3.** `onAgentActivity('prompting')`: set state then call `startVerifyDecayTimer()`.
  `onAgentActivity('idle')`: clear timer + abort verify.
- [x] **4.** `onMessage` (non-user message): set `agentActivity = 'responding'`, keep
  `promptStartedAt` intact, then call `startVerifyDecayTimer()` instead of the blind
  `setTimeout(... 'idle')`. The shared timer now verifies DO state before any decay.
- [x] **5.** Keep the session-change cleanup effect clearing the timer
  and aborting verify on `sessionId` change.
- [x] **6.** Add React timer tests (the deferred T1/T2) under
  `tests/unit/components/project-message-view-status-timer.test.ts` using `renderHook` +
  fake timers, mirroring the established `project-message-view-recovery.test.ts` pattern.

## Acceptance Criteria

1. During a >30s silence while DO `state.activity === 'prompting'`, the shared timer
   re-arms (verifies first) and `agentActivity` does NOT become `'idle'` — status bar
   and Cancel button persist. (Test)
2. When the timer fires and DO `state.activity !== 'prompting'`, activity decays to
   `'idle'`. (Test)
3. An incoming agent message no longer arms a blind decay timer — after a message the
   subsequent 30s silence still verifies DO state before decaying. (Test — regression)
4. Timer is cleared on session switch. (Test)
5. No regression to the `'responding'` display heuristic for streaming output.

## References

- `apps/web/src/components/project-message-view/useSessionLifecycle.ts`
- `apps/web/src/components/project-message-view/types.ts` (`IDLE_TIMEOUT_MS`)
- `apps/web/src/components/project-message-view/index.tsx` (status bar render condition)
- `tasks/archive/2026-06-11-fix-agent-status-indicator.md` (prior fix; T1/T2 deferred)
- `apps/web/tests/unit/components/project-message-view-recovery.test.ts` (test pattern)
- `.claude/rules/39-debug-before-redesign.md` — fix existing system, no redesign
