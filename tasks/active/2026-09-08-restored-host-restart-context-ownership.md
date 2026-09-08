# Restored SessionHost retains the restore request context for later agent restarts

- **Idea:** `01M0644866Q0000M4HP39WNCZW` (Stop/cancel leaves Codex ACP sessions wedged
  or recovering by workspace replacement — session activity reliability)
- **Scope:** fix sequence **A** only ("Pin down and fix restart ownership first").
  B/C/D remain open on the idea.

## Problem

Press **Stop** during an active Codex ACP turn on a snapshot-restored session, send a
follow-up, and get no response. The chat looks receptive while the runtime cannot accept
work. Both production occurrences on 2026-09-08 ended in recovery onto a replacement
workspace.

Production evidence (incident A, chat `59627e44-f36b-4bd5-9ccc-59edcc242795`):

```
14:35:34.927  Prompt cancel requested
14:35:34.931  Stopping ACP agent process
14:35:35.150  Attempting agent restart after user prompt cancel
14:35:36.204  git-token fetch failed: context canceled
14:35:36.205  agent_restart_failed: failed to write auth file:
              create auth file parent dir: command failed: context canceled
14:47:50.129  old SessionHost stopped
14:50:43.031  replacement workspace Agent ready      (15m08s after Stop)
```

Incident B is the same signature 30 minutes later (9m30s Stop → replacement).

## Root cause

`startAgentWithSessionMode` spawned the process monitor with the caller's context:

```go
go h.monitorProcessExit(ctx, process, agentType, cred, startup.settings)
```

For a restored session that `ctx` is `r.Context()` of the HTTP restore request:

```
handleRestoreAgentSession (r.Context())
  -> restoreSessionSnapshot
    -> SessionHost.RestoreAgent
      -> selectAgent -> startSelectedAgent
        -> startAgentForCrashRecovery -> startAgentWithSessionMode
          -> go monitorProcessExit(ctx, ...)          <-- captured here
```

`http.Server` cancels it when the handler returns. Nothing fails at that moment.
Later, `StopProcessForPromptCancel` ends the process, and `monitorProcessExit`
reuses the retained context for `restartAgentLocked` → `startAgent` →
`prepareAgentStartup` → credential injection → `execInContainer mkdir`, which
fails immediately with `context canceled`. The restart can never succeed for the
rest of the host's life.

`Gateway.handleMessage -> SelectAgent` has the identical defect with the viewer
WebSocket's context (a closed browser tab poisons every later restart).
`startAgentWithPromptObserved` passes `context.Background()` and was unaffected —
which is why the task-mode path never showed this, and why the pattern looked safe.

Second defect on the same path: `restartAgentLocked`'s failure branch was the only
terminal branch in `monitorProcessExit` that did not `reportActivity("error")`.
The detach path publishes `recovering`; with no closing transition the control-plane
activity mirror stayed `recovering` indefinitely, wedging all three of its consumers
at once (rule 57) — stop button/composer, durable-message delivery gate, and the idle
scheduler (so the dead host also never slept).

## Fix

1. `SessionHost.lifecycleContext()` — named accessor for the host-scoped context
   created in `NewSessionHost` and cancelled only by `Stop()`, with a
   `context.Background()` fallback so a struct-literal host can never hand a
   goroutine `nil`.
2. `startAgentWithSessionMode` spawns `monitorProcessExit` with
   `h.lifecycleContext()`. Startup I/O below it deliberately keeps the caller's
   `ctx`, so an abandoned request still aborts its own attempt. Host lifetime and
   startup-attempt lifetime stay separate.
3. `restartAgentLocked` reports `activity="error"` on restart failure, carrying the
   already-redacted `statusErr` so the restart diagnostic survives into the control
   plane.

4. `monitorProcessExit` takes **no context parameter at all**. Its restart context is
   derived at the point of use, so there is no argument through which a
   request-scoped context can be reintroduced. This also deletes the hand-fed
   `context.Background()` argument from nine existing tests — the exact rule-62
   pattern that hid the bug.
5. Each restart attempt is bounded by `ACP_RESTART_ATTEMPT_TIMEOUT`
   (`DefaultACPRestartAttemptTimeout`, 5m), derived **downward** from the lifecycle
   context. `monitorProcessExit` holds `h.mu` for the whole attempt and `Stop()`
   needs `h.mu`, while `execInContainer` has no timeout of its own — so an unbounded
   attempt against a wedged container runtime would have traded the original wedge
   for an un-stoppable host. The bound is never handed to the replacement process's
   monitor (rule 71, requirement 4).
6. The five pre-existing direct `h.ctx` readers now go through `lifecycleContext()`,
   so the package has one convention for the host lifetime rather than two.

No control-plane, schema, or protocol change. One new env var
(`ACP_RESTART_ATTEMPT_TIMEOUT`, documented in the public reference). Existing restart
budget, `HostStopped` guards, and rollover/crash-recovery paths (which already carry
their own independently-bounded `operationCtx`) are untouched. `lifecycleContext()`
lives in `session_host_lifecycle.go`, not `session_host.go` — that file is
pre-existing debt at 1249 lines, past rule 18's 800-line mandatory-split threshold,
and this change deliberately does not grow it.

## Tests

`packages/vm-agent/internal/acp/session_host_restart_context_test.go`

| Test | Asserts |
|---|---|
| `RestartAfterCancelSurvivesFinishedCallerRequest` (2 cases) | Start via real `RestoreAgent` / `SelectAgent`, cancel the caller's context, then `StopProcessForPromptCancel`. Restart's startup context is live; host returns `HostReady`; same ACP session resumed via LoadSession; zero `NewSession`; no `error` activity. |
| `FailedRestartReportsErrorActivity` | A genuinely failing restart reports `recovering` → `error` (never `idle`), with the failure reason in `statusError`. |
| `RestartContextIsDerivedFromHostLifecycle` | The load-bearing control: cancels the host lifecycle **while a restart attempt is in flight** and asserts that attempt's context observes it. |
| `RestartAttemptIsBoundedButDoesNotLeakIntoNextMonitor` | The attempt is bounded, and after that bound elapses a second Stop→restart still succeeds (so the bound did not leak into the replacement's monitor). |
| `FailedCrashRecoveryRestartReportsErrorActivity` | The crash-recovery flavour of the same failure branch reports exactly one `error` and no `idle`. |
| `RestartAttemptTimeoutIsConfigurable` | The bound comes from config, not a literal. |
| `LifecycleContextIsCancelledByStop` | Control: the host context IS cancelled by `Stop()`, and the struct-literal fallback is non-nil and live. |
| `MonitorSkipsRestartAfterStop` | Control: a process exit after `Stop()` starts no replacement. |

Discrimination verified (each revert done in isolation, then restored):

- Reverting only the `go` statement → both `RestartAfterCancelSurvivesFinishedCallerRequest`
  cases fail with `restart startup context err = context canceled`, reproducing the
  production error text. Both controls stay green.
- Reverting only `reportActivity("error")` → `FailedRestartReportsErrorActivity` and
  `FailedCrashRecoveryRestartReportsErrorActivity` fail; everything else stays green.
- Reparenting the restart context to `context.Background()` →
  `RestartContextIsDerivedFromHostLifecycle` fails. That test exists *because* review
  proved the two obvious controls (`LifecycleContextIsCancelledByStop`,
  `MonitorSkipsRestartAfterStop`) leave the **entire package suite green** under this
  mutation: the first only exercises the accessor in isolation, and the second passes
  on the pre-existing "process replaced" guard, not on context cancellation.
- Handing the bounded attempt context to the replacement process's monitor →
  `RestartAttemptIsBoundedButDoesNotLeakIntoNextMonitor` fails with
  `second restart context err = context canceled`. (A first attempt at this simulation
  passed for the wrong reason — it refreshed the leaked context each cycle instead of
  retaining it — so it was redone faithfully.)

Suite: `go test -race ./...` in `packages/vm-agent` — 23 packages ok, 0 failures.

## Post-mortem

- **What broke:** Stop during a Codex turn on a restored session left the host unable
  to restart its agent; the session appeared receptive but produced nothing, and was
  eventually recovered onto a replacement workspace.
- **Root cause:** a goroutine whose lifetime is the resource's captured a context whose
  lifetime is the request's. Introduced with the snapshot restore path; latent until a
  restart is attempted after the request returns.
- **Why it wasn't caught:** every test for the restart path called `monitorProcessExit`
  directly with `context.Background()` — hand-feeding the live context whose absence is
  the bug (rule 62). The one production caller that already passed `context.Background()`
  made the pattern look verified.
- **Class of bug:** a context whose cancellation scope is narrower than the work holding
  it. Valid at capture, dead at use, far apart in both time and code; surfaces as a bare
  `context canceled` that reads transient.
- **Process fix:** `.claude/rules/71-request-context-must-not-outlive-its-request.md`.

## Known coverage boundary

The tests observe the restart context at `RuntimeAssetsProvider`, a real production
startup hook that receives it unmodified. That is **not** the incident's own failure
site: that was `injectAuthFileCredential` → `writeAuthFileToContainer` →
`execInContainer`, which needs `agentType=openai-codex` **and** a resolved container,
whereas `RuntimeAssetsProvider` is only wired for lightweight standalone sessions.
`ctx` is threaded as one unmodified value through both, so the property under test is
the same — but a change that re-derived a context specifically inside the
codex/container branch would not be caught here. Docker is unavailable in unit tests;
the package's fake-`docker`-on-PATH harness (`gateway_test.go`) is the route if this
is ever worth closing.

## Not in this change (still open on the idea)

- B — turn-end reconciliation identity/observability (chat vs SAM ACP vs native ACP ids,
  bounded turn-end reasons, follow-up duplicate ingress).
- C — superseded-predecessor status convergence.
- D — private upload continuity across workspace replacement.

**Interaction to watch when B lands:** this change alters the steady state. A
Stop-triggered restart on the restore/WebSocket paths previously *always* failed and
ended in a replacement workspace; it now resumes the same session in place. B's
turn-end identity and duplicate-ingress work should be validated against successful
in-place resume, not only against the replacement path it would have seen before.

**Pre-existing debt noticed, not addressed:** `session_host.go` is 1249 lines, past
rule 18's mandatory-split threshold. This change does not add to it; the split is
still owed.
