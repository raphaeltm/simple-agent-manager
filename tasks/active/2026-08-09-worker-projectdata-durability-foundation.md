# Worker/ProjectData Durability Foundation

## Problem Statement

ProjectData currently mirrors `prompt_started_at` from every activity rereport, so a productive old prompt can appear newly started forever. Its mailbox alarm expires and requeues records but never attempts queued VM delivery, while browser followups and orchestration prompts still use request-bound, partially duplicated send paths. This leaves accepted intent vulnerable to busy agents, runtime loss, ambiguous network responses, and repeated alarm selection.

This task implements the Worker-owned durability foundation from SAM idea `01KZK586BN98BRDGKC44V12HT0` and mission `382c796d-f8e7-4658-8ee0-2d2196a2f9cc`. It deliberately does not edit VM Agent lifecycle code, select checkpoint candidates, invoke checkpoint preemption, park/wake parents, or add `wait_for_subtasks`.

## Research Findings

### Existing data and control paths

- `apps/api/src/durable-objects/project-data/session-state.ts:upsertActivityState()` replaces `prompt_started_at` on each `prompting` or `recovering` report. It cannot distinguish a same-epoch rereport from a newly accepted prompt.
- `apps/api/src/routes/projects/agent-activity-callback.ts` is the authenticated VM activity boundary and persists reports through `ProjectData.reportActivity()`.
- `apps/api/src/durable-objects/project-data/mailbox.ts:runDeliverySweep()` only expires and requeues. `ProjectData.alarm()` never injects queued messages.
- `apps/api/src/routes/mcp/mailbox-tools.ts` and `apps/api/src/routes/mcp/orchestration-comms.ts` separately persist/send/queue prompts. Busy fallback can create a second mailbox identity after a transcript message was already persisted.
- `apps/api/src/routes/chat.ts` `POST /sessions/:sessionId/prompt` resolves a live runtime and awaits `sendPromptToAgentOnNode()` before acknowledging the browser.
- `apps/api/src/services/node-agent.ts:sendPromptToAgentOnNode()` already forwards a stable `messageId`, but the currently deployed VM only returns a 202 acceptance response; it has no receipt lookup contract yet.
- `apps/api/src/durable-objects/project-data/alarm-schedule.ts` is the canonical multiplexed alarm calculator. All readiness and enqueue paths must recalculate through it so heartbeat fast paths cannot starve delivery.
- ProjectData migrations are append-only in `apps/api/src/durable-objects/migrations.ts` and run lazily under `blockConcurrencyWhile()` plus `transactionSync()`.

### Retained incident lessons applied

- `tasks/archive/2026-06-20-reconciliation-prompt-in-flight.md`: never create a response deadline before proving a prompt was accepted; HTTP 409 means busy/non-acceptance.
- `tasks/archive/2026-07-02-projectdata-reconciliation-wall-time.md` and `.claude/rules/47-control-loop-io-budget.md`: persist local state first, cap candidates, use background timeouts, and move unreachable VM I/O off the alarm critical path.
- `tasks/archive/2026-05-15-fix-task-reconciliation-heartbeat-alarm-starvation.md`: every alarm reschedule path must use the same candidate set.
- `tasks/archive/2026-05-08-staging-projectdata-sqlite-migration-blocker.md`, `tasks/archive/2026-07-21-cloudflare-do-clean-install-migrations.md`, and `.claude/rules/31-migration-safety.md`: append migrations without table recreation and prove both a full clean chain and an upgrade from the prior ledger.
- `.claude/rules/45-durable-object-concurrency-mutex.md`: delivery claims use persisted compare-and-set attempt tokens so work completing across `await` cannot overwrite a newer attempt or terminal state.
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`: mailbox delivery is isolated from other alarm subsystems and readiness is distinct from heartbeat liveness.

### Architecture decisions

- `session_inbox` remains the only delivery queue. On integration with current main, migration 026 adds durable attempt/receipt/error scheduling columns and a separate `checkpoint_episodes` state table after migration 025's finite-TTL backfill; it does not introduce another queue.
- A typed `VmPromptDeliveryAdapter` owns capability discovery, stable delivery submission, and receipt lookup. The legacy adapter may retry only positive non-acceptance (busy/not-ready). A lost response without stable receipt support becomes explicit cross-runtime ambiguity and is never replayed automatically.
- All prompt producers call one ProjectData acceptance operation that atomically persists the transcript message and mailbox delivery identity before any VM I/O. Feature flags preserve the current direct route for old deployments while the durable route is disabled by default.
- The alarm synchronously claims a bounded batch in SQLite, then runs adapter I/O with `waitUntil()` and a background timeout. Result writes compare both row state and attempt token.
- `prompt_started_at` is preserved for prompting/recovering rereports unless the report carries a newer explicit prompt epoch produced by genuinely accepted delivery. Leaving prompting clears the active epoch rather than manufacturing a new one.
- Checkpoint episodes are idempotent on `(acp_session_id, prompt_epoch)` and persist state, attempts, errors, progress-envelope metadata, activity events, and debug snapshots. Candidate selection and preemption invocation remain disabled.
- A typed terminal-transition hook registry is added as a no-subscriber seam for the later parent wake implementation; this task does not create wait subscriptions.

## Primary Data Flow Trace

1. User followup, mailbox send, or orchestration handoff
   → route/MCP handler validates project, task, session, and creator scope
   → shared durable prompt acceptance service
2. Durable acceptance
   → `ProjectData.acceptPromptDelivery()` transaction
   → one `chat_messages` row plus one `session_inbox` queue row with the same stable delivery ID
   → quick accepted response
3. ProjectData delivery owner
   → enqueue/readiness/alarm calls the canonical alarm calculator
   → alarm claims bounded due rows with persisted attempt tokens
   → `ctx.waitUntil()` invokes the typed VM adapter
4. Runtime result reconciliation
   → stable receipt confirms accepted/completed, or positive busy schedules bounded backoff
   → terminal/dead target records explicit failure
   → lost response plus runtime identity mismatch/no receipt support records `ambiguous_delivery`
5. Visibility
   → mailbox REST/DO reads and session durability snapshot expose state, attempts, next retry, error, receipt, runtime identity, and related checkpoint episode
   → structured activity events and metrics record every transition.

## Implementation Checklist

### Schema and shared contracts

- [x] Add append-only ProjectData migration 026 for durable delivery metadata and `checkpoint_episodes`, using only additive CREATE/ALTER/INDEX statements.
- [x] Add Valibot-backed row schemas and shared delivery/checkpoint/capability/receipt types and state transitions.
- [x] Add named shared defaults for flags, candidate cap, background timeout, exponential backoff, TTL, receipt timeout, and max attempts.
- [x] Add migration clean-install, upgrade-chain, schema-barrier, and persisted-state coverage.

### Prompt epochs and checkpoint episodes

- [x] Preserve original same-epoch `prompt_started_at` across prompting/recovering rereports.
- [x] Accept a newer epoch only when explicitly supplied from a genuinely accepted prompt and clear the active epoch on terminal/idle activity.
- [x] Add the recent-activity/old-prompt regression plus real SQLite same-epoch/new-epoch tests with an injected/fake clock.
- [x] Add typed idempotent checkpoint episode create/get/list/transition APIs keyed by ACP session and prompt epoch.
- [x] Persist attempts, bounded sanitized errors, progress-envelope metadata, activity events, and debug visibility for checkpoint transitions.

### One durable delivery pipeline

- [x] Add atomic ProjectData durable acceptance for transcript plus mailbox identity and use it from durable followups, mailbox sends, and orchestration handoffs.
- [x] Refactor immediate and queued delivery through one typed/injectable VM adapter.
- [x] Claim a bounded batch, attempt real queued delivery off the alarm critical path, and retry busy/not-ready rows with named exponential backoff.
- [x] Fail TTL/max-attempt/dead/terminal targets explicitly and prove duplicate alarms cannot invoke a delivery twice.
- [x] Reconcile stable receipts before retry; mark lost-response/runtime-change/no-receipt ambiguity explicitly and never replay it.
- [x] Recalculate delivery on enqueue, readiness/activity changes, attempt completion, retry scheduling, and duplicate alarms through the canonical alarm calculator.
- [x] Preserve old VM/direct followup behavior behind flags and fail closed when a required capability is absent.

### APIs, hook seam, observability, and docs

- [x] Expose durable delivery/checkpoint state through typed ProjectData service methods and project/session debug REST reads.
- [x] Add the shared terminal-transition hook seam without implementing subscriptions or parent wake delivery.
- [x] Emit structured transition logs/activity events and delivery/checkpoint/ambiguity/latency metrics.
- [x] Document every new environment variable in `apps/api/.env.example`, `apps/api/src/env.ts`, and the public configuration reference.
- [x] Document the implemented Worker schema/adapter contract and explicitly identify checkpoint preemption and park/wake as future integration work.

### Verification and shipping

- [x] Add fake-clock unit and real ProjectData SQLite/workerd tests for busy→ready exactly once, retry/backoff/TTL, dead/terminal targets, duplicate alarms, stable receipt reconciliation, ambiguity, old VM compatibility, and normal task/chat prompts.
- [x] Add vertical-slice/contract coverage for browser/API→ProjectData→VM adapter and MCP mailbox/handoff producers.
- [ ] Run focused tests and full `pnpm lint && pnpm typecheck && pnpm test && pnpm build` plus migration safety gates.
- [ ] Run task-completion, Cloudflare, security, environment, constitution, documentation, and test specialist reviews; address all blocking findings.
- [ ] Deploy to staging, verify ProjectData migration state via Cloudflare, exercise real task/chat/followup/mailbox behavior, and clean up any test VMs.
- [ ] Open a PR, update from latest `main`, wait for green CI, merge, monitor production deployment, and publish schema/adapter contracts and remaining risks to the mission.

## Acceptance Criteria

- Same-epoch prompting/recovering reports preserve the original prompt start even when recent messages refresh activity; a genuinely accepted new prompt establishes a newer epoch.
- The existing ProjectData mailbox alarm attempts queued delivery. A busy target is retried with bounded backoff and delivered exactly once when ready; TTL, max attempts, dead targets, and terminal targets become explicit terminal records.
- Browser followups, mailbox messages, and orchestration handoffs share one persisted acceptance and delivery identity, with current direct behavior available only through documented compatibility flags.
- A stable VM receipt is reconciled before any replay. Cross-runtime or lost-response ambiguity without positive evidence is explicitly visible and never guessed/replayed.
- Migration 026 applies on both a clean ProjectData database and an upgrade through migration 025 without destructive statements or data loss.
- Checkpoint episodes are typed, idempotent by ACP session plus prompt epoch, transition safely, expose progress/error/attempt metadata, and remain inert because candidate selection/preemption is disabled.
- Capability negotiation fails closed, old VMs continue supported current behavior, and no feature silently downgrades security or exact-once guarantees.
- Normal task starts, conversation starts, short prompts, chat followups, mailbox tools, and task completion remain covered.
- The terminal-transition seam exists with no wait subscriptions, automatic checkpoint preemption, or parent park/wake behavior.
- Required local gates, specialist reviews, staging verification, CI, merge, production monitoring, and mission contract/risk publication complete successfully.

## References

- SAM idea `01KZK586BN98BRDGKC44V12HT0`
- Mission `382c796d-f8e7-4658-8ee0-2d2196a2f9cc`
- `apps/api/src/durable-objects/project-data/`
- `apps/api/src/routes/mcp/mailbox-tools.ts`
- `apps/api/src/routes/mcp/orchestration-comms.ts`
- `apps/api/src/routes/chat.ts`
- `apps/api/src/services/node-agent.ts`
- `packages/shared/src/constants/reconciliation.ts`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/45-durable-object-concurrency-mutex.md`
- `.claude/rules/47-control-loop-io-budget.md`
