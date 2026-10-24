# A failed Instant acceptance leaves `creating` node and workspace rows behind

Filed from the T7 Cloudflare specialist review (task
`tasks/active/2026-10-24-start-work-replaces-execute.md`). Pre-existing; not introduced
by T7, which is why it is tracked here rather than fixed in that branch.

## Problem

`acceptInstantSession` (`apps/api/src/services/instant-session.ts`) creates, in order:

1. a `nodes` row with `status: 'creating'` (`services/nodes.ts:createNodeRecord`)
2. a `workspaces` row with `status: 'creating'`
3. a ProjectData Durable Object chat session
4. the optional context-summary message and the first user message
5. (new in T7) the session → idea link, when the start came from an idea

Both callers handle a throw from this function by marking only the **task** terminal:

- `routes/chat-start.ts` → `markTaskFailedIfNonTerminal(...)`
- `services/submit-instant-task.ts` → `transitionTaskToTerminal(..., stopWorkspace: false)`

Neither tears down the `nodes` / `workspaces` rows. No container has been launched at that
point, so nothing leaks at the infrastructure layer, but the D1 rows sit at `creating` with
a `failed` task pointing at them. `continueInstantSessionLaunch`'s own catch block does the
full closure (`finalizeWorkspaceLifecycleClosure`, container destroy, workspace/node marked
`error`) — acceptance has no equivalent.

Steps 3 and 4 have always been Durable Object RPCs that can fail this way, so the window is
not new. T7 adds a fifth RPC-backed failure mode inside it.

## What already limits the damage

`apps/api/src/scheduled/node-cleanup/node-phases.ts` destroys a node past its absolute
lifetime ceiling when only stale workspaces remain, so these rows are eventually reaped
rather than immortal. What is missing is a prompt, intentional closure.

## Acceptance criteria

- [ ] Enumerate every caller of `acceptInstantSession` and every throw site inside it
      (`.claude/rules/44-dual-write-migration-enumerate-writers.md`).
- [ ] A failed acceptance closes the node and workspace rows it created through the same
      shared finalizer the launch path uses, rather than leaving them at `creating`
      (`apps/api/.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`, the
      lifecycle-finalizer section of `44`).
- [ ] A regression test per caller: make a late step inside `acceptInstantSession` throw
      and assert no `creating` node or workspace row survives, with an owner control
      proving a successful acceptance still leaves its rows alone. Prove it discriminating.
- [ ] Confirm whether the existing absolute-lifetime sweep is the only backstop, and say so
      in the PR.
