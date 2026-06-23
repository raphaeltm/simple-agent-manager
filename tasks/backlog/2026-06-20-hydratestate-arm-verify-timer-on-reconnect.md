# hydrateState should arm the verify-decay timer when reconnecting into a prompting session

## Problem

`hydrateState` in `apps/web/src/components/project-message-view/useSessionLifecycle.ts`
sets `agentActivity` to `'prompting'` (and restores `promptStartedAt`) when a
catch-up / reconnect snapshot reports `state.activity === 'prompting'`, but it
does NOT arm the shared `startVerifyDecayTimer`.

Consequence: if the browser reconnects mid-prompt and the agent then goes
silent for a long tool call (and the WebSocket delivers no further activity or
message events), there is no client-side timer to verify DO state and decay the
bar. In the inverse case — the DO has already gone idle by the time the client
reconnects but the snapshot was captured while prompting — the status bar can
stay stuck "on" with no timer to ever reconcile it.

This is the reconnect-path counterpart to the blind-decay fix landed in PR
`sam/think-agent-working-status-01kvj3` (verify-before-decay timer). That PR
fixed the live `onMessage`/`onAgentActivity` paths; this one covers
`hydrateState` (catch-up / reconnect).

Severity: LOW — only manifests on reconnect into a long-silent prompting
session; the live paths are already covered.

## Context

- Discovered during ui-ux-specialist review (Finding 2, LOW) of PR
  `sam/think-agent-working-status-01kvj3` on 2026-06-20.
- Relevant code: `hydrateState` (~lines 122-127) and `startVerifyDecayTimer`
  (~line 120) in `useSessionLifecycle.ts`.

## Acceptance Criteria

- [ ] `hydrateState` arms `startVerifyDecayTimer()` when the snapshot reports
      `activity === 'prompting'`, mirroring `onAgentActivity('prompting')`.
- [ ] `hydrateState` cancels any pending verify timer when the snapshot reports
      `activity === 'idle'` (no stuck bar after reconnect into a finished prompt).
- [ ] React timer test (extend
      `apps/web/tests/unit/components/project-message-view-status-timer.test.ts`):
      reconnect snapshot with `prompting` → after `IDLE_TIMEOUT_MS`, DO is
      verified and the bar decays or re-arms per DO state.
- [ ] React timer test: reconnect snapshot with `idle` → no verify timer armed,
      bar stays idle.

## References

- PR: `sam/think-agent-working-status-01kvj3` (blind-decay-timer fix)
- `.claude/rules/02-quality-gates.md` (regression test requirements)
- `.claude/rules/39-debug-before-redesign.md` (fix the existing event path)
