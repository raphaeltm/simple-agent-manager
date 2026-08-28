# ProjectData event delivery resolver

## Task

Implement Wave B2 on branch `sam/wave-b2-implement-event-w512yj`: add a capability model and delivery resolver on top of the Wave B1 ProjectData event-subscription core, targeting integration branch `sam/weve-previously-talked-eventing-y207hp`.

## Source of Truth

- SAM task: `01M13YW9Y7XS8Y679P61W512YJ`
- Parent task: `01M13WFSD5VXMAHP5V39FEKFR3`
- Base branch: `sam/wave-b1-retry-implement-ft51wx` / PR #1954
- Integration target: `sam/weve-previously-talked-eventing-y207hp`

## Explicit Constraints

- Do not deploy to, mutate, or validate against staging.
- Open a draft PR against `sam/weve-previously-talked-eventing-y207hp`; do not merge.
- Do not implement runtime prompt injection, Claude/Codex/OpenCode adapter calls, producers, MCP/API tools, or UI.
- Preserve the Wave A separation between subscription/routing and delivery policy.
- Store requested and resolved delivery separately; do not infer live steering from `agentType` alone.
- Keep raw event payloads out of model-visible delivery summaries; use bounded normalized display data only.

## Research Findings

- Wave B1 already added ProjectData tables/RPCs for normalized events, subscriptions, matches, delivery batches, delivery attempts, recent status, retention, and accounting.
- `project_event_subscriptions` and `project_event_delivery_batches` already store `requested_delivery` and `resolved_delivery` separately.
- `createProjectEventDeliveryBatch()` currently defaults delivery batches to `recorded_not_injected`; Wave B2 needs a pure resolver contract that can decide `record_only`, durable queue, unsupported, unauthorized, and future adapter-backed decisions without performing runtime I/O.
- Current compatibility facts require capability gating: SAM pins `@agentclientprotocol/codex-acp@1.1.2` without advertised steering; `opencode acp` lacks steer/queue; Claude Channels are not a durable acked baseline; the portable baseline is durable queue, recorded-not-injected, and authorized spawn.
- B1 tests in `apps/api/tests/workers/project-data-events.test.ts` verify durable storage and zero `session_inbox` writes; B2 tests should keep that invariant while asserting resolver outputs.

## Implementation Checklist

- [ ] Add shared adapter-capability and resolver output contracts/types for event delivery decisions.
- [ ] Implement a pure resolver that maps a subscription delivery preference plus explicit capabilities/authorization/target state to requested delivery, resolved delivery, adapter action, reason, and model-visible summary.
- [ ] Integrate the resolver into ProjectData delivery-batch creation without adding runtime adapter I/O or producers.
- [ ] Preserve requested/resolved delivery separation and reject/resolve ambiguous caller-provided delivery overrides.
- [ ] Ensure Codex/OpenCode/Claude live paths require explicit advertised capabilities and are not inferred from `agentType`.
- [ ] Ensure model-visible delivery summaries contain only bounded normalized display/identity data, never raw metadata or payload references.
- [ ] Add resolver tests for supported, unsupported, unauthorized, terminal target, expired/cancelled subscription, ambiguous delivery, record-only, queue fallback, and spawn/interrupt authorization boundaries.
- [ ] Run focused tests plus relevant typecheck/lint/format gates.
- [ ] Run specialist review and document results.
- [ ] Open a draft PR targeting `sam/weve-previously-talked-eventing-y207hp`.

## Acceptance Criteria

- Resolver contracts are exported for future API/MCP/producer/runtime work.
- Delivery batches are created from the resolver decision and remain durable-only in this wave.
- Existing-session prompt and capability-gated live requests can resolve to the durable queue when allowed; unsupported/unauthorized/terminal/ambiguous cases are explicit and auditable.
- Record-only delivery stays record-only and requires no adapter.
- Spawn and interrupt decisions require explicit authorization flags.
- Tests prove no raw event metadata/raw payload reference is included in the model-visible summary.
- Staging is intentionally skipped by explicit instruction.

## Validation Plan

- Focused unit tests for the resolver matrix.
- Worker ProjectData tests for batch creation using resolver decisions and continued absence of `session_inbox` writes.
- Shared/API typecheck and lint/format checks proportional to touched packages.
- Specialist reviews: task-completion-validator, test-engineer, cloudflare-specialist, constitution-validator, and security-auditor if security-sensitive boundaries are affected.
