# Project-scoped MCP event-bus retrieval tools

## Problem

Agents can sleep or be restarted while SAM continues to produce project-scoped events. Today the repository has durable primitives that look adjacent — `activity_events`, `session_inbox`, durable prompt delivery, and task-wait subscriptions — but no general project-scoped MCP tools for retrieving authorized durable event-bus data by stable event ID, cursor-paginating missed subscription deliveries, or idempotently acknowledging event deliveries.

This task adds the MCP-facing read/ack layer without deploying or mutating staging. The parent coordinator owns staging verification after the final candidate.

## Research findings

- MCP registration is centralized in `apps/api/src/routes/mcp/index.ts`, with tool schemas composed through `apps/api/src/routes/mcp/tool-definitions*.ts`.
- Verified MCP identity is represented by `McpTokenData` in `apps/api/src/services/mcp-token.ts`; read/ack authorization must use the token project plus task/session/agent identity at request time.
- Per-project durable state lives in `ProjectData` Durable Object SQLite. Additive migrations are appended in `apps/api/src/durable-objects/migrations.ts`.
- Existing `activity_events` rows are useful UI/activity history, but they are not a durable subscription delivery queue and may be subject to ProjectData retention/cleanup paths.
- Existing `session_inbox` and `prompt_delivery_checkpoints` implement targeted durable prompt/message delivery. Their delivery-state concepts are useful, but they should not be overloaded into a general event subscription model.
- Existing `task_wait_subscriptions` implement parent wake semantics for subtasks. They are subscription-like but scoped to task completion waits, not general event routing.
- Existing `ProjectData.broadcastEvent()` sends compact WebSocket envelopes such as `activity.new` with an ID reference. That is the correct seam for live notifications if event-bus events are later wired into real-time delivery.
- Parent task direction requires keeping subscription/routing semantics independent from delivery policy, so the data model must not encode acknowledgement requirements as subscription matching rules.
- User explicitly forbids staging deployment/mutation and merge. Work stops at a draft PR after local validation and specialist reviews.

## Implementation checklist

- [x] Add append-only ProjectData DO migration for durable event-bus events, subscriptions, delivery policies, and deliveries.
- [x] Add ProjectData event-bus module with stable event IDs, normalized metadata/payload handling, subscription visibility checks, cursor pagination, and idempotent acknowledgement.
- [x] Add project-data service wrapper methods for event lookup, subscription delivery listing, and delivery acknowledgement.
- [x] Add MCP tools:
  - [x] `get_event`
  - [x] `list_subscription_events`
  - [x] `ack_event_delivery`
- [x] Enforce current-project authorization at read/ack time using verified MCP identity and D1-backed project predicates where necessary.
- [x] Return nondisclosing errors for nonexistent and unauthorized event/subscription/delivery cases.
- [x] Keep list summaries payload-free; return full payload only from the single-event fetch path.
- [x] Use environment-configurable bounded limits and opaque/stable cursors.
- [x] Bound persisted event metadata/payload bytes and include event-bus bytes in ProjectData storage telemetry.
- [x] Use delivery-sequence pagination indexes, indexed routing/retention paths, and bounded retention for old events without pending ack-required deliveries.
- [x] Register tool definitions consistently in MCP `tools/list`.
- [x] Update MCP API reference and environment/configuration docs.
- [x] Add comprehensive tests for success, pagination, missed events, ownership/project boundaries, nonexistent-vs-unauthorized non-disclosure, malformed cursors/limits, idempotent ack, and ack-policy behavior.
- [x] Run local validation and requested specialist reviews.
- [ ] Open a draft PR; do not deploy staging and do not merge.

## Acceptance criteria

- [x] An authorized agent can fetch one visible event by stable event ID and receive normalized metadata plus full payload.
- [x] An authorized agent can cursor-paginate deliveries visible through one authorized subscription and retrieve missed/queued events without payload leakage in summaries.
- [x] Delivery acknowledgement is idempotent for ack-required deliveries and rejects deliveries whose policy does not require acknowledgement.
- [x] Subscription/routing matching remains independent from delivery policy.
- [x] Cross-project or ownership-boundary access is rejected at read/ack time without distinguishing unauthorized from nonexistent records.
- [x] Cursors are opaque, stable, bound to the requested subscription, and rejected when malformed.
- [x] Limits are bounded and configurable; hardcoded operational limits are avoided.
- [x] Read/ack authorization requires the subscription to remain active and unexpired.
- [x] MCP reference/docs and tool registration match implementation.
- [x] Tests cover all requested scenarios and pass locally.

## Validation evidence

- `git diff --check`
- `pnpm quality:do-migration-safety`
- `pnpm quality:skill-references`
- `pnpm format:check`
- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/api lint`
- Focused unit/worker tests for event-bus data model and MCP handlers
- Additional repo quality gates as required by the touched surface

Current evidence:

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/event-bus.test.ts tests/unit/routes/mcp-event-bus-tools.test.ts` — 27 tests passed
- `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/event-bus-do.test.ts` — 5 workers-pool tests passed, including real `/mcp` vertical coverage and post-ack retention alarm scheduling
- `pnpm --filter @simple-agent-manager/api typecheck` — passed
- `pnpm --filter @simple-agent-manager/api lint` — passed
- `pnpm --filter @simple-agent-manager/shared typecheck` — passed
- `pnpm --filter @simple-agent-manager/shared build` — passed
- `pnpm --filter @simple-agent-manager/www typecheck` — passed with existing baseline Astro template findings only
- `pnpm format:check` — passed
- `pnpm quality:do-migration-safety` — passed
- `pnpm quality:file-sizes` — passed
- `pnpm quality:skill-references` — passed
- `pnpm quality:type-boundaries` — passed
- `pnpm quality:source-contract-tests` — passed
- `pnpm quality:wrangler-bindings` — passed
- `git diff --check` — passed

## Review findings and disposition

- `$api-reference`: PASS after addressing fractional limits and narrower identity-field rejection with integer-only limit handling, server-side unexpected-parameter rejection, snake_case identity-field rejection, and tests.
- `$cloudflare-specialist`: PASS after addressing payload/list bounds, indexed delivery pagination, indexed routing and retention plans, bulk delivered marking, redundant index removal, retention alarm recalculation after ack, and storage telemetry accounting.
- `$security-auditor`: PASS after addressing closed/expired subscription authorization and cursor validation with active/unexpired read/ack predicates plus route/DO cursor length, alphabet, and structural validation that maps to `Invalid cursor`.
- `$doc-sync-validator`: PASS after documenting ack terminal-state behavior, ProjectData event-bus table inventory, durable event-bus storage summaries, and `MCP_EVENT_BUS_CURSOR_MAX_LENGTH`.
- `$constitution-validator`: PASS after making `MCP_EVENT_BUS_CURSOR_MAX_LENGTH` configurable and documenting it alongside the other event-bus bounds.
- `$test-engineer`: PASS after adding workers-pool `/mcp` tests, real D1 project-boundary cases, handler/DO cursor tests, terminal ack-state unit/handler tests, indexed SQL plan tests, and post-ack retention alarm coverage.

## Review plan

- `$api-reference` for MCP tool docs/registration consistency.
- `$cloudflare-specialist` for Durable Object migration/index/config safety.
- `$security-auditor` for authorization, non-disclosure, and sensitive payload handling.
- `$constitution-validator` for configurable limits and no hardcoded operational values.
- `$test-engineer` for scenario coverage and realistic route/data-model tests.
- `$doc-sync-validator` for documentation/code synchronization.
- `$task-completion-validator` before final handoff.
