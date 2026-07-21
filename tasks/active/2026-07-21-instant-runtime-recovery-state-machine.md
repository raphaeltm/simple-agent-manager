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
3. The agent-session resume route returns success immediately for `running`, and for `error`/`stopped` merely rewrites D1 to `running`; it does not wake or restore a cf-container runtime.
4. `wakeFromSnapshot()` marks the container `running` before restore completes. A missing/corrupt snapshot can leave the Durable Object apparently running even though the fresh vm-agent has no `SessionHost`.
5. The browser persists the user's optimistic message through the ProjectData WebSocket, then silently swallows a failed `/prompt` request. The transcript is safe, but the UI does not explain that the runtime failed or that a retry is required.

### First exact-head staging gate (failed, preserved as evidence)

- Commit `680db591d` deployed successfully to staging in workflow `29839895476`. A genuine UI-created Instant conversation created unique HOME, staged, unstaged, untracked, and harness-only markers in chat `5c64658a-0d16-45e8-8f25-2e610462bbae`.
- The idle wake restored HOME and file contents, but the staged file returned as untracked. The original WIP bundle encoded only one synthetic full-worktree commit; restore then used `git reset --mixed`, which necessarily discarded the original index state.
- The VM agent logged an empty previous ACP session ID and called `NewSession`. Snapshot manifest v1 persisted the SAM agent-session ID but not the underlying ACP/harness session ID or agent type, so the restore endpoint could not call `LoadSession` and nevertheless reported `restored`.
- The first browser assertion was invalid because it counted expected text in the user's prompt and a negative assistant explanation. Persisted assistant-only transcript evidence showed that the harness phrase was not recalled and that the agent explicitly identified a fresh conversation. The live verifier now uses authenticated role-aware transcript polling, exact positive lines, Git porcelain, one-user-prompt counts, and task status.
- While the workspace was legitimately `sleeping`, the scheduled stuck-task reconciler classified it as conclusively dead, failed the still-active conversation task with reason `workspace_sleeping`, then destroyed the workspace and node. This independently explains the user-visible “session appeared gone” symptom after idle.
- A subsequently triggered replacement workflow was canceled before any Cloudflare mutation and is not counted as replacement evidence. The failed project remains evidence only; the corrected exact-head gate must use a fresh UI-created project/session.

## Lifecycle Contract

```text
initial launch --success--> running
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
- [x] Treat `sleeping` and `recovery` workspaces as resumable/inconclusive in stuck-task reconciliation so the cron cannot fail and destroy a normal Instant handback.
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
- [ ] Run `$cloudflare-specialist`, `$go-specialist` if Go changes, `$security-auditor`, `$test-engineer`, `$ui-ux-specialist`, `$constitution-validator`, `$doc-sync-validator`, and mandatory `$task-completion-validator`; address blocking findings.
- [ ] Deploy the exact branch head to staging after checking for deployment contention.
- [ ] From a genuine UI-created Instant session, create unique HOME plus staged/unstaged/untracked Git markers and harness context; verify an ordinary idle wake restores all markers/context in the same chat.
- [ ] Force a real runtime replacement while work is active; verify no ambiguous replay, clear manual retry, same-chat follow-up persistence, restored markers/context, reconciled task status, and cleanup using bounded waits tied to observable progress.
- [ ] Open a focused PR from current `main` with production root cause, state/data flow, tests, exact staging evidence, and specialist evidence. Do not merge without separate explicit authorization. If the exact live gate fails, leave the PR blocked and report it.

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
