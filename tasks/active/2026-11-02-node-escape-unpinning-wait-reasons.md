# Node escape hatch, unpinning stuck nodes, and honest wait reasons

Branch: `sam/node-escape-and-unpinning`. Requested by Raphaël 2026-11-02 after production
investigation (SAM task `01M6CFRQRX614N3CSARAV793NZ`). Staging skipped at his instruction;
ship to prod once the PR is green. Tests must be vertical slices that a local reviewer
subagent confirms address the core problems.

## Problems (production evidence, 2026-11-01/02)

1. **No escape for a node SAM cannot delete.** Deployment node `01KXAR1T3XCQKKPBEJEERQ2PSZ`
   (Hetzner `150100869`, deleted by hand long ago) sits in `destroying`; strict deletion throws
   "exact provider credential binding is missing" and retries hourly forever. Idea
   `01M6DFJTV3VCFEJEBYMK3KYF7A`.
2. **Nodes pinned by workspaces that can never be deleted.** Node `01M69PPA2GA4WQBQMTDB97CXZ2`
   lived ~37 h: a `stopping` workspace dead-lettered after 24 h of 409s, and two `stopped`
   workspaces with no snapshot that no sweep ever deletes.
3. **"Waiting for server capacity…" hid the real blocker** for 25 min: first the previous
   workspace's deletion fence, then Hetzner 412 placement errors, then waiting for a new node.

## Checklist

- [x] Research each area (subagents) and record findings below
- [x] #1 API + UI: user-confirmed removal of a node SAM cannot tear down
  (`services/node-manual-deletion.ts`, `routes/nodes/manual-deletion.ts`, Node page button)
- [ ] #2 Fix A: reverted from this PR, moved to
  `tasks/backlog/2026-11-02-completed-task-prompting-rereports-keep-node-awake.md`. The full API
  suite showed it sleeps working Claude Code agents mid-turn, and the sleep's own abort check
  would still fire on every re-report. Stopped/dead-lettered rows are already handled by
  stranded-node retirement (#2478).
- [ ] #2 Fix B: deferred to `tasks/backlog/2026-11-02-workspace-deletion-claim-restamps-updated-at.md`
  (other readers of `updated_at` on `stopping` rows need an inventory first; impact bounded at ~1 h)
- [x] #3 UI shows the real wait reason (`routes/chat/wake-state.ts`, `WakeProgressBanner.tsx`)
- [x] Vertical-slice tests per item, each proven discriminating
- [x] Local test-quality reviewer subagent confirms tests are legitimate (all three LEGITIMATE)
- [x] Security and UI/UX reviews addressed; docs updated
- [ ] PR green, merge, prod deploy verified

## Findings

### #1 manual removal (research agent)

- Delete path: `pages/Node.tsx:handleDelete` → `DELETE /api/nodes/:id` → `routes/nodes/delete.ts:deleteNodeRoute`
  (409 unless `runtimeTerminationConfirmed`) → `services/node-resource-deletion.ts:deleteNodeResources` →
  `strict-node-deletion.ts` (`requireStrictNodeProvider` throws the "binding is missing" error ~:215).
- Hourly retrier for deployment nodes: `scheduled/deployment-node-cleanup.ts:runDeploymentNodeCleanup` →
  `services/deployment-node-cleanup.ts:cleanupDeploymentNode` (1h backoff).
- No existing escape. `finalizeDeletion` only clears DO state. Proof-gated tail:
  `retireDeletedDeploymentNodeRecord` (node-resource-lifecycle.ts:271, needs `runtimeTerminationConfirmedAt`),
  `removeManagedNodeRecords` (delete.ts:69, keeps workspaces with snapshots), DNS cleanup, `finalizeDeletion`,
  `recordNodeHealthEvent`, `terminalizeStrandedNodeTasks`, finalizer `finalizeWorkspaceLifecycleClosure`.
- `Provider.getVM` → null on 404; a 404 via a non-exact credential is NOT absence proof
  (`deployment-legacy-binding.ts:111`). Use getVM only as a refusal gate (server found → refuse).
- Archived task 2026-09-08 deferred force-delete as "a spend/security-design decision for Raphaël";
  Raphaël has now asked for it (idea `01M6DFJTV3VCFEJEBYMK3KYF7A`).
- Tests: `tests/workers/node-delete-proof-cascade.test.ts` (Miniflare, real DELETE handler),
  `tests/unit/routes/node-delete-real-sql.test.ts`, `tests/unit/services/nodes-delete.test.ts`,
  writer inventory `tests/unit/services/workspace-lifecycle-finalizer-coverage.test.ts`.
- Web `Node.tsx` is hand-rolled polling (not TanStack); delete button :249.

### #2 pinning — corrected diagnosis (research agent + prod logs)

- `stopping`/`stopped` rows do NOT occupy a node (occupancy = running/creating/recovery,
  `ACTIVE_WORKSPACE_RESERVATION_STATUS_SQL`). Bounded stranded retirement (#2478,
  `sweepStrandedNodes`) already retires stopped/destroying nodes refused >30 min, waiving artifact
  proof with user-visible loss notices. So dead-lettered / no-snapshot rows are cleaned once the
  node goes idle.
- What actually pinned `01M69PPA…`: active workspaces of COMPLETED tasks that never slept.
  Prod logs for `01M6CP3W…`: agent re-reported `prompting` ~every minute 00:06→08:37 with
  runtimeWorkState `inactive`; session sleep stopped queuing at 00:00; idle cleanup deferred
  `no_candidate_tasks` 6×.
- Root cause: `classifySessionIdleness` (services/session-idleness.ts) anchors the completed-task
  drain on `state.activityAt`, but `upsertSessionState` (project-data/session-state.ts ~:114)
  rewrites `activity_at` on every admitted re-report, so `activityAt + idleAfterMs` (15 min) never
  arrives. Rule 53 class (liveness timestamp as idleness signal).
- Fix A: drain anchor = max(taskCompletedAt, promptStartedAt, runtimeWorkProgressAt) — signals
  re-reports do not move. Callers already pass `getSessionState` snapshots that include
  `promptStartedAt` (session-sleep-eligibility.ts ×2, completion-drain.ts, operational-status.ts).
- Fix B: `claimWorkspaceDeletionInD1` (node-lifecycle-workspace-deletion-support.ts) re-stamps
  `workspaces.updated_at` on every retry, which feeds `LAST_WORKSPACE_ACTIVITY_SQL` and delays the
  empty-node warm-handoff backstop. Keep `updated_at` when the row is already `stopping`.

### #3 wait reasons (research agent)

- Banner: `WakeProgressBanner.tsx` renders `wakePhaseLabel(wakePhase)`; wake state from
  `routes/chat/wake-state.ts:attachWakeState` (session_snapshots.recovery_status JOIN tasks.execution_step).
  Push: `session.wake_progress` from `project-data/session-wake-progress.ts`.
- `tasks.admission_reason` / `admission_next_retry_at` already written by `vm-admission-control.ts`
  (reasons in `vm-admission-control-types.ts`: compatible_node_provisioning, provider_transient_capacity,
  provider_account_capacity, user_node_limit, capacity_pool_node_limit, ...). Not in wake state.
- `updateD1ExecutionStep` (task-runner/index.ts ~545) skips push when step unchanged, so reason changes never push.
- Deletion fence `workspace_deletion_unconfirmed` (`services/session-recovery.ts:267`) is only logged
  (`session-recovery-refusal-report.ts`), before claim; banner falls back to pending label.
- Plan: add `waitReason`/`waitRetryAt` to `SessionStateSnapshot` from the existing join (no extra D1 trip);
  derive "previous workspace still cleaning up" from data the fence reads rather than a new column if possible;
  shared `waitReasonLabel`; push on reason change; tests in apps/api/tests/unit/wake-progress.test.ts,
  apps/web/tests/unit/components/wake-progress.test.tsx, Playwright wake-progress-audit.spec.ts.

## Notes

- Decision (#3 push): reason changes are not pushed over `session.wake_progress`. A sleeping chat
  already polls the session detail route every `CHAT_FALLBACK_POLL_MS` (10 s) while the tab is
  visible (`useFallbackSessionPoll.ts`), which bounds staleness to one poll; pushing would need
  `updateD1ExecutionStep` to broadcast on an unchanged step. Raised as MEDIUM by the
  task-completion validator and accepted as bounded.
