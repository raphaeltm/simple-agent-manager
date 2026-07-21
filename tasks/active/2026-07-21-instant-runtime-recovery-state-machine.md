# Recover Instant Sessions Across Runtime Loss

## Problem

An Instant session can appear to lose its work when a user returns after a modest delay and sends a follow-up. The exact production symptom is: the user was partway through work, left for roughly 20–30 minutes, returned to the same chat, sent another message, and sometimes saw no answer or an apparently dead session.

This is not the normal one-hour idle policy. Production evidence shows sessions with a safe R2 snapshot and preserved transcript were stopped during a Cloudflare container deployment, recorded as terminal D1 errors, and never entered the restore path. The next follow-up was persisted optimistically by ProjectData, but a dead-node precheck rejected it before the `VmAgentContainer` Durable Object could wake. The web client then suppressed that REST failure, making success and failure look unpredictable.

The repair must build on PR #1562's runtime-neutral snapshot/restore boundary and current `main`. Closed PR #1615 is evidence, not an implementation base: its exact-head staging gate failed with a same-chat HTTP 500, requests could fail before it classified replacement, and it treated every non-user `runtime_signal` as an authoritative rollout signal.

## Production Evidence

### Exact symptom match

- A production Instant conversation completed a turn at 13:04 UTC on 2026-07-16 and wrote a valid HOME snapshot at about 13:06. The node was created during a production deployment and stopped around deployment completion with `Runtime signalled the container to exit due to a new version rollout: 0`.
- The user returned 31 minutes later and sent a follow-up, then sent another follow-up after no response. Both user messages remained in the transcript; neither received an assistant response.
- The snapshot row retained a valid HOME artifact but had no `restore_status` or `restored_at`, proving recovery was never attempted. The task was later completed by idle cleanup rather than by a successful runtime continuation.
- A second production conversation showed the same shape after 36 minutes, but its stop was recorded as the generic `Container stopped: exit (0)`. Therefore the runtime can be recoverable without an authoritative rollout discriminator.

### Correlated lifecycle evidence

- Production uses `SESSION_IDLE_TIMEOUT_MINUTES=60` and has no `CF_CONTAINER_SLEEP_AFTER` override, so the code's one-hour sleep default applies. A failure after 20–36 minutes is not normal idle sleep.
- The matching nodes stopped during a successful production deployment window. Their workspace and agent-session rows became terminal/error even though a safe snapshot existed.
- Across the retained production snapshot sample, snapshots were present but none recorded a restore attempt. `home-skipped` was a visible degradation label; it did not mean the HOME archive was absent in these incidents.
- Another production incident contained two distinct events: an ACP peer disconnect during an active prompt, followed hours later by a container rollout stop. No snapshot was created for the interrupted turn because the harness never returned control. Logs do not prove OOM, so crash/OOM remains an unproven cause rather than a rollout alias.
- Credential selection, agent startup, and initial prompt dispatch succeeded in the matching incidents. There is no evidence that expired credentials, clone timeout, or missing cloud-provider credentials caused the delayed follow-up failures. PR #1639's partial clone and dedicated create-workspace budget remain adjacent protections.
- Production request telemetry does not retain the exact HTTP response for every affected follow-up. The current route and D1 state prove the precheck shape, and closed PR #1615 reproduced the same-chat boundary as HTTP 500 on staging, but the exact production status code remains an evidence gap.

### Existing failing path

1. `VmAgentContainer.onStop()` maps every unexpected stop to terminal `error`; `onError()` does the same.
2. `resolveLiveAgentSessionForChat()` permits only running/sleeping node and agent-session rows, so a terminal error blocks the request before the Durable Object can restore.
3. The agent-session resume route (`apps/api/src/routes/workspaces/agent-sessions.ts` `POST /:id/agent-sessions/:sessionId/resume`) returns success immediately for `running`, and for `error`/`stopped` merely rewrites D1 to `running`; it does not wake or restore a cf-container runtime.
4. `wakeFromSnapshot()` marks the container `running` before restore completes. A missing/corrupt snapshot can leave the Durable Object apparently running even though the fresh vm-agent has no `SessionHost`.
5. The browser persists the user's optimistic message through the ProjectData WebSocket, then silently swallows a failed `/prompt` request (pre-fix `catch {}` in `apps/web/src/components/project-message-view/useConnectionRecovery.ts`). The transcript is safe, but the UI does not explain that the runtime failed or that a retry is required.

### First exact-head staging gate (failed, preserved as evidence)

- Commit `680db591d` deployed successfully to staging in workflow `29839895476`. A genuine UI-created Instant conversation created unique HOME, staged, unstaged, untracked, and harness-only markers in chat `5c64658a-0d16-45e8-8f25-2e610462bbae`.
- The idle wake restored HOME and file contents, but the staged file returned as untracked. The original WIP bundle encoded only one synthetic full-worktree commit; restore then used `git reset --mixed`, which necessarily discarded the original index state.
- The VM agent logged an empty previous ACP session ID and called `NewSession`. Snapshot manifest v1 persisted the SAM agent-session ID but not the underlying ACP/harness session ID or agent type, so the restore endpoint could not call `LoadSession` and nevertheless reported `restored`.
- The first browser assertion was invalid because it counted expected text in the user's prompt and a negative assistant explanation. Persisted assistant-only transcript evidence showed that the harness phrase was not recalled and that the agent explicitly identified a fresh conversation. The live verifier now uses authenticated role-aware transcript polling, exact positive lines, Git porcelain, one-user-prompt counts, and task status.
- While the workspace was legitimately `sleeping`, the scheduled stuck-task reconciler classified it as conclusively dead, failed the still-active conversation task with reason `workspace_sleeping`, then destroyed the workspace and node. This independently explains the user-visible “session appeared gone” symptom after idle.
- A subsequently triggered replacement workflow was canceled before any Cloudflare mutation and is not counted as replacement evidence. The failed project remains evidence only; the corrected exact-head gate must use a fresh UI-created project/session.

### Second exact-head staging gate (idle passed; replacement precondition failed)

- Commit `4b461c051` deployed successfully in workflow `29846722061`, including 12 staging smoke tests. Genuine UI project `01KY2QCEC2FEFDJ1536GGMS3JS`, chat `df78a5d1-23d0-4865-ac02-090cc18f27aa`, and task `01KY2QYRSG14W4M8678FNXXWEB` created unique HOME, exact staged/unstaged/untracked Git state, and native harness context.
- Idle handback wrote an `available`/non-degraded snapshot whose manifest retained underlying ACP session `0715aa21-a03e-4edc-a669-e9a7273c6b93` and `claude-code` type. Cloudflare reported the exact node instance inactive; D1 moved workspace and agent session to `sleeping`; the task stayed `in_progress/awaiting_followup` through the real 16:35 UTC five-minute reconciliation sweep.
- The same-chat follow-up passed the strict role-aware browser gate with no API errors. It restored HOME, exact Git porcelain (` M README.md`, staged `A  ...`, untracked `?? ...`), and the harness-only phrase without recreating state or duplicating the prompt.
- A separate ProjectData alarm had nevertheless changed the ACP control-plane record from `running` to terminal `interrupted` at 16:34:51 because its last heartbeat predated the five-minute cutoff. That heartbeat is intentionally absent while an Instant container is sleeping. Cold wake restored the real underlying harness but could not legally transition the already-terminal ProjectData row back to running.
- At 16:45:16 the stuck-task sweep saw that terminal ACP row while the replacement prompt was starting, classified `task_acp_session_not_live`, failed the task, and deleted the workspace/node. This happened before the replacement deployment reached its Worker mutation; workflow `29849922266` was canceled and is not replacement evidence.
- The original replacement prompt also asked for a standalone foreground sleep, which the Claude harness correctly rejected and rewrote as a background wait. The next gate uses a bounded foreground loop with observable progress ticks and requires an execution-start transcript marker plus active DO work before rollout.
- The repair now gives `VmAgentContainer` a sanitized read-only lifecycle inspection RPC. ProjectData defers stale-heartbeat terminalization only for non-terminal cf-container lifecycle states, with alarm backoff; VM/devcontainer heartbeat behavior is unchanged. Stuck-task reconciliation uses the same lifecycle signal: active work is live, sleep/wake/restore/recovery is inconclusive/resumable, and explicit stop/expired/error remains conclusively terminal.

### Control-loop I/O budget

- Candidate selection is unchanged. ProjectData still selects only already-stale active ACP sessions, and stuck-task reconciliation still operates within its existing bounded candidate sweep. The new policy applies only when the selected workspace is backed by `cf-container`.
- Per stale Instant ACP candidate, the alarm adds one indexed D1 workspace/node lookup and one sanitized `VmAgentContainer.inspectLifecycle()` RPC. The RPC reads three small Durable Object storage keys concurrently; it does not start the container or contact vm-agent.
- Per running Instant stuck-task candidate, the sweep substitutes the same lifecycle RPC for stale node/ACP prechecks. Active work is conclusively live; non-terminal/no-active-work and probe failure are inconclusive; explicit stop/expired/error are conclusively dead.
- Both paths use the existing env-configurable `TASK_LIVENESS_PROBE_TIMEOUT_MS` with the shared five-second background default. ProjectData evaluates stale sessions concurrently, and a deferred stale alarm is rescheduled no sooner than one detection window instead of immediately looping.
- Deferred candidates escape through a resumed heartbeat, explicit stop/destroy, terminal runtime error/expiration, or the existing configured conversation idle cleanup. Tests cover deferred alarms, backoff, failed/never-settling probes, active replacement work, explicit terminal states, and VM/devcontainer behavior remaining unchanged.

## Post-Mortem

- **What broke:** A user could leave a still-valid Instant conversation for a modest delay, return to the same chat, and find that a follow-up had no response or that the task/workspace appeared gone even though transcript and snapshot data existed.
- **Root cause:** Runtime liveness had multiple unsynchronized owners. The container lifecycle correctly entered `sleeping`, but the ProjectData ACP alarm interpreted the intentionally absent sleeping heartbeat as terminal. The later stuck-task sweep trusted that stale terminal replica and deleted recoverable work. Earlier code also let dead D1 node/session prechecks block the runtime owner's recovery path.
- **Timeline:** Runtime-neutral snapshot/restore shipped in PR #1562. Adjacent recovery and clone-budget plumbing shipped in PRs #1637/#1639. Closed PR #1615 exposed a same-chat HTTP 500 but used invalid rollout assumptions. Production evidence on 2026-07-16 matched rollout/generic-stop loss after 20–36 minutes. The first exact-head gate found lost Git index/native harness identity and sleeping-task cleanup; the second proved ordinary idle resume, then exposed the separate ACP-heartbeat/stuck-sweep race before replacement could be tested.
- **Why it was not caught:** Tests exercised each state store in isolation. No regression deliberately combined a sleeping/recovering runtime owner with a stale ACP heartbeat and a later cleanup sweep. The initial browser verifier also accepted prompt text and negative explanations as success instead of strict assistant-only persisted evidence.
- **Class of bug:** Cross-control-plane lifecycle races in which a stale replica is treated as authoritative terminal state and destructive reconciliation runs before the runtime owner can classify recovery.
- **Process fix:** `.claude/rules/02-quality-gates.md` now requires multi-control-plane lifecycle tests with stale secondary state and one shared liveness classifier across timeout/cleanup paths. The exact-head verifier uses role-aware persisted transcript evidence, observable active work, and strict no-replay assertions.

### Final local gate status before third staging head

- Full repository tests: 19/19 Turbo tasks, including API 446 files / 6,267 tests.
- Build: 9/9; typecheck: 16/16; lint: 7/7 with baseline warnings only; file-size, AST (0 errors), wrangler, migration, DO-migration, source-contract, and ordering gates passed.
- Focused lifecycle reconciliation: 5 files / 45 tests, including bounded probe timeout/failure and stale-heartbeat deferral. Go snapshot/ACP focused, race, and vet evidence remains green from the same branch head lineage; the second pass does not modify Go.
- Local Worker/Miniflare remains an evidence gap: pinned `workerd` segfaults before test import, including unchanged Worker suites. CI and exact-head Cloudflare staging remain authoritative.
- `quality:do-wall-time` reported three pre-existing staging alarm regressions (2.03x, 4.89x, and 7.10x) before this head was deployed. This is not counted as a pass; it must be rerun and correlated after exact-head staging.

## Specialist Review Round (fourth head, 2026-07-21)

Eight reviewers ran against the rebased head `365cd12e5`. constitution-validator and doc-sync-validator passed (their MEDIUM/LOW polish items were applied directly: broadened `TASK_LIVENESS_PROBE_TIMEOUT_MS` doc description, task-file citations, a direct `resolveRuntimeSettings` parsing test, and backlog `2026-07-21-remove-sandbox-env-fallbacks-from-container-runtime.md`). Six returned blocking findings; all CRITICAL/HIGH were fixed in this branch:

- **Explicit-stop race (CRITICAL)**: `ensureAwake()`'s post-`beginUnexpectedRecovery` guard checked only `stopped`, so a user stop landing in the unlocked window could be overwritten and the container restarted. Guard now short-circuits on `stopping` too, and the three mid-wake terminal re-checks issue an idempotent `this.stop()` so a stop-crossed wake cannot leak a started container until `sleepAfter`.
- **Restore-identity burn (CRITICAL, Go)**: `capturePreviousAgentSelection` cleared `PreviousAcpSessionID`/`PreviousAgentType` before the restore attempt could succeed; a transient failure permanently lost the LoadSession identity (rule 49 class). Identity is now consumed only on success; concurrent `RestoreAgent` calls are serialized by an in-progress selection guard; a post-spawn `establishACPSession` failure stops the orphaned agent process.
- **Credential-bearing HOME snapshot (CRITICAL, pre-existing from PR #1562)**: the HOME tar uploaded `~/.claude/.credentials.json`, `~/.codex/auth.json`, `~/.config/gh`, `~/.ssh`, `~/.netrc`, `~/.npmrc`, `~/.aws` to R2. `shouldExcludeHomePath` now supports multi-segment and exact-file exclusions; harness transcript state under `.claude/`/`.codex/` is retained for LoadSession. Restore reinjects fresh credentials, so nothing depends on snapshotted secrets.
- **Stale-generation callback regression (HIGH)**: a late `error`/`failed` callback from a superseded container could kill a freshly recovered session. Destructive transitions in the activity and task callbacks now reject callbacks whose token `iat` predates the row's recovery reconciliation by more than `INSTANT_STALE_CALLBACK_MARGIN_MS` (default 60000, fail-open on ambiguity; `restartCount` was investigated and rejected — it is an in-memory decaying counter, not a generation). Follow-up for non-destructive stale surfaces: `tasks/backlog/2026-07-21-extend-stale-instant-callback-guard-coverage.md`.
- **Resume-route clobber (HIGH)**: after a successful container recovery the route re-fetches the session row and no longer overwrites the DO-written `error_message` (manual-retry disposition survives reloads); the deliberately wide dead-precheck gate is documented in-code.
- **VM dead-detection regression (HIGH)**: the resumable-status short-circuit in `getTaskRuntimeLiveness` is now gated on `node_runtime === 'cf-container'`, and `recovery` is restored to the VM live set so a genuinely dead VM node stuck in `recovery` is conclusively reconciled again (regression tests cover both runtimes).
- **Non-discriminating flagship tests (2× CRITICAL)**: the Miniflare config had no `VM_AGENT_CONTAINER` binding, so the stale-heartbeat test passed via the binding-unavailable defer; the real `Container` class cannot boot under vitest-pool-workers (`ctx.container` is undefined and the constructor throws), so a test-double DO now reuses the real `inspectStoredVmAgentContainerLifecycle` + classifiers via a wrapper `main`, with a discriminating sleeping/stopped pair and a combined three-actor test (real `ProjectData.alarm()` + real `recoverStuckTasks()` over one seeded state). Stuck-task tests now drive the cf-container branch through the real sweep entry point with explicit `node_runtime` rows.
- **Recovery UI truthfulness (3× HIGH)**: a failed idle resume no longer strands "Agent is working..."; a later successful send clears the stale delivery-error banner; `RUNTIME_STOPPED` now flows into the existing terminated-session presentation (composer disabled) instead of inviting futile retries. Auto-resume and user sends are serialized by a re-entrancy guard + monotonic attempt token; the composer keeps its text on failed delivery; the waking banner shows elapsed time. Component tests now use production-shaped `ApiClientError` codes (including the previously unrendered `RUNTIME_REQUEST_INTERRUPTED`), and the mocked Playwright audit gained interrupted + stopped scenarios across mobile/desktop.
- **Hot-path index (MEDIUM)**: additive migration `0097_tasks_workspace_id_index.sql` adds a partial `idx_tasks_workspace_id` for the recovery-exhaustion task lookup.
- **Deferred with evidence (rule 42)**: per-request abort/cancellation across the DO-RPC boundary cannot use `AbortSignal` (regression proven by PR #1544); tracked in `tasks/backlog/2026-07-21-instant-container-request-timeout-cancellation.md`.

Every fix carries a regression test that was verified to fail on the pre-fix code (discrimination checks recorded in the respective test suites).

## Third Exact-Head Staging Gate (PASSED, 2026-07-21 22:32–23:55 UTC)

Head `31737ae39` deployed (run 29872844972); verification ran against it and the follow-up comments-only head `5bc143f8c` (two-line file-size-exception delta; deploys 29876306236/29877444911 green including 12-test smoke). Genuine UI-created artifacts project `01KY3D007EA6JNCCHSK5YCFEYK`, Instant claude-code profile, chat `60d82ff6-fc42-48c0-8ea4-7772df2da630`, task `01KY3D0S2RNJYDTJMFQ2F6XRTZ`, node `01KY3D0SF4Q8XVGMPG862X0BMV` (nonce HPPQ0F).

**Idle wake (gate 3a):** markers created and confirmed at 22:34:59 (unique HOME file, unstaged README edit, staged file, untracked file, harness-only phrase). Container slept 22:36:23 with an `available`/`degradation=none` snapshot and survived ~8 minutes of sleep across the 5-minute reconciliation sweep boundary — task `in_progress`, agent `sleeping`, workspace intact (the exact windows where gates 1 and 2 were destroyed). The same-chat follow-up restored, within ~30 seconds: exact HOME marker content, exact `git status --porcelain` (` M README.md`, `A  staged-…`, `?? untracked-…`), and the never-on-disk phrase (real LoadSession). Exactly one new user message (no duplicates: transcript = initial + SAM-injected system context + follow-up). `session_snapshots.restore_status='restored'`, `restored_at` written — the fields that were NULL in every production incident.

**Replacement (gate 3b):** two real Cloudflare rollouts were driven through the deploy pipeline.
- *Idle-state kill:* rollout at ~23:07 hit a sleeping container; no failure, no destruction; a later follow-up (23:31:20) woke the `recovery` workspace and fully restored phrase + porcelain in ~40s with no replay; task `in_progress` throughout.
- *Active-work kill (the decisive case):* a delivery-confirmed foreground work loop ran from 23:38 (activity `prompting`, new `EXECUTION-START` echo persisted). The rollout killed the container **mid-work at 23:44:59**. Observed classification: workspace + agent session → `recovery`; `agent_sessions.error_message` = the sanitized "Instant session interrupted; restoring the last safe checkpoint…" disposition; task stayed `in_progress` across 8 minutes of sweeps; the in-flight prompt was never replayed (EXECUTION-START count constant). The same-chat follow-up at 23:54:09 restored phrase + exact porcelain in ~28s (`RESTORE2-REPORT`), one new user message, no replay. The tick log produced only after the last safe checkpoint correctly reported `TICKS-MISSING` — last-safe-checkpoint semantics, honestly surfaced, with the restored harness retaining pre-checkpoint conversation memory (LoadSession continuity across two kills) while the control-plane transcript retains the complete record.

**Cleanup:** both gate projects deleted (a first attempt's orphan `01KY3CXZZ1SV8CE8VXWHS96F74` included), workspaces 0, node row deleted — verified via D1.

**Verifier notes:** the driver was hardened during the run (wizard default-provider race → stepper-jump + `aria-checked` assertion; streamed-chunk contiguous joins; delivery-confirmation before browser close — earlier attempts that closed the browser seconds after Send lost the optimistic message, the known pre-existing WS-persist gap flagged by review as out of this PR's scope). An agent-side honesty note: a 12.5-minute single foreground loop exceeds the agent's 10-minute tool cap and was refused; the verified loop is 9.2 minutes.

## Lifecycle Contract

```text
initial launch --success--> running
# naming: "recovery-pending" below = DO lifecycleStatus `recovering` (+ recovery phase `pending`); D1 workspace rows use status `recovery`
initial launch --failure--> error (terminal launch failure)

running --idle handback + snapshot--> sleeping
sleeping --follow-up--> waking --> restoring --success--> running + send once
sleeping --missing/corrupt restore--> degraded/error (never claim resume)

running --unexpected stop/error--> recovery-pending
recovery-pending --follow-up--> waking --> restoring --success--> running + send once
recovery-pending --restore failure/exhaustion--> degraded/error + reconciled task/chat state

running --request transport breaks--> recovery-pending + ambiguous/manual-retry
                                      (persist transcript; never replay request)

running/sleeping/recovery --explicit user stop--> stopped (terminal; never recover)
```

Cloudflare stop metadata (`exit` versus `runtime_signal`, exit code, raw hook/error source) is retained for admin diagnostics. It may support a rollout inference when correlated with deployment evidence, but the product state is generic unexpected runtime recovery unless an authoritative rollout identifier exists.

## Implementation Checklist

### Durable runtime lifecycle

- [x] Add a persisted, typed recovery record to `VmAgentContainer` with phase, trigger, sanitized user disposition, bounded attempt count, interrupted agent-session identity, and detailed admin-only cause metadata.
- [x] Serialize lifecycle check/transition and wake/restore critical sections across `await` boundaries; make duplicate `onStop`/`onError` callbacks idempotent.
- [x] Keep idle handback as `sleeping`, explicit stop/destroy as terminal `stopped`, initial launch failure as terminal `error`, and all unexpected loss of an established runtime as generic recoverable state without calling every `runtime_signal` a rollout.
- [x] Make stopped/error/recovery D1 rows reach the Durable Object recovery path instead of failing a dead-node precheck.
- [x] Keep the runtime non-running until the fresh container has restored HOME, Git WIP, fresh credentials/callback tokens, and native harness session state.
- [x] Bound recovery attempts with named environment-backed defaults. Missing, expired, corrupt, or rejected snapshots must degrade visibly and must never become transcript replay presented as a true resume.
- [x] Catch a transport failure that crosses a request, classify recovery before a late lifecycle callback, preserve the original prompt in the transcript, and return an explicit manual-retry disposition without replaying the ambiguous request.
- [x] Reconcile node, workspace, agent-session, ACP/chat, and active task state on recovery success and terminal degradation so neither active nor awaiting-follow-up work is stranded.
- [x] Treat Instant sleep/wake/restore/recovery as resumable/inconclusive in both ProjectData heartbeat alarms and stuck-task reconciliation. Use sanitized DO lifecycle state so stale heartbeats cannot destroy a normal handback, while explicit stop/expired/error remains terminal.
- [x] Encode separate worktree and index commits in new WIP bundles, retain single-ref legacy restore compatibility, and prove staged/unstaged/untracked status survives exactly.
- [x] Persist the underlying ACP session ID and agent type in the runtime-neutral manifest, hydrate the new SessionHost, and require exact `LoadSession` with no `NewSession` fallback or false resume.

### Route, service, callback, and UI behavior

- [x] Replace the agent-session resume route's D1-only rewrite for cf-container sessions with a real bounded wake/restore call; retain the VM suspended-session behavior.
- [x] Permit tenant-scoped recovery rows in chat resolution while preserving IDOR and destroyed-VM guards.
- [x] Preserve the extended wake/restore timeout only for cf-container recovery paths and keep clone/create budgets from PR #1639 distinct.
- [x] Return stable, sanitized error codes/messages for waking, degraded recovery, and ambiguous manual retry. Keep raw snapshot/container details in structured admin logs only.
- [x] Stop swallowing follow-up delivery errors in project chat. Show waking/restoring progress, tell the user when their message is saved but needs manual retry, and expose degraded recovery without claiming the agent resumed.
- [x] Verify fresh node-scoped and workspace-scoped callback tokens are minted on every cold runtime and that duplicate/late callbacks cannot regress a recovered or explicitly stopped session.

### Tests

- [x] Add Durable Object unit/Miniflare coverage for idle snapshot handback, cold wake, recovery wake, missing/expired/corrupt snapshot degradation, explicit stop, true unexpected crash, callback ordering/duplication, and terminal status reconciliation.
- [x] Add a concurrency test proving simultaneous follow-ups launch and restore once and do not duplicate prompt delivery.
- [x] Add a request-crossing-replacement test proving the interrupted request is classified and returned as manual retry but is never replayed.
- [x] Add route/service tests for recovery-row resolution, cf-container resume, callback-token reinjection, sanitized regular-user responses, and task/chat status reconciliation.
- [x] Add web tests for waking/restoring/degraded/manual-retry presentation and preserved optimistic transcript messages.
- [x] Run focused Go snapshot/restore, ACP, vet, and race suites using the repository-pinned Go 1.25 toolchain. The bounded primitive/standalone consumer fixes preserve exact Git index and harness identity; a full VM/devcontainer consumer remains a separate explicit follow-up on runtime-neutral persistence idea `01KX4KSXEXQMP41KS34TW9EN01`.

### Verification and delivery

Local verification gaps are tracked explicitly: the pinned Miniflare/workerd runner segfaults before importing both the new Worker tests and an unchanged worker smoke test, and the live Durable Object wall-time gate currently reports two pre-existing staging alarm regressions. These are not treated as passing evidence. A checksum-verified temporary Go 1.25.12 toolchain now covers the Go tests locally.

- [x] Run focused API/DO/route tests, web tests, vm-agent Go/vet/race checks, migration gates, lint, typecheck, full tests, and build. The Worker/Miniflare process still hits the recorded local `workerd` SIGSEGV before test import and remains for CI.
- [x] Run `$cloudflare-specialist`, `$go-specialist` if Go changes, `$security-auditor`, `$test-engineer`, `$ui-ux-specialist`, `$constitution-validator`, `$doc-sync-validator`, and mandatory `$task-completion-validator`; address blocking findings. All eight ran 2026-07-21 (fourth head). Two passed outright; six returned findings — every CRITICAL/HIGH fixed in-branch (see "Specialist review round" below); MEDIUM deferrals are tracked backlog tasks per rule 42.
- [x] Deploy the exact branch head to staging after checking for deployment contention. Run 29872844972 deployed `31737ae39` green (one transient networkidle smoke flake passed on rerun; deploy jobs succeeded first try). Subsequent runs 29875487605/29876306236/29877444911 deployed the final comments-only head `5bc143f8c` fully green including smoke.
- [x] From a genuine UI-created Instant session, create unique HOME plus staged/unstaged/untracked Git markers and harness context; verify an ordinary idle wake restores all markers/context in the same chat. See "Third exact-head staging gate" below — PASSED.
- [x] Force a real runtime replacement while work is active; verify no ambiguous replay, clear manual retry, same-chat follow-up persistence, restored markers/context, reconciled task status, and cleanup using bounded waits tied to observable progress. See "Third exact-head staging gate" below — PASSED (both idle-state and active-work rollout kills).
- [x] Open a focused PR from current `main` with production root cause, state/data flow, tests, exact staging evidence, and specialist evidence. PR #1660 is open with all CI green; it remains UNMERGED pending separate explicit authorization.

## Acceptance Criteria

- A normal follow-up after an actual idle sleep wakes one runtime, restores safe filesystem and native harness state, and sends the follow-up exactly once in the original task/chat.
- An established runtime lost to rollout, generic exit, or true crash becomes recoverable without falsely asserting the cause. Dead D1 prechecks cannot block the recovery attempt.
- A prompt that may have crossed a runtime-loss boundary is never replayed automatically; the transcript remains intact and the user receives a clear manual-retry state.
- Missing, corrupt, expired, or failed snapshots never produce a false resume. Node/workspace/agent/ACP/chat/task state becomes consistently degraded or terminal with sanitized user messaging and detailed admin diagnostics.
- Explicit stop/destroy never wakes or recovers, including when late duplicate lifecycle callbacks arrive.
- Fresh node and workspace callback credentials are injected on cold wake, and duplicate requests/callbacks do not launch, restore, or deliver twice.
- UI-created exact-head staging evidence proves both ordinary idle wake and active real replacement with restored HOME, staged/unstaged/untracked Git, harness context, same-chat persistence, task status, no ambiguous replay, and cleanup.
- The PR remains open and unmerged until a separate explicit authorization.

## References

- PR #1562 — runtime-neutral hibernate/wake and visible degradation
- PRs #1637 and #1639 — adjacent ACP/callback and clone/create-workspace recovery plumbing
- Closed PR #1615 — failed exact-head staging evidence and rejected assumptions; do not reuse wholesale
- Ideas `01KX4KSXEXQMP41KS34TW9EN01` and `01KXNJ87157H901TAM2WY5E22B`
- `apps/api/src/durable-objects/vm-agent-container.ts`
- `packages/vm-agent/internal/server/session_snapshot.go`
- `tasks/backlog/2026-07-20-instant-ping-container-died-midsession.md`
- `tasks/backlog/2026-07-19-instant-launch-stuck-queued-on-disconnect.md`
- `tasks/backlog/2026-07-19-instant-session-capacity-controls.md`
- `.claude/rules/39-debug-before-redesign.md`
- `.claude/rules/41-credential-snapshot-resilience.md`
- `.claude/rules/43-long-running-mcp-tools.md`
- `.claude/rules/45-durable-object-concurrency-mutex.md`
- [Cloudflare Container interface](https://developers.cloudflare.com/containers/container-class/)
- [Cloudflare Container lifecycle](https://developers.cloudflare.com/containers/platform-details/architecture/)
- [Cloudflare Container rollouts](https://developers.cloudflare.com/containers/platform-details/rollouts/)
