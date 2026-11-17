# Hold follow-ups before the first VM (#2847)

## Scope and authorization

DRAFT PR ONLY. Do not mark ready, merge, deploy production, or open GitHub issues.
SAM task: 01M7MC453ZXPZ0TQA2RF08FJ1D. Idea: [01M7MC3E482AXTABR5G68BQRV2](https://app.simple-agent-manager.org/projects/01KHRJGANBBWGDY1NZ0KVF0D4J/ideas/01M7MC3E482AXTABR5G68BQRV2).

## Problem and preflight

A follow-up while the initial task waits for capacity reaches sleep recovery with no workspace or sleep snapshot, fails with `sleeping_snapshot_missing`, and fails the conversation. This is a business-logic-change crossing D1 task/runtime state and the ProjectData durable inbox. Keep the existing queue, attempt policy and TTL.

Research baseline: e5c5aa4f77e6adf389a24b25b9470a69c24acbff. Rechecked upstream main, 24 open PR titles, SAM task search for resolver and idea search for the refusal on 2026-11-17; no overlapping initial-start fix. Related #2693 and genuine sleep/Instant failures are distinct. Production anomaly sweep confirms genuine queued wakes exist; it does not reproduce the external reporter's case (no runtime IDs supplied).

Prior art: [leonceaklin's report](https://github.com/raphaeltm/simple-agent-manager/issues/2847) and [fork PR #17](https://github.com/zebra-pig/simple-agent-manager/pull/17). Independently reviewed candidate patch: starting task status alone cannot distinguish recovery, because recovery requeues tasks. Retained `sleeping_at` must preserve recovery authority. Credit reporter's diagnosis and approach in upstream PR.

Data flow: user follow-up → ProjectData acceptPromptDelivery → session_inbox claim/runPromptDeliveryClaim → DefaultVmPromptDeliveryAdapter → resolveVmPromptDeliveryTarget → D1 runtime/startup lookup → retry or VM prompt acceptance. Existing first-turn activity gate and turn-end nudge own ordering. TTL, not capacity retries, bounds waiting.

## Writer inventory and design

- `submit-vm-task.ts` / `submit-vm-task-effects.ts`, reserved submission storage, MCP dispatch, /sam dispatch/retry, trigger submission, project orchestrator: inspect exact task/chat binding creation before the runtime exists.
- TaskRunner `ensureSessionLinked` binds both task and workspace; workspace becomes ready before agent-session step commits `transitionToInProgress` (delegated → in_progress).
- `session-recovery.ts` reuses/requeues or replaces the task; retains sleep snapshot and releases previous task/workspace chat links. Snapshot lifecycle may create a checkpoint before any sleep; mere snapshot presence must not exclude startup.
- Nullers (recovery cleanup, unlink/stop) must not qualify an unrelated task. Query binds both project and exact chat; never falls back to project-wide queued work.
- Change only no-workspace target resolution. Add one bounded existence read there; no extra queries on live runtime path. Target file is 494 lines, so isolate startup lookup in a small service to stay within source-size rule.
- No public API, env, schema, or architecture change. Existing queue contract is restored; document behavior in architecture/overview.md and validation here and in PR.

## Checklist / acceptance

- [x] Finish writer inventory with exact paths and verification evidence.
- [x] Real-D1 regression goes red pre-fix for initial queued/delegated follow-ups.
- [x] Hold draft/ready/queued/delegated conversations without retained sleep, without recovery or failure.
- [x] Real durable inbox keeps retry attempts below cap; delivers after readiness and first turn end.
- [x] Existing TTL expires a still-waiting follow-up without renewal.
- [x] Genuine slept sessions with queued recovery tasks still reach recovery.
- [x] in_progress missing runtime, terminal tasks, project/chat mismatch, snapshot authority and allowWake=false controls retain behavior.
- [ ] Relevant local tests, lint/typecheck/build and full dispatched CI complete.
- [x] Local specialist reviews complete and findings resolved.
- [ ] Reserve/deploy staging, verify changed flow, clean up and release lease.
- [ ] Draft PR includes Closes #2847, contribution credit, review/CI/staging evidence and explicit draft-only constraint.
- [ ] Update SAM idea with PR and findings; leave task file active pending human completion confirmation.

## Verification evidence

Clean pre-fix Workers run (2026-11-17 09:19 UTC): 16 tests collected, 8 expected failures / 8 passing controls, no fixture or collection failures. The draft/ready/queued/delegated inbox slices fail with `wake_refused / sleeping_snapshot_missing`; eventual-delivery/TTL and checkpoint controls fail from the same incorrect classification. Log: `.tmp/2847/red-confirmed.log` (local). Root baseline lint 22/22 and typecheck 36/36 succeeded.

Writer inventory verified by independent Cloudflare review: `submit-vm-task-effects.ts:65–80`, `reserved-task-submission-storage.ts:25–47`, `routes/mcp/dispatch-tool.ts:451–481,610–615`, `project-orchestrator/scheduling.ts:483–518`; `/sam` dispatch/retry and trigger submission use reserved task storage. TaskRunner `workspace-steps.ts:79–86` commits queued → delegated, `in-progress-transition.ts:43–75` commits delegated → in_progress. `session-linking.ts` binds workspace+task before handoff; recovery nullers keep retained sleep history, and sleeping_at is cleared after replacement linkage. These are inspected real writers, while the new regression executes the primary web writer.

Post-fix validation: final startup Workers suite 17/17 passed; three adjacent suites (sleep-claim hold, wake-handoff gate, real wake-event handoff) 50/50 passed. A first combined run caught an incomplete test VM busy response and an overly exact expiration write-count assertion; both fixtures were corrected and final startup run passed. This does not substitute for live staging. Cloudflare specialist PASS; test-engineer finding addressed and re-reviewed PASS; task completion/constitution/doc-sync PASS for implementation, with CI/staging still pending. Root lint (22 tasks), typecheck (36), build (18), final API typecheck and changed-file formatting passed.

Broad local test run: 38/39 package tasks passed. API collected 1,088 files (1,083 passed, three skipped, two failed); all three failures were 5-second timeouts in unchanged archive-sharding/default-capacity-pools tests. Both files passed in isolation with unchanged timeouts and one worker: 230/230. Logs: `.tmp/2847/full-test.log` and `.tmp/2847/isolated-timeouts.log`. No unrelated timeout changes.

SonarCloud identified 21 duplicated lines in the new delivery claim test harness. Consolidated the four identical copies into `tests/workers/helpers/vm-prompt-delivery.ts`; the provider-limit helper re-exports it to preserve callers. Test-engineer re-review PASS: config, bindings, claim selection, hooks and timing unchanged. Five affected Workers suites are revalidating; runtime implementation unchanged.
