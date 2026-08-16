# Prevent hidden harness work from sleeping and add durable task waits

## Problem statement

SAM can observe the end of an ACP `session/prompt` turn while the underlying agent harness still owns useful background work. In parent session `36a5bb77-2746-43c1-8669-030b51b8f36d`, Claude Code launched a bounded background poller, returned the top-level ACP prompt, and expected the harness to surface completion later. The VM Agent reported `idle`, the control plane had no representation of the background task, and automatic session sleep removed the runtime before the orchestration could continue.

Foreground polling avoids this failure only by keeping one prompt open. It consumes a long-running turn, remains vulnerable to prompt deadlines, and duplicates state that SAM already owns for dispatched child tasks.

This task extends the durable execution foundation from PR #1785 and ready idea `01KZK586BN98BRDGKC44V12HT0`. It does not create a second prompt queue or snapshot system.

## Research findings

- ACP intentionally supports implementation-specific `_meta` and underscore-prefixed extension notifications. SAM's pinned `acp-go-sdk` v0.13.5 exposes `ExtensionMethodHandler`, but `sessionHostClient` currently handles only standard `session/update` notifications.
- SAM's pinned `claude-agent-acp` v0.58.1 already supports a filtered `claudeCode.emitRawSDKMessages` session option and emits matching lifecycle messages through `_claude/sdkMessage`.
- Claude's `background_tasks_changed` message is an authoritative level signal containing the current background task set. `task_started`, `task_progress`, `task_updated`, `task_notification`, and task-notification results provide useful edge/progress/settlement signals.
- Raw harness payloads can contain user/model/tool content. SAM must normalize lifecycle facts inside the VM Agent and must not log, persist, or forward raw extension payloads.
- `session_state` currently separates stable prompt epoch from activity, but it has no out-of-turn runtime-work state or meaningful-progress timestamp. `isActivitySafeForSleep` treats `idle` as immediately safe.
- Durable prompt delivery already wakes sleeping sessions and refuses ambiguous replay. Parent wake should enqueue through that existing delivery owner.
- `task-terminal-transition-hooks.ts` is an explicit subscriber seam, but it currently registers no parent-wake hook and only a subset of terminal writers invokes it. A bounded ProjectData reconciliation alarm is required as a correctness backstop.
- The current `/workflow` instructions mandate foreground polling. They should prefer a durable wait capability and retain polling only for older servers that do not advertise the tool.
- The separate snapshot resume-identity mix-up observed during the incident is already addressed on current `main` by `snapshotHarnessResumeIdentity`, which restores `manifest.AcpSessionID` rather than the replacement control-plane session ID.

## Incident post-mortem

### What broke

An overnight parent workflow created a Claude Code background poller and then
completed its top-level ACP prompt. SAM observed the standard ACP idle signal,
had no representation of the still-running harness work, and eventually slept
the workspace. The poller therefore could not surface child-task completion or
resume backlog triage.

### Root cause

ACP exposed the prompt lifecycle but not Claude's private background-task
lifecycle. SAM treated `idle` as sufficient evidence that the runtime was safe
to snapshot and sleep. At the orchestration layer, `/workflow` also prescribed
foreground polling instead of registering a SAM-owned durable wait and ending
the turn.

### Timeline

1. The parent dispatched PR-triage work and started a harness background poller.
2. The top-level Claude ACP prompt returned while the background task remained active.
3. The VM Agent emitted ordinary idle activity with no normalized background-work lease.
4. SAM's idle policy slept the workspace.
5. The intended overnight continuation never received a durable wake event.

### Why existing controls missed it

Prompt epochs, generic activity, snapshot recovery, and durable prompt delivery
covered work SAM could see. None modeled useful work owned by a specific harness,
and no durable parent subscription connected child terminal transitions to the
sleeping parent. The workflow guidance reinforced the gap by treating an
in-process poller as the waiting mechanism.

### Defect class

Cross-harness lifecycle observability and orchestration durability: private
adapter work was mistaken for control-plane idleness, and waiting state lived in
an ephemeral agent process instead of SAM-owned storage.

### Process fix

This change updates `.claude/rules/14-do-workflow-persistence.md` so workflows
must persist state plus a stable wait key, register `wait_for_subtasks`, and end the turn. Harness-owned
polling is prohibited as the primary waiting mechanism; bounded foreground
polling remains only an explicit compatibility fallback.

## Architecture

### Normalized harness work state

For Claude Code sessions, set filtered NewSession/LoadSession metadata that enables only lifecycle SDK messages. Implement the ACP extension handler in the VM Agent and reduce each accepted message to:

- state: `inactive`, `active`, or `settling`
- active task count
- adapter source (`claude_sdk`)
- last state/heartbeat timestamp
- last meaningful lifecycle-progress timestamp

While state is active, the VM Agent re-reports this normalized snapshot using the existing configurable activity re-report interval. Settlement emits one finite lease without periodic renewal, so a missing final result cannot pin compute forever. Raw task IDs, descriptions, output paths, summaries, prompts, and results never cross the VM-to-control-plane boundary.

Harness lifecycle versions are strictly monotonic within the session host. ProjectData accepts same-version active rereports as lease heartbeats but rejects older versions, so independently retrying HTTP reports cannot regress a newer active/inactive edge. Detaching an ACP process cancels its ticker and publishes inactive state before restart, credential, or install work continues.

ProjectData persists the normalized snapshot additively. Automatic sleep is ineligible while a fresh active/settling lease exists. The lease is finite and configurable so a crashed or incompatible adapter cannot strand compute forever. Liveness refreshes the lease; only lifecycle edges/progress refresh the separate progress clock. Callback authentication is fully bound to the session workspace/node before an active report can cancel a pending sleep claim.

### Durable parent wait and wake

Add `wait_for_subtasks` with a required stable workflow-step `waitKey`, direct-child IDs, `all`/`any` terminal condition, and an optional bounded wake deadline. ProjectData stores one active subscription per parent plus normalized child observations. Creation validates the canonical parent session and lineage, persists the wait before the tool tells the parent to end its turn, and retains the idempotency record after resolution so a lost response cannot create another wake.

Terminal hooks nudge ProjectData immediately. A bounded, configurable alarm reconciliation queries D1 in bind-safe chunks as a backstop so every terminal writer—including legacy paths that do not yet invoke the hook—converges. When the condition or deadline is satisfied, ProjectData freezes an immutable wake payload containing only trusted task IDs/statuses, enqueues one deterministic prompt through the existing transactional durable prompt-delivery mailbox, and then compare-and-sets the subscription to resolved. Child-authored summaries, errors, and URLs never enter the automatic parent prompt. A crash between those steps retries the same delivery ID and content instead of duplicating or conflicting. Persisted exponential backoff and a finite attempt cap prevent failed wakes—including invalid configuration and transient claim-validation reads—from hot-looping alarms or being silently lost. Parent status/session and child lineage are revalidated before enqueue, at claim, and immediately before recovery/container/VM mutations; the snapshot recovery claim is itself conditionally written against the live parent. Sleeping-VM recovery then uses a transactional `INSERT ... SELECT` handoff that creates and links a replacement task only while that parent remains non-terminal. Later claims recognize the linked recovery task as the temporary session owner, and a parent transition before runner startup atomically cancels the handoff and restores the original bindings. Terminal hooks cancel queued wakes, and delivery claims fail before session recovery when the parent is terminal.

The live parent is also carried into the replacement TaskRunner as revocable
authority. The TaskRunner validates the exact recovery task, source parent,
chat, project, and snapshot claim before storing its initial alarm and before
every alarm-driven orchestration step. It revalidates again immediately before
node/workspace allocation, provider provisioning, workspace dispatch,
attachment upload, agent restore/start, snapshot wake, and the final task
handoff. The delegated-to-in-progress D1 transition conditionally proves the
same live source and snapshot claim, while an already-restored/in-progress
pair remains retry-convergent across a DO crash. Every terminal/no-op race runs
the same idempotent ownership finalizer, including the restored-snapshot crash
window. A definite start failure atomically
fails the replacement, restores the source task/workspace bindings, and marks
the snapshot retryable; later TaskRunner failures restore those bindings before
the DO can complete. Human follow-ups that recover an already-completed
conversation remain intentionally unguarded.

For Cloudflare Containers, the same source guard is passed as internal RPC
metadata rather than serialized into the VM request. Capability, prompt, and
receipt calls select a guarded `VmAgentContainer` RPC that revalidates D1 inside
the container DO before request preparation, again at the physical
`startRuntime()` boundary, before snapshot restore, and before the final
`containerFetch()` prompt/request boundary. A revocation after a cold start
tears the replacement container back down rather than leaving stale compute.

Update `/workflow` to persist its state, call `wait_for_subtasks`, and end the current turn. Use bounded foreground polling only when the connected SAM server lacks the tool.

## Implementation checklist

- [x] Add failing Go tests for filtered Claude session metadata, extension parsing, active-set replacement, progress-vs-heartbeat clocks, settlement, raw-payload redaction, and periodic out-of-turn reporting.
- [x] Bound Claude extension bytes/task cardinality/identifiers, keep ordering credits exclusive to `session/update`, and stop/publish inactive harness state at every process-detach boundary.
- [x] Implement a generic normalized harness-work tracker with a Claude `_claude/sdkMessage` adapter in the VM Agent.
- [x] Add filtered lifecycle metadata to both NewSession and strict LoadSession requests without changing non-Claude requests.
- [x] Extend the activity callback contract and ProjectData session-state mirror with runtime-work state, count, source, heartbeat time, and progress time.
- [x] Add a finite configurable background-work lease and make both pre-claim and point-of-no-return sleep checks reject fresh active/settling work.
- [x] Add failing ProjectData/MCP tests for wait lineage, `all`/`any`, already-terminal children, duplicate terminal callbacks, deadline wake, cancellation/no-resurrection, deterministic single delivery, and alarm reconciliation.
- [x] Add adversarial coverage for D1 maximum batches, permanent delivery failure/backoff, lost-response registration retry, terminal overlap/claim cancellation, mutable replay windows, reparenting/session checks, child prompt-injection canaries, and sleep work beginning during R2 verification.
- [x] Add append-only ProjectData wait-subscription migrations (`029` base shape plus additive `030` replay hardening), row validation, bounded reconciliation, and alarm scheduling.
- [x] Register the parent-wake terminal hook and keep D1 reconciliation as the legacy-writer backstop.
- [x] Add the `wait_for_subtasks` MCP definition, dispatcher, handler, response contract, and API/reference documentation.
- [x] Update both Claude and Codex workflow instructions to prefer durable park/wake with a compatibility fallback.
- [x] Add cross-boundary contract tests proving exact VM callback JSON and Worker runtime validation agree.
- [x] Make sleeping-session recovery creation and chat-binding transfer atomic with the live source-parent predicate, and revoke a handoff if the parent terminalizes before runner startup.
- [x] Carry revocable recovery authority into TaskRunner start/alarms and atomically restore source ownership after definite start failure.
- [x] Carry parent authority through capability/prompt/receipt calls and revalidate inside the Cloudflare Container DO before physical wake.
- [x] Document new configuration defaults/overrides and the user-visible durable orchestration behavior.
- [x] Run focused Go race, ProjectData migration, workerd/Miniflare, MCP, sleep, and workflow tests.
- [x] Run full repository lint, typecheck, test, build, and applicable local quality gates.

## Pre-PR validation evidence

- `pnpm lint`: passed with existing warnings only.
- `pnpm typecheck`: passed across all 19 tasks, including the documented Astro baseline.
- `pnpm test`: the full API suite reported 552 files and 7,341 tests green after the serialized revoked-wake and physical workspace-boundary hardening.
- `pnpm build`: passed across all nine build tasks.
- `pnpm --filter @simple-agent-manager/api test:workers`: 49 real workerd files and 640 tests passed, including deterministic D1 triggers that revoke the source at allocation and container lifecycle-commit boundaries, persisted guarded warm-claim recovery, and an exclusive-claim crash simulation. The proxy-contract fixture now deletes the immediate TaskRunner alarms it creates, preventing pending DO RPCs from racing Worker-pool teardown after all assertions pass.
- Focused runtime-work mirror coverage: 100% statements, lines, and functions; 92.39% branches.
- `go test -race ./...`: passed with a test-only Docker command stand-in because this workspace has no Docker CLI; the complete ACP race package also passed directly in 15 seconds.
- Format ratchet, Oxlint shadows, migration safety/order, DO migration safety, source-contract, type-boundary, runtime-boundary, file-size, stale-artifact, repo-visibility, dependency-governance, direct-dependency, deployment-script, Wrangler-binding, agent-manifest, and Gitleaks current-tree/PR-range gates passed.
- Task-completion validator sections A-F: PASS. Research findings map to implementation items; every implementation item is present in the diff; acceptance behavior has focused and vertical-slice coverage; environment/API/workflow/process documentation matches the code; no implementation gap remains. Specialist, staging, CI, merge, and production checks are release gates in `/do` Phases 5-7 and remain tracked outside pre-PR task completion.
- Final authority-boundary hardening persists warm-node claim ownership before the NodeLifecycle alarm mutation, validates guarded lineage in that same D1 write, conditionally releases only the exact claimant, and recovers claims after TaskRunner crashes. Provider allocation now checks immediately around `createVM` and preserves provider identity for strict compensating deletion. Agent create/restore/start carry guards to the physical VM/container request boundary, while container restore rechecks inside its lifecycle lock and stops/resleeps on a late revocation. Focused unit suites (95 tests), the real NodeLifecycle workerd suite (26 tests), API lint/typecheck, and migration/order/file-size gates passed before the final full regression run.
- Seventh-review hardening carries recovery authority through workspace creation to both the direct-VM fetch and Cloudflare Container RPC boundaries, then revalidates after acknowledgement. Revoked cold-wake cleanup is serialized with lifecycle mutations, owned by the exact stored source guard, preserves explicit stopping/stopped state, and conditionally resleeps only the exact live node/workspace relationship. Regression coverage now includes persisted warm-claim crash recovery, strict cleanup before workspace creation, rejecting physical workspace/agent boundaries, post-D1 revocation compensation, stale-guard isolation, and real-workerd guarded claim persistence.

## Release ledger

- Specialist reviews: pending Phase 5.
- Staging deployment and real VM/session verification: pending Phase 6.
- PR CI, merge, and production deployment verification: pending Phase 7.

## Acceptance criteria

- A Claude background shell or subagent that outlives the top-level ACP prompt keeps the session ineligible for automatic sleep while its finite runtime-work lease is fresh.
- Runtime heartbeat, harness lifecycle progress, ACP prompt activity, and absolute task deadlines remain distinct clocks.
- No raw Claude SDK payload content is logged, persisted, broadcast, or sent to the control plane.
- Missing extension support is backward-compatible: the session retains existing ACP behavior and finite idle cleanup.
- A parent can wait for direct child tasks with `all` or `any`, end its prompt, and receive exactly one durable wake prompt after satisfaction or deadline.
- Child complete, fail, and cancel outcomes are observed even when they originate from a legacy terminal writer.
- A terminal parent is never woken or recreated by a late child callback.
- Sleeping parent sessions use the existing strict snapshot recovery and durable prompt-receipt pipeline; ambiguous deliveries are not replayed.
- `/workflow` no longer requires foreground polling when `wait_for_subtasks` is available.
- New migrations pass clean-install and previous-ledger upgrade tests, and existing chat/task/follow-up/cancel/sleep behavior remains green.
- A fresh staging VM demonstrates real Claude lifecycle reporting, sleep deferral, durable task wait/wake, cleanup to zero staging VMs, and no secret/raw-payload leakage in logs.
- CI is green, the PR is merged, and the production deployment for the merged SHA succeeds.

## Non-goals

- Inferring useful work from token volume or generic process liveness.
- Keeping background work alive without a finite lease or absolute task ceiling.
- Replacing ACP, the durable prompt mailbox, or the session snapshot/recovery system.
- Persisting harness-specific raw events in ProjectData.
- Implementing the full long-turn checkpoint supervisor from ready idea `01KZK586BN98BRDGKC44V12HT0`.
- Upgrading every ACP wrapper as a prerequisite; adapter support is capability/addition based.

## References

- SAM parent session `36a5bb77-2746-43c1-8669-030b51b8f36d`
- SAM parent task `01M03VFVP79GR882BJMPKZV58V`
- Ready idea `01KZK586BN98BRDGKC44V12HT0`
- Durable execution foundation task `tasks/active/2026-08-09-integrate-durable-execution-foundations.md`
- ACP extensibility: https://agentclientprotocol.com/protocol/v1/extensibility
- `acp-go-sdk` extension handler: https://github.com/coder/acp-go-sdk/blob/v0.13.5/extensions.go
- Claude ACP raw lifecycle option: https://github.com/agentclientprotocol/claude-agent-acp/blob/v0.58.1/src/acp-agent.ts
- Claude background-turn handling follow-up: https://github.com/agentclientprotocol/claude-agent-acp/pull/870
