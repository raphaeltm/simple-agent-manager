# Fix Instant cf-container sleep leak

## Problem statement

An Instant (`cf-container`) conversation can finish its prompt and remain physically running for hours when the last activity callback reports `idle` with active/settling runtime work and no later inactive callback arrives. The container may later have expired work bookkeeping but no restorable snapshot. The runtime sleep guard correctly preserves the container without a verified snapshot, but the automatic session sleep scheduler currently discovers only VM workspaces missing sleep intent rows. Existing stranded Instant sessions therefore never enter the durable snapshot-backed sleep transaction.

Source idea: SAM idea `01M2CJ1F6R0GNHBKT6E5T2G9KC`.

## Research findings

- `apps/api/src/scheduled/session-sleep.ts` has `reconcileUnscheduledSessionSleeps()`, a bounded D1-only discovery pass that creates durable sleep intents via `queueWorkspaceSessionSleep()`. It currently requires `nodes.runtime = 'vm'`, so eligible `cf-container` workspaces with no `session_snapshots` row are skipped.
- `apps/api/src/services/session-sleep.ts` already keeps the destructive stop behind the runtime-neutral `sleepWorkspaceSession()` flow: authoritative idleness check, final snapshot capture, restorable snapshot check, R2 artifact verification, re-read of activity, stopping claim, runtime-specific stop, D1/ProjectData finalization, and compute cleanup.
- `queueWorkspaceSessionSleep()` already records the workspace/node/project/chat/agent/runtime in `session_snapshots`, so broadening discovery to `cf-container` can reuse the existing durable transaction instead of adding a second stop owner.
- `classifySessionIdleness()` already treats an expired active/settling harness-work lease as no longer blocking sleep while fresh runtime work still defers and returns `retryAt`.
- Unit coverage exists in `apps/api/tests/unit/scheduled/session-sleep.test.ts` for VM missing-intent reconciliation, retry isolation, budget fairness, claim CAS, active-work deferral, and Instant-specific sleep delay calculation.
- The fix must preserve the snapshot safety guard. It must not stop containers on keepalive expiry, force task completion, hide sessions, or treat every idle callback as terminal.
- Instrumentation should include runtime-work fields and classification on callback telemetry, but must only log allowlisted nonsecret values.

## Implementation checklist

- [x] Add a failing scheduler regression for a running `cf-container` workspace with an in-progress awaiting-followup task, `idle`/expired active or settling runtime work, no `session_snapshots` row, and no later callback. The test must verify discovery creates the sleep intent and a later due sweep sleeps it through the existing path.
- [x] Update unscheduled sleep reconciliation to include supported Instant workspace nodes while preserving VM behavior, bounded batch size, metadata guards, and idempotence.
- [x] Ensure discovery remains fair when a batch contains mixed VM/Instant, malformed, active, and already-scheduled candidates.
- [x] Add structured logs for successful sleep-intent reconciliation that include source, runtime, workspace, chat, user, and node IDs without prompts, tool content, env values, headers, or secrets.
- [x] Extend ACP activity callback telemetry with allowlisted runtime-work state/count/source/timestamps and the classification decision so future incidents can distinguish legitimate settling from stale work.
- [x] Update tests for telemetry fields and Instant discovery behavior.
- [x] Run targeted API tests, API typecheck/lint, and full repo `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- [x] Run task-completion, Cloudflare, constitution/config, security, and test reviews before PR.
- [ ] Deploy to staging, verify automatic Instant sleep/wake behavior with tracked resource IDs, and clean up test compute.

## Acceptance criteria

- Automatic Instant sleep no longer depends on a later inactive callback or a preexisting snapshot row.
- Existing eligible stranded `cf-container` sessions are discovered by the bounded scheduled reconciliation pass and enter the same verified snapshot-backed sleep transaction used by other session sleep paths.
- Fresh active/settling work remains protected; expired stale work can become eligible according to the canonical idleness predicate.
- No destructive runtime stop occurs before a verified restorable snapshot and R2 artifact check.
- Scheduler selection remains bounded, isolated, idempotent, and fair across mixed VM/Instant candidates.
- Callback telemetry exposes enough nonsecret runtime-work/classification data to diagnose future intermediate idle reports.
- No hardcoded incident IDs, production-only backdoors, forced task completion, or weakened snapshot guards are introduced.
