# Scope the VM-agent control-plane callback terminal latch to node-scoped callbacks

**Status:** active
**Created:** 2026-09-13
**Origin:** Production incident on node `01M2CP77EV4GMCA28KXSX7J0BJ`, diagnosed from
`debug-01M2CP77EV4GMCA28KXSX7J0BJ.tar.gz` + prod D1.

## Problem

A **task-scoped** `410 Gone` permanently shuts down **node-wide** control-plane
callbacks on the VM agent. The node keeps working; the control plane stops hearing
from it, marks it `unhealthy`, and every co-tenant workspace on that node silently
stops persisting its chat transcript.

### Observed production sequence

| Time (UTC, 2026-09-13) | Event |
| --- | --- |
| 06:15:45.586 | Last node heartbeat from `01M2CP77EV4GMCA28KXSX7J0BJ` |
| 06:15:45.657 | Last chat message ever persisted for co-tenant task `01M2CPDW0F48DC06JYXQRBDHM0` (PR Shepherd run 57) |
| 06:15:56.626 | Task `01M2CP6P9WEB5STQ532TJ9TNX9` cancelled — `Stopped by parent: Orchestrator is re-dispatching this task` |
| 06:15:56.976 | VM agent POSTs that task's status callback. `apps/api/src/routes/workspaces/_helpers.ts:194` CAS fence sees changed workspace state → **410** `Workspace callback state changed; callback resource is gone` |
| 06:15:56.977 | `markControlPlaneCallbacksTerminal("task_callback", 410)` latches `callbacksTerminal` **node-wide** |
| 06:16:45 | Heartbeat ticker fires, sees the latch, `return`s — goroutine gone for the process lifetime |
| 06:21:48 | `refreshNodeHealth` writes `health_status='unhealthy'` (heartbeat age > 2 × 180 s) |
| 06:22:55 | A *new* workspace's agent starts. No message reporter is created (`server.go:1271`). Its chat stays empty. |
| 06:26:33 | Co-tenant PR Shepherd task **completes successfully** — 11 min of its output never persisted |
| 06:30:36 | The "unhealthy" node pushes a merge commit to `sam/eventing-integration` — proof the node was fine the whole time |

Blast radius per latch, all silent, all on a healthy node:

- node heartbeat goroutine exits permanently (`health.go:71`)
- ACP heartbeat goroutine exits permanently (`acp_heartbeat.go:44`)
- every existing per-workspace message reporter is marked terminal
- **every future** message reporter creation is suppressed (`server.go:1271`, `:1217`, `:1290`)
- the error reporter drops its queue

Introduced by PR #1922 "stop zombie callback storms" (`3e74a0851`, 2026-08-26).

## Root cause

`isTerminalControlPlaneCallbackStatus` (`packages/vm-agent/internal/server/callback_terminal.go:12`)
maps `401/403/404/410` to "terminal", and **every** call site funnels into the single
node-wide `markControlPlaneCallbacksTerminal`. But the control plane uses those statuses at
**two different scopes**:

| Scope | Meaning | May latch node-wide? |
| --- | --- | --- |
| node | "this node row is deleted/destroyed/stopped" | yes |
| workspace / task | "this callback's resource moved on" (a routine race) | **no** |

This is `.claude/rules/74`: the gate keys on a signal (*any* terminal status) that merely
correlates with its condition (*this node is gone*).

### Research findings — which callbacks may latch

| Agent operation | Endpoint | 410/4xx sources | Scope verdict |
| --- | --- | --- | --- |
| `node_ready` | `POST /api/nodes/:id/ready` | only `rejectTerminalNodeCallback` (`node-lifecycle.ts:56-68`) | **node-scoped — keeps latch authority** |
| `node_heartbeat` | `POST /api/nodes/:id/heartbeat` | only `rejectTerminalNodeCallback` (`node-lifecycle.ts:372`, `:496`) | **node-scoped — keeps latch authority** |
| `node_acp_heartbeat` | `POST /api/projects/:id/node-acp-heartbeat` | `terminalResourceResponse` 410s for `kind:'workspace'` too (`node-acp-heartbeat.ts:222-240`); 403 `Callback token not authorized for this project` (`:122`) is a per-project verdict | **mixed — loses latch authority** |
| `task_callback` | `POST /api/projects/:pid/tasks/:tid/status/callback` | workspace CAS fence 410 (`workspaces/_helpers.ts:194`), `_callback-auth.ts:83/107/163/182` | **task-scoped — loses latch authority** |

Losing latch authority does **not** reintroduce the zombie storm PR #1922 fixed: on a
genuinely deleted node, `node_heartbeat` runs on the same 60 s cadence with the same token
and 410s, which still latches everything. `node_heartbeat` is the single sufficient authority.

Other findings:

- `postTaskCallback` is **fire-and-forget** — one POST, no retry loop (`server.go:1529-1580`,
  callers at `:1404-1476`). So a terminal task-callback status needs only a bounded log;
  there is nothing to stop. Per `.claude/rules/34` item 3 it must log **below** error severity.
- `messagereport/sender.go:161` (`isTerminalBatchResponse`) and
  `errorreport/reporter.go:499,508` have their own terminal classification. Both target
  correctly-scoped endpoints (per-workspace messages, `/api/nodes/:id/errors`) and are
  **out of scope** — no change.
- `disableMessageReportersForTerminalCallbacks` fan-out is correct once the latch itself is
  node-scoped (node gone ⇒ all its reporters are dead). **No change.**
- `packages/vm-agent/internal/server/task_callback_terminal_test.go` currently **asserts the
  bug as the contract** (`.claude/rules/42`). It must be rewritten, not deleted.
- `acp_heartbeat_test.go:132` asserts latch-on-terminal for all four statuses; its
  expectation inverts for this operation.
- `health_test.go:109` asserts latch-on-terminal for `node_heartbeat` — stays valid, and
  becomes the convergence control.

### Deliberate non-changes

- **The effect of a genuine node-scoped latch is unchanged.** Killing the heartbeat when the
  node row really is gone is PR #1922's intended behaviour; narrowing the *effect* as well as
  the *trigger* would risk re-opening that incident and is not what this defect requires
  (`.claude/rules/39`: fix the existing system precisely).
- **No API change.** Fixing this agent-side keeps it rollout-safe in both directions
  (`.claude/rules/54`): a new agent against an old API behaves correctly, and an old agent
  against the current API is no worse than today.

## Implementation Checklist

- [ ] Introduce an explicit callback scope in `callback_terminal.go`: only node-scoped
      callbacks may latch. Name the condition in a comment so the next reader cannot
      re-widen it by accident.
- [ ] `postTaskCallback` (`server.go:1563`): on a terminal status, log at bounded severity
      with taskId/status/body and return. Do **not** latch.
- [ ] `sendAcpHeartbeatForProject` (`acp_heartbeat.go:135`): on a terminal status, log via
      the existing bounded `logAcpHeartbeatNonSuccess` path. Do **not** latch.
- [ ] `sendNodeReady` (`health.go:116`) and `sendNodeHeartbeat` (`health.go:250`): keep
      latch authority, routed through the node-scoped entry point.
- [ ] Rewrite `task_callback_terminal_test.go` to assert the corrected contract.
- [ ] Update `acp_heartbeat_test.go` terminal expectations.
- [ ] Add divergence tests (see Acceptance Criteria) proving a task-scoped and an
      ACP-heartbeat terminal status leave heartbeats, existing reporters, and new reporter
      creation intact.
- [ ] Keep `health_test.go` convergence control green unchanged.
- [ ] Prove the fix discriminating: revert the production change only, confirm exactly the
      new divergence tests go red and the convergence controls stay green. Record in the PR.
- [ ] Add `.claude/rules/` guidance (scoped to `packages/vm-agent/`) for the class:
      a terminal signal may only shut down state at the scope of the resource it names.
- [ ] `pnpm check:fast`, `pnpm typecheck`, Go tests green.

## Acceptance Criteria

1. A `410` (and `401`/`403`/`404`) on a **task status callback** does not latch node-wide
   state. Verified by a test that drives `postTaskCallback` against an `httptest` server
   returning the status, then asserts:
   - `controlPlaneCallbacksStopped()` is false, **and**
   - a subsequent `sendNodeHeartbeat()` actually reaches the server (liveness assertion —
     `.claude/rules/62` #5), **and**
   - an existing message reporter is not terminal, **and**
   - `getOrCreateReporter` still returns a reporter.
2. Same for a terminal response to `node_acp_heartbeat`.
3. A `410`/`401`/`403`/`404` on **`node_heartbeat`** still latches everything (convergence
   control — without this the suite passes with the whole guard deleted).
4. A `410` on **`node_ready`** still latches.
5. Each divergence test is proven to fail against pre-fix code; the reddened test names are
   recorded in the PR.
6. No behaviour change to `messagereport` / `errorreport` per-resource terminal handling.

## References

- `.claude/rules/74-proxy-signals-must-match-the-condition.md` — the governing class
- `.claude/rules/67-shared-predicates-that-trigger-actions.md` — never widen a shared predicate that drives an action
- `.claude/rules/62-tests-must-observe-the-real-trigger.md` — divergence + convergence + liveness + discrimination proof
- `.claude/rules/42-no-untracked-degrading-placeholders.md` — a test must not assert degraded behaviour as the contract
- `packages/vm-agent/.claude/rules/34-vm-agent-callback-auth.md` — terminal callback classification and logging severity
- `packages/vm-agent/.claude/rules/54-vm-agent-rollout-compatibility.md`
- PR #1922 / `3e74a0851` "fix: stop zombie callback storms" — the change that introduced the latch
