# Fix eight verified state-machine defects

## Problem

The 2026-11-10 state-machine audit (Library `/engineering/research/state-machines-2026-11-10/00-state-machine-map.md`, section 5, rows marked ✅) found eight defects that the lead re-verified in code. Each one is a writer or reader that uses the wrong status vocabulary or writes without the status predicate its machine needs. Scope is exactly these eight; the broader recommendations (shared value sets for every status, transition helpers everywhere) are out of scope.

## Research findings

### D1. Orchestrator stall detection never checks running tasks
- `apps/api/src/durable-objects/project-orchestrator/stall-detection.ts:31` filters `task.status === 'running' || 'delegated'`. `running` is not a `TaskStatus` (`packages/shared/src/types/task.ts:11`); `StallTaskRow.status` is typed `string` (`:10`), so this compiles. Mission tasks that are `in_progress` are never checked.
- Fixing only the filter would be harmful:
  - The progress signal is `tasks.updated_at`, which `update_task_status` does not bump (`routes/mcp/task-tools.ts:44`), and neither does agent output.
  - The nudge is sent with `messageClass: 'interrupt'`, and `isUrgentMessageClass` cancels the target's in-flight turn (`packages/shared/src/types/mailbox.ts:46`).
  - So a correct filter on the stale signal would cancel every mission agent working longer than `ORCHESTRATOR_STALL_TIMEOUT_MS` (20 min default).
- Rule 74 states the condition and the signal separately:
  - **Condition:** the task has made no progress.
  - **Signal used:** `tasks.updated_at`.
  - **Divergence:** progress reports and agent messages do not touch it.
  - **Better signal, available in the same read:** the active chat session's `lastMessageAt` from `getSessionsByTaskIds` (`project-data/session-reads.ts:114`).
- Hung in-flight turns are already handled by the stuck-task sweep and check-in reconciliation. This nudge must therefore not cancel work: use `deliver`, which queues behind a busy turn and is delivered at once to an idle agent.

### D2. SAM stop/message tools reject normally running subtasks
- Both `sam-session/tools/stop-subtask.ts:19` and `sam-session/tools/send-message-to-subtask.ts:18` use `['queued','provisioning','running','awaiting_followup']`. That list includes two non-statuses and omits `in_progress` and `delegated`.
- The canonical sets are in `services/task-status.ts`:
  - `LIVE_TASK_STATUSES` holds a runtime.
  - `WAKEABLE_TASK_STATUSES` is live plus `sleeping`.
  - The MCP equivalents use `LIVE_TASK_STATUSES` (`routes/mcp/_helpers.ts:316`), and MCP stop also handles `sleeping` (`routes/mcp/orchestration-stop.ts:76,103`).
- The SAM stop cancel write is `WHERE id = ?` only, with an unconditional status event (`stop-subtask.ts:~125`). A concurrent completion can be overwritten. MCP stop already does a CAS plus a conditional event insert (`orchestration-stop.ts:134-150`), so reuse that shape.

### D3. VM agent WebSocket attach resurrects stopped/errored runtimes
- `agent_ws.go:72`, `websocket.go:196` and `websocket.go:340` call `upsertWorkspaceRuntime(id, "", "", "running", "")` before `requireWorkspaceReconnectState`.
- The upsert overwrites any status except `evicted`, provisioning or metadata-unavailable (`workspace_routing.go:250`). So a browser connect flips `stopped`, `error` or `recovery` to `running`.
- `"running"` is only needed when the runtime is missing and is being rebuilt from persisted metadata after an agent restart (`workspace_routing.go:335+`).
- Fix: an opts field (string, rule 73 compliant) that applies a status only when this call creates the runtime. Attach paths use it instead of the positional status.

### D4. Chat session `failed` vs shared `error`
- The ProjectData DO writes `chat_sessions.status = 'failed'` (`project-data/sessions.ts:430`) and never writes `error`. The API list/summary code uses `failed` (`routes/chats.ts:45,59`; `row-schemas/sessions.ts:48`).
- The shared `ChatSessionStatus` declares `'error'` (`packages/shared/src/types/session.ts:8`).
- Web consumers compare against `'error'` and never match:
  - `ChatSessionList.tsx:39` badges failed as stopped.
  - `account-map/connections-model.ts:113` never shows failed.
  - `project-message-view/types.ts deriveSessionState` maps a failed session with `agentCompletedAt` to `idle`.
- `chat-session-utils.ts:169` already checks `failed`. The web `ChatSessionListItem.status` is `string`, so the compiler cannot help.

### D5. Node status type and callback terminal set
- `NodeStatus` (`packages/shared/src/types/workspace.ts:6`) lacks `destroying` and `deleting`, which are written:
  - `destroying` by the cleanup sweep and manual deletion.
  - `deleting` by deployment-env deletion (`routes/deployment-environments.ts:445`).
- `deleting` only moves forward, to `deleted`, or to `error` if cleanup fails.
- `NODE_CALLBACK_TERMINAL_STATUSES` (`services/node-callback-auth.ts:39`) omits `deleting`. `/ready` and heartbeat guard their `running` writes with `notInArray(status, NODE_CALLBACK_TERMINAL_STATUSES)` (`routes/node-lifecycle.ts:200,498`), so a deployment node being deleted can be revived to `running`, and its token keeps refreshing.

### D6. Task-terminal → trigger-execution sync clobbers terminal executions
- `routes/tasks/_helpers.ts:335` (`setTaskStatus`) updates `trigger_executions` with `WHERE id = ?` only. It can overwrite `skipped`, `dropped`, `routed` or `completed`.
- The guarded helper `services/trigger-execution-sync.ts:syncTriggerExecutionStatus` already encodes the correct predicate: `status = 'running' OR (status = 'failed' AND error_message LIKE hard-max prefix)`.
- `setTaskStatus` only has a drizzle handle, so export one drizzle predicate builder from the sync module and use it in both places.

### D7. Deployment environment heartbeat read-then-write
- `routes/node-lifecycle.ts:603-669` reads `deployment_environments.status`, computes `starting → active/error`, then writes with `WHERE id AND node_id` only. A concurrent stop or start failure is overwritten.
- Fix: include `status = <read status>` in the write predicate. If it loses the race, skip this env's lifecycle event and release reconcile for this heartbeat; the next heartbeat re-reads.
- `node-lifecycle.ts` is 840 lines, over the 800-line hard limit (rule 18). Extract the deployment-heartbeat block into its own module first, in a separate commit.

### D8. Second wake of the same chat is suppressed
- `useWakeProgress.ts:89-118`: `settledRef` latches on `restored`/`failed` and only resets on `sessionId` change. After a wake settles, the chat sleeps again and is woken again in the same mount, so every `waking` update is dropped. `isWaking` stays false, and the socket gate `session.status === 'active' || wake.isWaking` (`useSessionLifecycle.ts:153`) stays closed.
- The latch exists to drop a stale `waking` snapshot that lands after `restored`. During that window the session is still `sleeping` (or just turned `active`).
- Re-arm only on an observed not-sleeping → `sleeping` transition (a new sleep episode). That keeps the stale-snapshot protection.

## Implementation checklist

- [x] Split `routes/node-lifecycle.ts`: extract the deployment heartbeat block (no behavior change), separate commit
- [x] D1: stall filter uses `in_progress`/`delegated` via typed `TaskStatus`; progress = max(`tasks.updated_at`, active session `lastMessageAt`); nudge class `deliver`; tests through `detectStalls` with realistic session rows
- [x] D2: SAM `send_message_to_subtask` uses `LIVE_TASK_STATUSES`; SAM `stop_subtask` uses `WAKEABLE_TASK_STATUSES`, skips the session stop for `sleeping`, CAS cancel with conditional status event; tests incl. concurrent-completion control
- [x] D3: `workspaceRuntimeOpts.CreateStatus`; attach paths use it; Go tests through real agent and terminal WS handlers (existing runtime `stopped`/`error` stays, missing runtime is created `running`)
- [x] D4: `ChatSessionStatus` = `active | sleeping | stopped | failed`; fix web consumers (`ChatSessionList`, `connections-model`, `deriveSessionState`); grep every `'error'` chat-status comparison; tests
- [x] D5: add `destroying`/`deleting` to `NodeStatus`; add `deleting` to `NODE_CALLBACK_TERMINAL_STATUSES`; route test proving `/ready` and heartbeat do not revive a `deleting` node (plus a `running` control)
- [x] D6: export shared drizzle predicate from `trigger-execution-sync.ts`; `setTaskStatus` uses it; real-SQL test proving `skipped`/`dropped` survive and `running` still syncs
- [x] D7: CAS on env status in heartbeat write; test: concurrent `stopping` survives the heartbeat; `starting → active` control
- [x] D8: `useWakeProgress(sessionId, sessionStatus)` re-arms on not-sleeping → `sleeping`; test second wake shows phases; control: late `waking` after `restored` while still `sleeping` stays suppressed
- [x] Docs: update any docs referencing chat `error` status / node statuses / stall detection
- [x] Playwright visual audit for changed UI surfaces (chat session list badge, account map failed state), 375 and 1280
- [ ] Staging: deploy; verify each defect fixed on live staging (see acceptance criteria)

## Acceptance criteria

- [ ] A mission task in `in_progress` whose session has had no messages for longer than the stall timeout receives one non-cancelling nudge. A task with recent messages receives none. An agent mid-turn is never cancelled by stall detection.
- [ ] SAM `stop_subtask` stops `in_progress`, `delegated`, `queued` and `sleeping` tasks, and `send_message_to_subtask` messages `in_progress` and `delegated` ones. A concurrent completion is not overwritten with `cancelled`.
- [ ] Opening the agent or terminal WebSocket on a VM agent runtime in `stopped`/`error` leaves its status unchanged. A runtime missing after an agent restart is still recreated as `running`.
- [ ] A failed chat session renders as failed on the account map. Revised during implementation:
  - The session list (`ChatSessionList`) turned out to be dead code and was removed.
  - `deriveSessionState`'s `idle` mapping for a failed session with `agentCompletedAt` is unchanged, because resume-and-send relies on it. Changing it is a product decision outside this scope; it is raised to Raphaël in the PR.
- [ ] `/ready` and heartbeat from a node in `deleting` do not set it to `running`, and do not refresh its callback token.
- [ ] A task reaching a terminal state does not overwrite a `skipped`/`dropped`/`routed` trigger execution, while a `running` execution is still synced.
- [ ] A deployment env heartbeat does not overwrite a concurrent `stopping`/`error`; `starting → active` still happens.
- [ ] A chat that wakes, sleeps again and is woken again in the same open tab shows the wake banner and phases on the second wake.
- [ ] Each guard was deleted once and its attack test went red (rule 62).
- [ ] All verified end to end on staging.

## References

- Library report: `/engineering/research/state-machines-2026-11-10/00-state-machine-map.md`
- Rules: 62 (real trigger), 73 (optional fields), 74 (proxy signals), 18 (file size), 28 (real SQL for predicates), 27/54 (VM agent staging), 17 (visual audit)

## Implementation notes

- **D1 changed shape on purpose.**
  - Correcting only the status filter would have turned on a detector that cancels working agents.
  - Progress is now `max(tasks.updated_at, session lastMessageAt)`, and the nudge is `deliver`.
  - Decision-log text is now "status nudge sent".
- **D2 also fixes the adjacent missing CAS** on the SAM stop cancel write, reported in audit row 9. It is the same function and the same class of bug.
- **D3 also moved code for rule 18.** `workspace_routing.go` was 614 lines; request routing and auth moved to `workspace_request_auth.go` (pure move, separate commit).
- **D4 correction to the audit:**
  - `ChatSessionList` has no importer in `apps/web/src`; it is dead code, so it was deleted rather than fixed. The user-visible effect of D4 was the account map, which showed failed task-less chats as idle.
  - `deriveSessionState` mapping a failed session with `agentCompletedAt` to `idle` was deliberately **not** changed. The resume-and-send path relies on it to let a user continue a failed chat, so changing it is a product decision outside this scope.
- **D7 also moved code for rule 18.** `node-lifecycle.ts` was 840 lines; the deployment heartbeat moved to `node-heartbeat-deployment.ts` (pure move, separate commit).
- **Discrimination:** every guard was removed once and the intended tests went red (see commit messages / PR).
- **Go toolchain:** the workspace had none. go1.26.10 was installed to `/tmp/gotool` and its checksum verified against the go.dev JSON index.
