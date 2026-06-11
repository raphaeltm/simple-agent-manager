# Fix Agent Status Indicator Reliability

## Problem

The "Agent is working..." status bar in project chat disappears after ~30s of stream silence (e.g., during npm install, long tool calls). Two layers:

1. **Client 30s decay timer (dominant daily pain)**: `useSessionLifecycle.ts:200-207` arms a 30s `setTimeout` on `'prompting'` event that unilaterally decays to `'idle'`. Message handler re-arms on each token, but any 30s gap triggers false idle.

2. **Terminal states never reported (~10% of prompts)**: Go code paths that end a prompt without calling `reportActivity("idle")`: force-stop watchdog, Stop(), Suspend(), rapid-exit. Also: failure logging at Debug level hides issues.

## Research Findings

### Client side (`useSessionLifecycle.ts`)
- `IDLE_TIMEOUT_MS = 30_000` in `types.ts:25`
- Two timer sites: line 169-171 (message heuristic) and line 204-206 (server activity event)
- Both use the same `idleTimerRef` and both blindly decay to idle
- The `onAgentActivity` callback (line 196-208) clears timer on any activity, then re-arms 30s on `prompting`
- No timer reset on session switch — stale timer from previous session can affect new session
- No server-side verification on timer fire

### Server side (`session-state.ts`, `project-data/index.ts`)
- `getSessionState()` exists and returns full `SessionStateSnapshot` including `activity`
- Activity broadcast at DO line 310 includes `{ sessionId, activity }` but NOT `promptStartedAt`
- `reconcileStaleActivity()` only heals `'prompting'` states, not `'error'`/`'recovering'`
- No explicit activity clear on idle-cleanup stop

### VM Agent (`session_host_*.go`)
- `triggerPromptForceStopIfStuck()` (prompt_state.go:96-124): sets HostError, never calls `reportActivity("idle")`
- `Stop()` (session_host.go:625-673): sets HostStopped, never reports activity
- `Suspend()` (session_host_lifecycle.go:91-143): sets HostStopped, never reports activity
- `monitorProcessExit()` rapid-exit path (process.go:53-65): sets HostError, never reports idle
- `reportActivity()` failure logs are `slog.Debug` — invisible in production

### Existing API endpoints
- `getChatSession()` already returns `state: SessionStateSnapshot` including `activity`
- No lightweight endpoint for just activity state — `getChatSession` fetches messages too

## Implementation Checklist

### Phase 1: Client timer fix (highest leverage)

- [ ] **1a.** In `onAgentActivity` handler (line 196-208): On `'prompting'` event, keep the 30s timer but change its fire behavior — instead of decaying to idle, fetch session state from DO via `getChatSession` and check `state.activity`. If still `'prompting'`, re-arm the timer. If `'idle'`, set idle.
- [ ] **1b.** Keep the message-based timer (line 169-171) as-is — it's a heuristic for `'responding'` which doesn't have server-side state.
- [ ] **1c.** Reset `idleTimerRef` on session switch — add `clearTimeout(idleTimerRef.current)` to the session change effect or reset in `onAgentActivity`.
- [ ] **1d.** Include `promptStartedAt` in the DO activity broadcast payload (line 310 of project-data/index.ts).

### Phase 2: Terminal state coverage in Go VM agent

- [ ] **2a.** `triggerPromptForceStopIfStuck()` in `session_host_prompt_state.go`: Add `h.reportActivity("idle")` after the force-stop.
- [ ] **2b.** `Stop()` in `session_host.go`: Add `h.reportActivity("idle")` before `h.cancel()`.
- [ ] **2c.** `Suspend()` in `session_host_lifecycle.go`: Add `h.reportActivity("idle")` before `h.cancel()`.
- [ ] **2d.** `monitorProcessExit()` rapid-exit path in `session_host_process.go`: Add `h.reportActivity("idle")` in the rapid-exit error branch (after `h.broadcastAgentStatus(StatusError, ...)`).

### Phase 3: Observability + reconciler

- [ ] **3a.** `reportActivity()` in `session_host_reporting.go`: Raise failure logs from `slog.Debug` to `slog.Warn`.
- [ ] **3b.** `reconcileStaleActivity()` in `session-state.ts`: Extend to also heal `'error'` and `'recovering'` states (in addition to `'prompting'`).
- [ ] **3c.** Clear `session_state.activity` when idle cleanup stops a session — add `markSessionStopped()` call in idle-cleanup stop path.

### Testing

- [ ] **T1.** Unit test: verify 30s timer fire fetches session state instead of decaying to idle
- [ ] **T2.** Unit test: verify `idleTimerRef` is cleared on session switch
- [ ] **T3.** Go test: verify `reportActivity("idle")` called in force-stop, Stop, Suspend, rapid-exit paths
- [ ] **T4.** Integration test: verify `reconcileStaleActivity` heals `'error'` states
- [ ] **T5.** Verify `reportActivity` failure logs are at Warn level

## Acceptance Criteria

1. Status bar persists through 30+ second tool call silences (primary fix)
2. All terminal Go code paths report `reportActivity("idle")` to the control plane
3. `reportActivity()` failures logged at Warn level for production visibility
4. Stale `'error'`/`'recovering'` states auto-healed by reconciler
5. Timer reset on session switch prevents cross-session interference
6. No regressions in message-based `'responding'` heuristic

## References

- SAM idea: `01KTVX6HD1Z0V3XYMC4CJ5WSVX`
- Key files listed in research findings above
- `.claude/rules/39-debug-before-redesign.md` — this fix follows the "fix existing system first" principle
