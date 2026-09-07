# Durable event delivery, one-off schedules, and project channels

## Request and delivery constraints

Implement the eventing expansion in one green PR. Keep the PR open; do not merge. The current integration branch is `sam/use-sam-mcp-tools-tzqw0k`, with one open PR, #2031. Historical implementation branches fed this integration; do not open separate PRs or merge this PR. The coordinator owns integration, final review, one consolidated staging window, and CI. Technical implementation records belong here; private research stays in the SAM library.

## Baseline findings

Research baseline: `31a07235babf3f25ecd42db3ef077f003c664245`.

- The canonical `project_event_*` tables, exact/set filters, source admission deduplication, subscription MCP CRUD, pull/ack, and superadmin inspection exist. Requested prompt delivery still resolves to `recorded_not_injected`.
- Subscription ownership currently depends on replaceable runtime/task identity. Stable chat ownership and lineage checks are required for repeated sleep/recovery.
- Event retention has no automatic caller. Expiry builds variable `IN` lists; two statements reserve two and three parameters, respectively, so the second permits only 97 IDs under workerd's 100-bind limit. Retention currently refreshes accounting through full aggregates.
- Durable prompt acceptance already owns transcript/inbox atomicity. Its post-commit finalizer must be shared by event materialization, preserving all existing hooks and recalculating alarms in `finally`.
- Lifecycle producers include best-effort admission that can lose a wake-critical event before it reaches the durable bus.
- GitHub event admission lacks CI/review families. Authenticated generic webhook triggers submit tasks without forwarding facts into the event bus.
- There is no persisted one-off schedule intent, agent publishing/catalog/history interface, operational standing-watch action, or actual-credential limit event producer.

## Shared architecture and ownership

Use the existing per-project event store and durable prompt mailbox. Do not introduce a parallel event or prompt queue. Split event facts, subscriptions/routing, schedules/action intents, and transport outcomes explicitly. New public/tool/storage boundaries use runtime validation. Operational limits live in shared defaults with environment overrides and matching deployment/docs configuration.

The event wake baseline is the approved Revision 6 plan in SAM review task `01M1F086MQBD7WYTG7NB66KTA4`. Retrieve its full description and output summary; the summary contains important retention clarifications. The current request additionally authorizes same-project scheduled messages and normal task-backed session creation. Those extensions retain existing messaging, project-membership, credential, profile, and task-submission authority.

Implementation slices:

| Slice                                              | Owner boundary                                                                                                              | Dependencies                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| A: Core delivery and retention                     | ProjectData event/prompt modules, stable access, alarm/liveness integration; owns DO migrations during first wave           | Existing baseline                                             |
| B: CI/review/webhook producers and source recovery | GitHub producers, authenticated webhook route, lifecycle emission reliability and D1 outbox if needed                       | Existing event-admission API                                  |
| C: Credential-limit events                         | Actual credential identity propagation, authenticated usage/limit callbacks, bounded threshold state and event producer     | Existing event-admission API                                  |
| D: One-off schedules and standing watches          | Persisted intent, due processing, normal task submission adapter, public API/MCP controls                                   | A integrated; share A mailbox/finalizer and B source boundary |
| E: Agent channels and project/session UI           | Publishing/catalog/history/catch-up; member controls for subscriptions, watches and schedules, filter/delivery explanations | A and D contracts integrated; B/C event families available    |

A owns append-only DO migration IDs in wave one. B reserves D1 migration 0144 if necessary; C reserves 0145 if necessary. Later slices append after integration. Each slice may update required shared types, constants, Env and docs with narrowly scoped changes; the coordinator resolves overlapping imports and barrels. No speculative shared abstractions or duplicated placement/task-submission logic.

## Implementation checklist

### A. Bounded retention and durable same-chat event delivery

- [x] Chunk every variable SQL statement by its own remaining bind budget; verify 97/98/99/100/500 boundaries in real workerd.
- [x] Replace retention hot-path aggregates with bounded incremental accounting and indexed candidates; use one overall mutation budget, dependency-safe cleanup, monotonic missing-batch repair, and exact observed eligible-work `hasMore` semantics. Discover orphan matches through an indexed bounded candidate window and durable cursor; `hasMore: false` does not claim global absence in uninspected rows. Advance healthy windows at the ordinary daily maintenance cadence, document legacy-orphan discovery latency, and prevent bounded continuation from becoming an unbounded hot loop.
- [x] Clamp admission control timestamps to one captured server time; preserve source occurrence time only as evidence. Add additive migrations/indexes and verify both fresh and upgrade paths.
- [x] Add independent materialization and retention candidates to the shared alarm scheduler with persisted retry checkpoints, bounded backoff, failure isolation and outer-finally re-arming. No network work in local materialization transactions.
- [x] Introduce versioned stable `(projectId, chatSessionId)` ownership with task/runtime provenance and lineage guards; preserve bounded legacy pull compatibility without making legacy subscriptions wake-capable.
- [x] Make finite self-chat `existing_session_prompt` subscriptions operational and return truthful checkpoint/end-turn instructions. No-match expiry is silent; it does not keep compute awake.
- [x] Extract transaction-internal prompt acceptance and shared post-commit finalization. Preserve transcript-inserted gating for idle cleanup, human attention, workspace activity, summary and `message.new`; retain unconditional `mailbox.enqueued`; recalculate alarms in `finally`; no hooks on rollback.
- [x] Atomically claim matches, create a ULID batch, accept inbox/transcript, and account for capacity. Share the claim primitive with pull; typed capacity deferral rolls back without failure backoff.
- [x] Project mailbox state monotonically into batch/attempt state using additive transport columns and internal checkpoint upserts. Keep public append-only attempt fingerprints compatible; distinguish synthetic attempt zero from physical attempt limits.
- [x] Define pull-versus-wake behavior for queued, delivering, delivered, ambiguous and acknowledged states. Revoke a queued prompt atomically when pulled; never blindly replay ambiguous receipt to another runtime.
- [x] Preserve read/ack grace for accepted batches after natural subscription expiry. Cancellation, terminalization, authorization loss, target changes and kill-switch changes prevent physical side effects; recheck before recovery and physical submission.
- [x] Enforce real mailbox/storage caps, batch limits, one in-flight wake per target, per-target/subscription cooldown and lifetime limits.
- [x] Keep finite event leases out of sleep/idleness predicates; use them to prevent reconciliation check-ins and false terminalization while durably waiting.
- [x] Wake messages contain only fixed platform wording and IDs. Event reads fence external content as untrusted evidence; do not log event-controlled strings as operational messages.

Section A was reopened after independent Cloudflare/security review. Repair requirements and runtime evidence are tracked in `2026-09-07-event-wake-review-fixes.md`.

### B. Source reliability and CI/review/webhook events

- [x] Persist wake-critical lifecycle emission intent alongside the authoritative transition or implement bounded authoritative reconciliation; retry failed admission with stable delivery identity. Verify a failed first admission eventually yields one event. Do not claim blanket source-capture guarantees.
- [x] Add `check_run`, `check_suite`, `workflow_run`, `pull_request_review`, and `pull_request_review_comment` adapters with repository/PR/commit/run correlation and deterministic delivery keys. Older commit results must be distinguishable from the current push.
- [x] Update GitHub App event subscription/permission setup and upgrade guidance, plus schemas/filters/tool contracts where relevant. Preserve existing trigger behavior and blank source labels.
- [x] Forward authenticated generic webhook facts into canonical project event admission with deduplication, bounded payloads, provenance and truthful failure/filtered outcomes.

Section B was reopened after independent review. Parent verification passes the existing 76 focused and 25 Workers tests, but review reproduced losing-transition emissions, unfenced retry claims, false conflict success, unbounded expired history and unsafe or unadmittable webhook metadata. Required fixes and runtime evidence are tracked in `2026-09-07-event-source-review-fixes.md`.

### C. Credential-limit awareness

- [x] Trace credential selection through VM and container/harness/proxy boundaries. Attach limit observations to the credential/account actually used, never merely a provider/profile label or caller-supplied credential ID.
- [x] Implement a real authenticated telemetry-to-event path using supported provider/harness limit evidence. Include window, reset, source, observation time and freshness; unsupported telemetry is explicitly unknown.
- [x] Emit warning/critical/rejected/reset transitions with stable identity and duplicate suppression. Keep raw per-token/sampling streams outside ProjectData event storage; bound state retention and retries.
- [x] Restrict visibility to affected authorized projects/sessions, redact secrets, and test identity forgery, project isolation, stale/out-of-order samples and repeated threshold crossings.

### D. One-off schedules and standing watches

- [x] Persist schedule intent with stable ID, creator project/chat/user, due UTC time and display timezone, explicit `message_session` or `start_session` action, bounded payload, profile/skill identity, version, idempotency key, late/expiry policy and resulting event/delivery/task IDs.
- [x] Provide create/list/get/reschedule/cancel through authorized APIs and MCP. Reschedule/cancel use versioned compare-and-set; after action admission, report that cancelling the schedule does not retract already-started work.
- [x] Index pending due times and register the next due alarm in the existing shared scheduler; bound each pass, recover after exhausted automatic retries, and measure due-to-admission delay.
- [x] Existing-session action atomically admits the event and durable message via A's mailbox boundary. Allow authorized same-project targets; busy targets queue safely, sleeping targets restore the same chat, invalid/archived/cancelled/unrestorable targets fail visibly without silently creating a different chat.
- [x] New-session action reserves a stable task ID and durable submission intent before crossing from ProjectData to D1/task submission. Use the centralized profile/runtime/credential/placement resolver and reconcile crash-after-submit retries without duplicate tasks.
- [x] Schedules survive creator token expiry and hold no compute. Revalidate authority and profile availability at fire time; never save bearer tokens. A new-session schedule survives creator-chat archive unless cancelled.
- [x] Apply bounded late-run grace, delivery TTL measured from due/admission, finite capacity deferral and explicit expired/failed/ambiguous outcomes. Never promise exact-second model execution or exactly-once agent side effects.
- [x] Add project-owned standing watches with visible creator, predicate, target/action, profile, cost/concurrency/cooldown controls, pause/revoke and resulting task lineage. Reuse canonical matching and normal task submission; agents cannot self-grant policy-owned authority.

### E. Agent channels and user controls

- [x] Add bounded agent publishing with server-derived actor identity, a reserved agent namespace, idempotency, payload/rate/fanout limits and project isolation.
- [x] Maintain channel catalog summaries incrementally and expose bounded history. Implement an atomic cursor/history-to-subscription handoff that cannot lose events in the gap or double-deliver already-consumed history.
- [x] Add ordinary-member project and contextual session surfaces for subscriptions, scheduled actions and standing watches. Show creator/reason, target, due/expiry, requested versus actual delivery, status/reason and revoke/cancel controls.
- [x] Provide Schedule once forms for both actions, real API wiring, list/inspect/reschedule/cancel and clear late/busy/failed outcomes. Explain filtered trigger deliveries using existing audit evidence.
- [x] Keep controls project-scoped; follow shared UI patterns, mobile accessibility and existing authorization. Do not ship fixture-only routes.
- [ ] Capture and inspect desktop/mobile Playwright screenshots of every changed surface, with long text, many items, empty and error states; prove viewport bounds and scroll behavior with assertions.

### Integration and release evidence

- [x] Update canonical public docs, API contracts, reference skills, configuration documentation and changelog as applicable; distinguish implemented delivery from requested capabilities.
- [x] Run meaningful race/vertical-slice tests with real workerd limits, provider-boundary tests and existing event/mailbox/task-wait/sleep/archive regressions; Go checks when touched.
- [ ] Run full lint, typecheck, tests and build, plus relevant migration/config/security/quality gates.
- [ ] Complete independent local specialist review: task-completion, Cloudflare, security, test-engineer, constitution/env/docs, UI/UX, and Go if touched. Fix correctness findings before staging.
- [ ] Coordinate one consolidated staging window on the final candidate. Prove two same-chat sleep/recovery cycles, scheduled message to sleeping chat, new task-backed scheduled session with creator offline, cancellation/duplicate/deferred/error behavior, CI/review/channel/credential producer paths, and VM/container compatibility claims.
- [ ] Collect truthful latency/outcome/cost/storage evidence, inspect deployed configuration, and clean only this workflow's staging resources immediately (zero VMs at rest).
- [ ] Open one PR, attach reviewed UI screenshots and specialist/staging evidence, make required checks green, trigger CodeRabbit using its label and address any feedback. Leave open without merging.

## Reviewed local completion checkpoint (2026-09-07)

Current branch: `sam/use-sam-mcp-tools-tzqw0k`. One open PR: **#2031; do not merge**. Checked implementation items below the original baseline now reflect reviewed source and completed local verification. They do not certify deployed end-to-end acceptance. Historical child-session results below remain historical; the current evidence supersedes their pending/failing checkpoints only for the scopes explicitly rerun.

| Scope | Source and completed evidence |
| --- | --- |
| A: retention, mailbox and same-chat delivery | `project-events-status-retention.ts`, `project-events-orphan-retention.ts`, `project-events-scheduler.ts`, canonical prompt acceptance/finalization, wake/transport/access modules, and additive DO migrations through 054. Real Workers cover 97/98/99/100/500 bind boundaries, expiry/rollback, pull/wake races, cancellation and late authority fencing. The final retention rerun passes all 50 `project-data-events` cases and all five bounded-orphan cases, including measured reads over 1,000/20,000 healthy rows, deep durable cursor continuation, zero remaining budget, and dependency-safe attempt/match/batch/event draining. Logical repaired/deleted results use returned rows; index writes still consume the conservative physical mutation budget. |
| B: producers and source reliability | `github-project-event-producer.ts`, authenticated webhook ingress, lifecycle input builders, `task-terminal-transition.ts`, and source-outbox capture/reconcile modules. Source tests cover failed admission/retry, immutable capture, losing CAS, lease fencing, replay conflict, and repeated terminal transitions after task requeue. Authoritative capture is guaranteed for the shared terminal-transition D1 batch. TaskRunner failure and MCP completion use explicitly opted-in hook-bound capture; MCP captures before cleanup, but neither legacy writer claims atomic task/outbox capture. |
| C: actual credential limits | Runtime credential attribution/generation, proxy telemetry, ACP callback authorization and VM ACP forwarding/coalescing. The repaired API suites include real JWT authorization, stale/generation identity fences and threshold-window tests. Full VM Go coverage and the complete ACP race run pass. Supported evidence remains provider rate-limit headers and supported Claude ACP limit reports; unsupported harness telemetry stays unknown. |
| D: schedules and standing watches | `project-event-schedules-*`, schedule/watch APIs and MCP, reserved submission/checkpoint/start guards, and canonical placement. Workers verify schedule authority, admission/receipt identity, recovery, cancellation, deadlines and task creation boundaries. Recovery reads canonical receipts first; a queued reserved task can receive a versioned, authority-checked bounded retry within its original deadline, without allocating new identities. Unknown or ambiguous execution never authorizes blind message replay or releases watch concurrency. |
| E: channels and member/session controls | Canonical channel publish/catalog/history/catch-up, member subscription APIs, schedule/watch controls, `SubscriptionDeliveryHistory`, and `ScheduleExecution`. Member delivery inspection returns a bounded transport-only projection and rechecks project authority. The UI uses real API adapters; 14 original + six recovery/delivery + two repeated browser scenarios pass at 375×667 and 1280×800, with 94 retained screenshots and 18 new screenshots reviewed. Those browser scenarios mock API responses; actual route/storage behavior is covered separately by Workers. |

Completed validation ledger:

- API baseline: 9,091/9,152 tests passed in 656/676 files. After fixes, **all 20 previously failing suites plus four focused suites passed: 24 files / 536 tests**, recorded in `.tmp/eventing/api-tests-fixed.log`. This is not a claim that the entire final API suite was rerun green.
- Final seven-file Workers run: 91/94 passed; only three retention assertions failed. The corrected two-file rerun passed **55/55**, including the newly added fifth orphan-retention case (`.tmp/eventing/workers-retention-fixed.log`). Combining each file's latest successful run gives **seven suites / 95 tests passed**, not one single 95-test invocation. Original run: `.tmp/eventing/workers-final.log`.
- Full VM Go coverage passed (`.tmp/eventing/go-vm-final.log`); full ACP package with `-race` passed (`.tmp/eventing/go-acp-final.log`). Browser evidence above is local and uses mocked HTTP boundaries.

Explicit remaining criteria and limitations:

1. **A2 is complete under an explicit evidence-backed correction to the approved Revision6 plan** (SAM review task `01M1F086MQBD7WYTG7NB66KTA4`). That plan assumed a `LIMIT 1` orphan anti-join probe bounded total inspected work. Real workerd measurements over 1,000 and 20,000 healthy matches disproved that assumption: the anti-join scans the healthy prefix before satisfying its result limit. The corrected implementation limits indexed candidates before checking parents and persists its discovery cursor in the existing scheduler singleton. `hasMore` precisely reports observed actionable overflow; `false` does not certify global absence in an uninspected suffix. Healthy windows advance at ordinary daily maintenance cadence without healthy-match writes or a fast continuation loop. Legacy orphan discovery can therefore take multiple maintenance intervals, proportional to the retained candidate prefix and configured window size; a completed sweep wraps so newly missing parents are revisited. The five passing real Workers cases cover bounded measured reads, deep persisted seeks, continuation/wrap, zero remaining budget and dependency-safe logical deletion counts. This is a documented implementation-plan correction justified by measured runtime behavior, not an outstanding implementation requirement or a new approval prerequisite.
2. **Every-changed-surface screenshot criterion remains open:** the eventing app surfaces have the browser evidence above, while the public-site GitHub setup/sidebar changes still require their pending browser verification and reviewed artifacts.
3. Final serialized workspace lint/typecheck/build/test and migration/configuration/quality checks, and the consolidated specialist sign-off, are still in progress. Passing targeted suites and prior scoped reviews are not substituted for these release gates.
4. One consolidated staging window is still required. Real canaries must prove both same-chat sleep/recovery cycles, sleeping-chat scheduled delivery, task-backed scheduled creation with creator offline, safe cancellation/duplicates/defer/error outcomes, supported producer paths, and the claimed VM/container behavior. Local mocked browser tests and external-boundary doubles do not provide this evidence.
5. Deployed configuration, real latency/outcome/cost/storage evidence, workflow-owned resource cleanup, durable screenshot attachments, required green PR checks and CodeRabbit review remain outstanding. Keep PR #2031 open and the task active; do not archive or merge.

No remaining A–E implementation gap was identified in this reconciliation. A2’s corrected discovery semantics and latency tradeoff are explicit above; release acceptance remains incomplete for the outstanding verification and release evidence requirements.

## Acceptance criteria

Every checked item above must have implementation and test/manual evidence. The end-to-end canaries must demonstrate real delivery and task creation, not only stored timestamps. Retry after admission and before result recording must preserve stable identities. Cross-project/forged identity, cancelled or stale authority, and ambiguous receipt must fail safely and visibly. A subscribed or scheduled agent must release compute while waiting. Retention must remain bounded on production-shaped data and must not starve unrelated alarm branches.

## Explicitly outside this implementation

The source report deferred broad email integration, arbitrary workflow DAG editing, fuzzy LLM filters, harness-specific interruption/steering, event-or-deadline convenience racing, and cross-account workload routing. These are not prerequisites for the portable delivery and scheduling contract. Credential-limit events do not require the full project token-analytics product.

## Validation record

Pre-slice baseline at `a82e1adbb`/retry base `a6c764206`: frozen-lockfile install passed; `pnpm lint` passed all 13 packages with existing warnings; `pnpm exec turbo run typecheck --concurrency=1` passed all 19 tasks. An initial concurrent typecheck/build process exited 137; serialized execution passed. No feature verification claimed before slice C.

Slice C retry 1 on `sam/recover-credential-limit-event-d8sstv` from `a6c764206`: implemented actual-credential limit telemetry with D1 migration `0145_credential_limit_windows`, server-verified VM/container/proxy credential attribution, OpenAI/Anthropic header extraction, Claude ACP `_claude/rateLimit` callback ingestion, edge-only `credential.limit.warning|critical|rejected|reset` project events, bounded per-credential window state, stale/duplicate suppression, and redacted session-scoped callback authorization. Current supported telemetry paths are Anthropic/OpenAI upstream rate-limit response headers through SAM proxy/container routes and Claude Code ACP `_meta._claude/rateLimit` via VM callback. Codex ACP account rate-limit events are not forwarded by `@agentclientprotocol/codex-acp@1.10.0`; Codex is supported only when traffic crosses the SAM OpenAI proxy headers in this slice. Token/context usage without provider window/reset evidence remains explicitly unsupported for limit events. Validation: `pnpm --filter @simple-agent-manager/api typecheck`; `pnpm --filter @simple-agent-manager/api lint`; `pnpm lint` (13/13 packages, existing warnings only); `pnpm exec turbo run typecheck --concurrency=1` (19/19 tasks); `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/credential-limit-events.test.ts tests/unit/ai-proxy-passthrough.test.ts tests/unit/routes/ai-proxy-accounting.test.ts` (3 files, 29 tests); `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/routes/ai-proxy.test.ts tests/unit/routes/ai-proxy-anthropic.test.ts` (2 files, 58 tests); `pnpm --filter @simple-agent-manager/shared build`; `PATH=... GOTOOLCHAIN=local go test ./internal/acp -run 'Test(FetchAgentKeyPropagatesAgentSessionAndCredentialAttribution|UsageReportFromClaudeRateLimitUsesStoredCredentialAttribution|UsageReportSkipsContextUsageWithoutRateLimitMetadata)'`; `PATH=... GOTOOLCHAIN=local go test ./internal/acp`; `git diff --check`. No child PR, staging mutation, merge, or main push.

Section B child validation on `sam/implement-cireview-authenticated-webhook-2b57t8`:

- Implemented GitHub `check_run`, `check_suite`, `workflow_run`, `pull_request_review`, and `pull_request_review_comment` project-event producers with source `github`, delivery key `delivery:<GitHub delivery id>`, commit subject for CI events when a head SHA exists, pull-request subject for review events, and repository/PR/head/run/check/review/comment identity in bounded metadata.
- Implemented authenticated generic webhook project-event admission with source `webhook`, event types `webhook.accepted`, `webhook.filtered`, `webhook.still_running`, `webhook.concurrent_limit`, `webhook.inactive`, and `webhook.internal_error`; subject is the webhook trigger id. Trigger submission behavior and blank `sourceLabel` prompt semantics are unchanged.
- Added D1 migration `0144_project_event_source_outbox.sql` for producer-side source admission intents. The established task-terminal transition helper inserts `sam.lifecycle` terminal task source intents in the same D1 batch as the authoritative task/status/event transition, and trigger cleanup reconciles due intents with bounded rows, retry backoff, max attempts, expiry, stale processing leases, and final state visibility. Other lifecycle hook callers remain hook-bound best-effort source capture and are not claimed as blanket authoritative capture.
- Updated GitHub App manifest/setup generation and docs for Checks read, Actions read, Pull requests read, and subscriptions to `check_run`, `check_suite`, `workflow_run`, `pull_request_review`, and `pull_request_review_comment`.
- Local validation passed: `pnpm --filter @simple-agent-manager/shared build`; `pnpm --filter @simple-agent-manager/api typecheck`; `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/github-project-event-producer.test.ts tests/unit/services/project-event-source-outbox.test.ts tests/unit/services/task-terminal-transition.test.ts tests/unit/services/task-terminal-transition-hooks.test.ts tests/integration/webhook-trigger-ingress.test.ts tests/unit/services/trigger-execution-cleanup.test.ts` (76 tests); `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/github-project-events.test.ts` (8 tests); `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/trigger-execution-cleanup.test.ts` (17 tests); `pnpm --filter @simple-agent-manager/api lint`.
  Slice A local implementation evidence on `sam/implement-core-event-retention-cjketx`: core event retention and same-chat wake delivery were implemented in ProjectData event/prompt modules, stable subscription access, shared defaults/types, alarm scheduling, reconciliation/attention fences, and DO migration `045-project-event-wake-delivery`. No PR, merge, deployment, staging mutation, schedule implementation, standing-watch implementation, channel UI, or producer slice work was performed in this child slice. Validation commands run locally: `pnpm --filter @simple-agent-manager/shared typecheck` passed; `pnpm --filter @simple-agent-manager/shared build` passed; `pnpm --filter @simple-agent-manager/api typecheck` passed; `pnpm --filter @simple-agent-manager/api lint` passed; `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/durable-objects/reconciliation.test.ts tests/unit/durable-objects/attention-expiry.test.ts` passed 2 files / 79 tests; `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/project-data-events.test.ts` passed 1 file / 18 tests, including real workerd 97/98/99/100/500 bind-budget retention coverage. Local specialist review completed for Cloudflare DO/alarm/migration concerns, security wake fences, constitution/env/docs sync, and task completion against section A; no blocking findings remained after fixes.

## References

- `.claude/rules/31-migration-safety.md` and current migration safety rules
- `.claude/rules/09-task-tracking.md`, `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/35-vertical-slice-testing.md`
- Shared alarm/control-loop, callback identity, runtime parity and real-workerd-limit rules under `.claude/rules/`
- `apps/api/src/durable-objects/project-data/`, `apps/api/src/services/project-event-subscriptions-access.ts`, `apps/api/src/services/github-project-event-producer.ts`
- `packages/shared/src/types/project-events.ts`, `apps/api/src/routes/mcp/event-subscription-tools.ts`
