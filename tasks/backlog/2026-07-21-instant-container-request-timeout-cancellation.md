# Instant (cf-container) request-timeout race does not cancel the loser

## Problem

`fetchNodeAgent` (`apps/api/src/services/node-agent.ts`) races the cf-container
DO RPC (`fetchVmAgentContainer` → `VmAgentContainer.proxyHttp`) against a bare
`setTimeout`. On timeout it calls `markVmAgentContainerRequestInterrupted`, which
begins unexpected recovery (flipping the workspace/node/agent-session to
`recovery` in D1) — even though the DO RPC may still be in flight and succeed.

For a **slow-but-healthy** request that exceeds the interactive timeout, this is a
false recovery + a false "delivery interrupted" message to the user.

## Why the obvious fix does not work

Wiring an `AbortController`/signal to the container Request is a **proven
regression**: SPIKE PR #1544 ("avoid abort signal in container node fetch") is the
reason `requestInitWithoutSignal` strips the signal before the DO RPC. An
`AbortSignal` does not cross the JSRPC boundary cleanly, so it cannot cancel the
in-flight container fetch from the `fetchNodeAgent` layer.

## Intended fix

Move the per-request timeout INSIDE `VmAgentContainer.proxyHttp`, wrapping
`this.containerFetch(...)` (a real fetch that honors `AbortSignal`) with an
`AbortController`. This requires plumbing the caller's `requestTimeoutMs` budget
through `fetchVmAgentContainer` (`apps/api/src/services/vm-agent-container.ts`) and
`proxyHttp` — so the DO can distinguish the interactive budget (~30s) from the
create-workspace budget (~120s) and only abort/mark-interrupted when the request
is genuinely aborted, not merely slow.

## Acceptance criteria

- [ ] `proxyHttp` accepts a per-request timeout and aborts `containerFetch` via an
      `AbortController` when it elapses (real cancellation of the loser).
- [ ] `fetchNodeAgent` no longer marks the runtime interrupted for a request that
      the container fetch would have completed successfully.
- [ ] The create-workspace budget (`CF_CONTAINER_CREATE_WORKSPACE_TIMEOUT_MS`) is
      still honored — a long clone is not aborted by a shorter interactive timeout.
- [ ] Vertical-slice test: a slow-but-healthy container response past the
      interactive timeout is preserved (no `beginUnexpectedRecovery`, no D1 flip to
      `recovery`); a genuinely aborted/dead request still begins recovery.
- [ ] Remove the "Known limitation" comment in `node-agent.ts` referencing this task.

## Context

Discovered during code review of the Instant runtime recovery state machine
(finding CF4, branch `sam/diagnose-fix-remaining-production-0dvhf5`). Marked a
JUDGMENT / MEDIUM call; the reviewer accepted the bounded documented deferral
because the preferred signal-wiring is unsafe and the complete fix spans a
non-owned service file.
