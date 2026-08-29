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

- [ ] Add append-only ProjectData DO migration for durable event-bus events, subscriptions, delivery policies, and deliveries.
- [ ] Add ProjectData event-bus module with stable event IDs, normalized metadata/payload handling, subscription visibility checks, cursor pagination, and idempotent acknowledgement.
- [ ] Add project-data service wrapper methods for event lookup, subscription delivery listing, and delivery acknowledgement.
- [ ] Add MCP tools:
  - [ ] `get_event`
  - [ ] `list_subscription_events`
  - [ ] `ack_event_delivery`
- [ ] Enforce current-project authorization at read/ack time using verified MCP identity and D1-backed project predicates where necessary.
- [ ] Return nondisclosing errors for nonexistent and unauthorized event/subscription/delivery cases.
- [ ] Keep list summaries payload-free; return full payload only from the single-event fetch path.
- [ ] Use environment-configurable bounded limits and opaque/stable cursors.
- [ ] Register tool definitions consistently in MCP `tools/list`.
- [ ] Update MCP API reference and environment/configuration docs.
- [ ] Add comprehensive tests for success, pagination, missed events, ownership/project boundaries, nonexistent-vs-unauthorized non-disclosure, malformed cursors/limits, idempotent ack, and ack-policy behavior.
- [ ] Run local validation and requested specialist reviews.
- [ ] Open a draft PR; do not deploy staging and do not merge.

## Acceptance criteria

- [ ] An authorized agent can fetch one visible event by stable event ID and receive normalized metadata plus full payload.
- [ ] An authorized agent can cursor-paginate deliveries visible through one authorized subscription and retrieve missed/queued events without payload leakage in summaries.
- [ ] Delivery acknowledgement is idempotent for ack-required deliveries and rejects deliveries whose policy does not require acknowledgement.
- [ ] Subscription/routing matching remains independent from delivery policy.
- [ ] Cross-project or ownership-boundary access is rejected at read/ack time without distinguishing unauthorized from nonexistent records.
- [ ] Cursors are opaque, stable, bound to the requested subscription, and rejected when malformed.
- [ ] Limits are bounded and configurable; hardcoded operational limits are avoided.
- [ ] MCP reference/docs and tool registration match implementation.
- [ ] Tests cover all requested scenarios and pass locally.

## Validation evidence

- `git diff --check`
- `pnpm quality:do-migration-safety`
- `pnpm quality:skill-references`
- `pnpm format:check`
- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/api lint`
- Focused unit/worker tests for event-bus data model and MCP handlers
- Additional repo quality gates as required by the touched surface

## Review plan

- `$api-reference` for MCP tool docs/registration consistency.
- `$cloudflare-specialist` for Durable Object migration/index/config safety.
- `$security-auditor` for authorization, non-disclosure, and sensitive payload handling.
- `$constitution-validator` for configurable limits and no hardcoded operational values.
- `$test-engineer` for scenario coverage and realistic route/data-model tests.
- `$doc-sync-validator` for documentation/code synchronization.
- `$task-completion-validator` before final handoff.
