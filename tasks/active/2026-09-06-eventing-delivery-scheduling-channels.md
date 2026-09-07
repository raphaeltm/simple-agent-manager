# Durable event delivery, one-off schedules, and project channels

## Request and delivery constraints

Implement the eventing expansion in one green PR. Keep the PR open; do not merge. The integration branch is `sam/look-eventing-system-weve-rrszn5`. Child implementation branches feed this branch and must not open separate PRs or mutate staging. The coordinator owns integration, final review, one consolidated staging window, and CI. Technical implementation records belong here; private research stays in the SAM library.

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

| Slice | Owner boundary | Dependencies |
| --- | --- | --- |
| A: Core delivery and retention | ProjectData event/prompt modules, stable access, alarm/liveness integration; owns DO migrations during first wave | Existing baseline |
| B: CI/review/webhook producers and source recovery | GitHub producers, authenticated webhook route, lifecycle emission reliability and D1 outbox if needed | Existing event-admission API |
| C: Credential-limit events | Actual credential identity propagation, authenticated usage/limit callbacks, bounded threshold state and event producer | Existing event-admission API |
| D: One-off schedules and standing watches | Persisted intent, due processing, normal task submission adapter, public API/MCP controls | A integrated; share A mailbox/finalizer and B source boundary |
| E: Agent channels and project/session UI | Publishing/catalog/history/catch-up; member controls for subscriptions, watches and schedules, filter/delivery explanations | A and D contracts integrated; B/C event families available |

A owns append-only DO migration IDs in wave one. B reserves D1 migration 0144 if necessary; C reserves 0145 if necessary. Later slices append after integration. Each slice may update required shared types, constants, Env and docs with narrowly scoped changes; the coordinator resolves overlapping imports and barrels. No speculative shared abstractions or duplicated placement/task-submission logic.

## Implementation checklist

### A. Bounded retention and durable same-chat event delivery

- [ ] Chunk every variable SQL statement by its own remaining bind budget; verify 97/98/99/100/500 boundaries in real workerd.
- [ ] Replace retention hot-path aggregates with bounded incremental accounting and indexed candidates; use one overall mutation budget, dependency-safe cleanup, monotonic missing-batch repair, and exact eligible-work `hasMore` semantics. Daily maintenance by default; any bounded continuation must not become an unbounded hot loop.
- [ ] Clamp admission control timestamps to one captured server time; preserve source occurrence time only as evidence. Add additive migrations/indexes and verify both fresh and upgrade paths.
- [ ] Add independent materialization and retention candidates to the shared alarm scheduler with persisted retry checkpoints, bounded backoff, failure isolation and outer-finally re-arming. No network work in local materialization transactions.
- [ ] Introduce versioned stable `(projectId, chatSessionId)` ownership with task/runtime provenance and lineage guards; preserve bounded legacy pull compatibility without making legacy subscriptions wake-capable.
- [ ] Make finite self-chat `existing_session_prompt` subscriptions operational and return truthful checkpoint/end-turn instructions. No-match expiry is silent; it does not keep compute awake.
- [ ] Extract transaction-internal prompt acceptance and shared post-commit finalization. Preserve transcript-inserted gating for idle cleanup, human attention, workspace activity, summary and `message.new`; retain unconditional `mailbox.enqueued`; recalculate alarms in `finally`; no hooks on rollback.
- [ ] Atomically claim matches, create a ULID batch, accept inbox/transcript, and account for capacity. Share the claim primitive with pull; typed capacity deferral rolls back without failure backoff.
- [ ] Project mailbox state monotonically into batch/attempt state using additive transport columns and internal checkpoint upserts. Keep public append-only attempt fingerprints compatible; distinguish synthetic attempt zero from physical attempt limits.
- [ ] Define pull-versus-wake behavior for queued, delivering, delivered, ambiguous and acknowledged states. Revoke a queued prompt atomically when pulled; never blindly replay ambiguous receipt to another runtime.
- [ ] Preserve read/ack grace for accepted batches after natural subscription expiry. Cancellation, terminalization, authorization loss, target changes and kill-switch changes prevent physical side effects; recheck before recovery and physical submission.
- [ ] Enforce real mailbox/storage caps, batch limits, one in-flight wake per target, per-target/subscription cooldown and lifetime limits.
- [ ] Keep finite event leases out of sleep/idleness predicates; use them to prevent reconciliation check-ins and false terminalization while durably waiting.
- [ ] Wake messages contain only fixed platform wording and IDs. Event reads fence external content as untrusted evidence; do not log event-controlled strings as operational messages.

### B. Source reliability and CI/review/webhook events

- [ ] Persist wake-critical lifecycle emission intent alongside the authoritative transition or implement bounded authoritative reconciliation; retry failed admission with stable delivery identity. Verify a failed first admission eventually yields one event. Do not claim blanket source-capture guarantees.
- [ ] Add `check_run`, `check_suite`, `workflow_run`, `pull_request_review`, and `pull_request_review_comment` adapters with repository/PR/commit/run correlation and deterministic delivery keys. Older commit results must be distinguishable from the current push.
- [ ] Update GitHub App event subscription/permission setup and upgrade guidance, plus schemas/filters/tool contracts where relevant. Preserve existing trigger behavior and blank source labels.
- [ ] Forward authenticated generic webhook facts into canonical project event admission with deduplication, bounded payloads, provenance and truthful failure/filtered outcomes.

### C. Credential-limit awareness

- [ ] Trace credential selection through VM and container/harness/proxy boundaries. Attach limit observations to the credential/account actually used, never merely a provider/profile label or caller-supplied credential ID.
- [ ] Implement a real authenticated telemetry-to-event path using supported provider/harness limit evidence. Include window, reset, source, observation time and freshness; unsupported telemetry is explicitly unknown.
- [ ] Emit warning/critical/rejected/reset transitions with stable identity and duplicate suppression. Keep raw per-token/sampling streams outside ProjectData event storage; bound state retention and retries.
- [ ] Restrict visibility to affected authorized projects/sessions, redact secrets, and test identity forgery, project isolation, stale/out-of-order samples and repeated threshold crossings.

### D. One-off schedules and standing watches

- [ ] Persist schedule intent with stable ID, creator project/chat/user, due UTC time and display timezone, explicit `message_session` or `start_session` action, bounded payload, profile/skill identity, version, idempotency key, late/expiry policy and resulting event/delivery/task IDs.
- [ ] Provide create/list/get/reschedule/cancel through authorized APIs and MCP. Reschedule/cancel use versioned compare-and-set; after action admission, report that cancelling the schedule does not retract already-started work.
- [ ] Index pending due times and register the next due alarm in the existing shared scheduler; bound each pass, recover after exhausted automatic retries, and measure due-to-admission delay.
- [ ] Existing-session action atomically admits the event and durable message via A's mailbox boundary. Allow authorized same-project targets; busy targets queue safely, sleeping targets restore the same chat, invalid/archived/cancelled/unrestorable targets fail visibly without silently creating a different chat.
- [ ] New-session action reserves a stable task ID and durable submission intent before crossing from ProjectData to D1/task submission. Use the centralized profile/runtime/credential/placement resolver and reconcile crash-after-submit retries without duplicate tasks.
- [ ] Schedules survive creator token expiry and hold no compute. Revalidate authority and profile availability at fire time; never save bearer tokens. A new-session schedule survives creator-chat archive unless cancelled.
- [ ] Apply bounded late-run grace, delivery TTL measured from due/admission, finite capacity deferral and explicit expired/failed/ambiguous outcomes. Never promise exact-second model execution or exactly-once agent side effects.
- [ ] Add project-owned standing watches with visible creator, predicate, target/action, profile, cost/concurrency/cooldown controls, pause/revoke and resulting task lineage. Reuse canonical matching and normal task submission; agents cannot self-grant policy-owned authority.

### E. Agent channels and user controls

- [ ] Add bounded agent publishing with server-derived actor identity, a reserved agent namespace, idempotency, payload/rate/fanout limits and project isolation.
- [ ] Maintain channel catalog summaries incrementally and expose bounded history. Implement an atomic cursor/history-to-subscription handoff that cannot lose events in the gap or double-deliver already-consumed history.
- [ ] Add ordinary-member project and contextual session surfaces for subscriptions, scheduled actions and standing watches. Show creator/reason, target, due/expiry, requested versus actual delivery, status/reason and revoke/cancel controls.
- [ ] Provide Schedule once forms for both actions, real API wiring, list/inspect/reschedule/cancel and clear late/busy/failed outcomes. Explain filtered trigger deliveries using existing audit evidence.
- [ ] Keep controls project-scoped; follow shared UI patterns, mobile accessibility and existing authorization. Do not ship fixture-only routes.
- [ ] Capture and inspect desktop/mobile Playwright screenshots of every changed surface, with long text, many items, empty and error states; prove viewport bounds and scroll behavior with assertions.

### Integration and release evidence

- [ ] Update canonical public docs, API contracts, reference skills, configuration documentation and changelog as applicable; distinguish implemented delivery from requested capabilities.
- [ ] Run meaningful race/vertical-slice tests with real workerd limits, provider-boundary tests and existing event/mailbox/task-wait/sleep/archive regressions; Go checks when touched.
- [ ] Run full lint, typecheck, tests and build, plus relevant migration/config/security/quality gates.
- [ ] Complete independent local specialist review: task-completion, Cloudflare, security, test-engineer, constitution/env/docs, UI/UX, and Go if touched. Fix correctness findings before staging.
- [ ] Coordinate one consolidated staging window on the final candidate. Prove two same-chat sleep/recovery cycles, scheduled message to sleeping chat, new task-backed scheduled session with creator offline, cancellation/duplicate/deferred/error behavior, CI/review/channel/credential producer paths, and VM/container compatibility claims.
- [ ] Collect truthful latency/outcome/cost/storage evidence, inspect deployed configuration, and clean only this workflow's staging resources immediately (zero VMs at rest).
- [ ] Open one PR, attach reviewed UI screenshots and specialist/staging evidence, make required checks green, trigger CodeRabbit using its label and address any feedback. Leave open without merging.

## Acceptance criteria

Every checked item above must have implementation and test/manual evidence. The end-to-end canaries must demonstrate real delivery and task creation, not only stored timestamps. Retry after admission and before result recording must preserve stable identities. Cross-project/forged identity, cancelled or stale authority, and ambiguous receipt must fail safely and visibly. A subscribed or scheduled agent must release compute while waiting. Retention must remain bounded on production-shaped data and must not starve unrelated alarm branches.

## Explicitly outside this implementation

The source report deferred broad email integration, arbitrary workflow DAG editing, fuzzy LLM filters, harness-specific interruption/steering, event-or-deadline convenience racing, and cross-account workload routing. These are not prerequisites for the portable delivery and scheduling contract. Credential-limit events do not require the full project token-analytics product.

## Validation record

Pending implementation. Baseline lint/typecheck running; no feature verification claimed.

## References

- `.claude/rules/31-migration-safety.md` and current migration safety rules
- `.claude/rules/09-task-tracking.md`, `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/35-vertical-slice-testing.md`
- Shared alarm/control-loop, callback identity, runtime parity and real-workerd-limit rules under `.claude/rules/`
- `apps/api/src/durable-objects/project-data/`, `apps/api/src/services/project-event-subscriptions-access.ts`, `apps/api/src/services/github-project-event-producer.ts`
- `packages/shared/src/types/project-events.ts`, `apps/api/src/routes/mcp/event-subscription-tools.ts`
