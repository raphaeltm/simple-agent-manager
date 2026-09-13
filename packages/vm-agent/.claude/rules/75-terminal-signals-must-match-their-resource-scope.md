# A Terminal Signal May Only Shut Down State At The Scope Of The Resource It Names

## When This Applies

Any code that reacts to a "this is permanently gone" signal by disabling something
**wider** than the thing the signal named:

- an HTTP status (`401`/`403`/`404`/`410`) from one endpoint stopping every endpoint
- one workspace's failure disabling a node-level loop
- one session's error tearing down a shared client, pool, or reporter
- a `sync.Once` / `atomic.Bool` kill switch reachable from more than one caller

The tell is a process-wide or connection-wide latch (`atomic.Bool`, package-level
flag, `close(ch)`) whose setter is called from handlers that each speak for a
*different* resource.

## Why This Rule Exists

On 2026-09-13 production node `01M2CP77EV4GMCA28KXSX7J0BJ` went silent while
running perfectly. An orchestrator cancelled one task; the VM agent POSTed that
task's status callback; the control plane's workspace compare-and-swap fence
(`apps/api/src/routes/workspaces/_helpers.ts`) correctly answered **410 Gone** —
"this callback's workspace state changed". `isTerminalControlPlaneCallbackStatus`
mapped 410 to "terminal" and the single node-wide
`markControlPlaneCallbacksTerminal` latched.

Consequences, none of them logged as an error, on a node with two other healthy
workspaces:

- the node heartbeat goroutine `return`ed permanently; the control plane marked the
  node `unhealthy` six minutes later and stopped scheduling onto it
- the ACP heartbeat goroutine `return`ed permanently
- every existing per-workspace message reporter was marked terminal
- **every future** reporter creation was suppressed, so a workspace started five
  minutes later never got one at all

A co-tenant task ran for another 11 minutes and completed successfully with none of
its output persisted. Another agent pushed a merge commit from that node 15 minutes
after its last heartbeat. The node was never unhealthy; only the reporting was.

The same latch had a second, more frequent trigger nobody had noticed: the ACP
heartbeat is addressed **per project** and returns 410 whenever any single workspace
on the node is deleted (`node-acp-heartbeat.ts` `terminalResourceResponse` with
`kind: 'workspace'`), plus 403 for a project the token is not bound to.

Introduced by PR #1922 "stop zombie callback storms" (`3e74a0851`), whose goal —
stop a *deleted node* hammering the control plane — was right. Only the scope was
wrong.

## Class Of Bug

**A correctly-detected terminal condition applied at the wrong blast radius.** It is
the availability-side sibling of `.claude/rules/74`: there a gate fires on a signal
merely correlated with its condition; here the signal is accurate but the *action*
is wider than the signal's subject.

It is invisible in review because the detection code is obviously correct — 410
really does mean gone — and the diff that adds a fifth caller to an existing
kill-switch helper looks like consistency, not escalation. It is invisible in
production because the symptom is an **absence**: things that stop happening.

Tells:

- one function name contains a plural or a scope the caller does not own
  (`...AllReporters`, `markControlPlaneCallbacksTerminal`) and is called from a
  per-resource handler
- the same status code is produced by the server at two different scopes, and the
  client has no way to tell them apart
- a latch that can only ever be set, never cleared, for the process lifetime
- the shut-down set includes the very signal that reports health

## Hard Requirements

1. **Name the resource the signal is about, and the resource you are shutting
   down.** If they differ, the shutdown is wrong. Write both in a comment at the
   branch.

2. **Make the scope an explicit parameter, not a convention.** Every caller of a
   wide kill switch must state its scope at the call site, and the switch itself
   must enforce it. A helper that is "only called from node-level code" acquires a
   workspace-level caller within two PRs. In this package that is
   `handleTerminalControlPlaneCallback(operation, scope, ...)`; the node-wide
   `markControlPlaneCallbacksTerminal` is unexported and unreachable except through
   it.

3. **Derive latch authority from the endpoint's own addressing, not the status.**
   `/api/nodes/:id/...` can only be terminal because that node is gone.
   `/api/projects/:id/...` and `/api/projects/:pid/tasks/:tid/...` cannot vouch for
   the node. When the server multiplexes scopes behind one status code, the client
   must key on which endpoint it called.

4. **Never shut down the liveness reporter as a side effect of anything else.** The
   heartbeat is how the control plane distinguishes "dead" from "quiet". Silencing
   it converts any bug into a phantom-dead node, and a phantom-dead node is
   indistinguishable from a real one at the control plane.

5. **Prefer no action to an over-broad action.** Before widening, check whether a
   narrower authority already covers the case. Here the node heartbeat runs on the
   same 60 s cadence with the same token, so removing latch authority from three
   callers lost nothing: a genuinely deleted node is still caught, one tick later.

6. **A "stop everything" path must be reachable from exactly one condition.** Count
   the callers. If there is more than one, each needs its own justification recorded
   in the PR.

## Required Tests

- **Divergence, through the real sender.** Drive the actual send function against an
  `httptest` server that returns the terminal status **only on the path under test**
  — a fixture that returns it for every path will latch on the test's own liveness
  probe and mask the result.
- **One assertion per consequence, not just the flag.** Assert the heartbeat still
  sends, the existing reporter is still handed out, and a *newly created* resource
  still gets one. A flag-only assertion passes if a later refactor rewires a
  consequence to a different flag.
- **Liveness beside every negative** (`.claude/rules/62` #5): assert the callback
  was actually attempted and actually saw the status, so "did not latch" cannot mean
  "was never sent".
- **A convergence control per node-scoped caller.** Without one, the suite passes
  with the entire guard deleted.
- **Proven discriminating, per call site.** Revert the guard, then revert each call
  site's scope individually, and record which tests reddened for which revert. If
  reverting one call site reddens nothing, that call site has no coverage.

## Quick Compliance Check

- [ ] The signal's subject and the shutdown's subject are named and identical
- [ ] Scope is an explicit parameter enforced by the kill switch, not a convention
- [ ] Latch authority follows endpoint addressing, not the status code
- [ ] The liveness/heartbeat path is not collateral damage of any other failure
- [ ] A narrower existing authority was checked before widening
- [ ] Every caller of the wide path is enumerated and justified in the PR
- [ ] Divergence tests are terminal only on the path under test
- [ ] One assertion per downstream consequence, each with a liveness assertion
- [ ] A convergence control exists per node-scoped caller
- [ ] Each call site was reverted separately and the reddened tests recorded

## References

- Implementation: `packages/vm-agent/internal/server/callback_terminal.go`
  (`callbackScope`, `handleTerminalControlPlaneCallback`)
- Tests: `packages/vm-agent/internal/server/task_callback_terminal_test.go`
- Task: `tasks/archive/2026-09-13-scope-callback-terminal-latch.md`
- `packages/vm-agent/.claude/rules/34-vm-agent-callback-auth.md` — terminal callback classification
- `.claude/rules/74-proxy-signals-must-match-the-condition.md` — the correlation sibling
- `.claude/rules/67-shared-predicates-that-trigger-actions.md` — never widen a shared predicate that drives an action
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — divergence, liveness, discrimination
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md` — never conflate liveness with idleness
