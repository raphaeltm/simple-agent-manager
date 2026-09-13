# A Goroutine That Outlives Its Request Must Not Capture That Request's Context

## When This Applies

Any `go func(ctx, …)` — or any struct field, closure, or queue entry holding a
`context.Context` — where the goroutine's lifetime is **the resource's**, not the
caller's. In this repo that is overwhelmingly `packages/vm-agent/`: process
monitors, watchdogs, heartbeat loops, reconnect loops, snapshot coordinators,
port scanners, and anything spawned from an `http.Handler` or a WebSocket read
loop that keeps running after that handler returns.

The tell is a goroutine spawned inside a function whose `ctx` parameter came from
`r.Context()`, a `websocket` connection loop, or an already-completed RPC.

## Why This Rule Exists

`startAgentWithSessionMode` spawned the agent's process monitor with the caller's
context:

```go
go h.monitorProcessExit(ctx, process, agentType, cred, startup.settings)
```

For a snapshot-restored session that `ctx` is `r.Context()` of the HTTP restore
request (`handleRestoreAgentSession` → `restoreSessionSnapshot` → `RestoreAgent`
→ `selectAgent` → `startSelectedAgent`). Go's `http.Server` cancels it the moment
the handler returns. The monitor is not doing anything with the context at that
point, so nothing fails and nothing logs.

Half an hour later the user pressed **Stop**. The intentional process stop is
supposed to be followed by an automatic restart that LoadSession-resumes the same
conversation — and the restart ran its container exec, auth-file write and ACP
handshake under that long-dead context:

```
14:35:36.204  git-token fetch failed: context canceled
14:35:36.205  agent_restart_failed: failed to write auth file:
              create auth file parent dir: command failed: context canceled
```

Two production Codex sessions on 2026-09-08 lost their runtime this way. Both had
to be recovered onto replacement workspaces (~15m08s and ~9m30s from Stop to a
usable agent), and a user's uploaded file did not survive the replacement.

Two properties made it survive review and a large test suite:

1. **The cancellation and the failure are far apart in time and in code.** The
   defect is at the `go` statement; the symptom is in an unrelated I/O call in a
   different file, minutes to hours later, on a code path (restart) that the
   request never exercised.
2. **Every existing test hand-fed a live context.** `monitorProcessExit` was
   always called directly as `monitorProcessExit(context.Background(), …)` —
   including the test written specifically for the intentional-cancel restart.
   That is `.claude/rules/62` exactly: the tests constructed the condition whose
   absence is the bug, so they could not observe it. The one production caller
   that happened to be correct (`startAgentWithPromptObserved`, which passes
   `context.Background()`) is the one the tests were modelled on.

## Class of Bug

**A context whose cancellation scope is narrower than the work holding it.** The
context is valid at capture and dead at use. Nothing is nil, nothing panics, no
type changes, and the goroutine keeps running — it just fails every operation it
attempts, usually with a bare `context canceled` that reads like a transient
error rather than a structural one.

The tells:

- `go someLoop(ctx, …)` inside a function reachable from an `http.Handler`, a
  WebSocket message dispatcher, or an RPC handler.
- A context stored on a long-lived struct, or captured by a closure that is
  registered as a callback/timer/monitor.
- Repeated `context canceled` in logs for an operation nobody cancelled.
- A comment or test asserting the behaviour with `context.Background()` while
  production supplies a request context.

It is the Go sibling of `.claude/rules/43`'s "VM job contexts must be independent
of the HTTP request context after acceptance" — that rule covers the accepted
work being cut off mid-flight; this one covers work that starts _later_ and can
never succeed at all.

## Hard Requirements

1. **Name the owning lifetime before you pass a context across a `go`.** For each
   spawned goroutine, state which of these it belongs to: the request/connection,
   one bounded attempt, or the resource. Only the first may use the caller's
   `ctx`.

2. **Resource-lifetime work uses a resource-lifetime context.** Provide it as an
   explicit accessor on the owning type (`SessionHost.lifecycleContext()`), not by
   reaching into a field, so the intent is greppable and a nil field cannot reach
   a goroutine. It must be cancelled by the owner's teardown — verify that,
   because an uncancellable context is a different bug in the other direction.

3. **Do not widen a context in place.** Keeping the caller's `ctx` for the
   startup/attempt I/O while handing the long-lived worker the resource context is
   the correct shape. Replacing the caller's context everywhere makes an abandoned
   request uninterruptible.

4. **Never hand a bounded attempt-timeout context to a long-lived worker.** A
   worker given `context.WithTimeout(...)` inherits that deadline forever and dies
   silently once it elapses. Derive attempt timeouts _downward_ from the resource
   context, never upward into it.

5. **Enumerate every caller when auditing.** A single correct caller proves
   nothing about the others; here one of three production entry points passed
   `context.Background()` and looked like evidence the pattern was safe
   (`.claude/rules/44`, `.claude/rules/61`).

## Required Tests

- **Enter through the real trigger and kill the caller's context.** Start the
  work through the production entry point, cancel that context to model the
  request returning, _then_ trigger the later operation. Calling the long-lived
  worker directly with a fresh context cannot observe this class at all.
- **Assert on the context the later operation actually received**, via a hook the
  production path already calls, not only on the end state. "It still worked" can
  be true for the wrong reason; `ctx.Err() == nil` at the restart boundary is the
  claim.
- **Cover every entry point** that supplies a doomed context, as a table.
- **A teardown control**: the resource context must be cancelled by the owner's
  Stop/Close, and the worker must not perform its action after teardown. Without
  this, the fix trades a wedge for a leak.
- **Proven discriminating.** Revert the `go` statement alone and confirm exactly
  the incident test goes red with the production error text; restore it. Record
  which test went red for which change in the PR.

## Quick Compliance Check

- [ ] Every `go` that crosses a request boundary was classified: request, attempt,
      or resource lifetime
- [ ] Resource-lifetime work uses a named accessor for the owner's context
- [ ] That context is cancelled by the owner's teardown, and a test proves it
- [ ] Caller `ctx` is still used for the in-request attempt itself
- [ ] No bounded-timeout context is handed to a long-lived worker
- [ ] The incident test enters through the real trigger and cancels the caller
- [ ] The incident test was verified to fail on pre-fix code

## References

- Idea `01M0644866Q0000M4HP39WNCZW`; task
  `tasks/active/2026-09-08-restored-host-restart-context-ownership.md` (moves to
  `tasks/archive/` on completion)
- Implementation: `packages/vm-agent/internal/acp/session_host.go`
  (`lifecycleContext`), `session_host_startup.go` (`startAgentWithSessionMode`)
- Tests: `packages/vm-agent/internal/acp/session_host_restart_context_test.go`
- `.claude/rules/43-long-running-mcp-tools.md` — the in-flight-deadline sibling
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — why every existing
  test passed
- `.claude/rules/49-capture-prerequisites-before-async-completion.md` — the
  same shape for captured _values_ rather than contexts
- `.claude/rules/57-write-only-cross-boundary-state.md` — why a wedged activity
  mirror breaks three consumers at once
- `.claude/rules/46-vm-agent-diagnostic-getter-sync.md` — the other long-lived
  goroutine hazard in this package
