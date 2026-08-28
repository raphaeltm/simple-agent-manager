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

- [x] Add shared adapter-capability and resolver output contracts/types for event delivery decisions.
- [x] Implement a pure resolver that maps a subscription delivery preference plus explicit capabilities/authorization/target state to requested delivery, resolved delivery, adapter action, reason, and model-visible summary.
- [x] Integrate the resolver into ProjectData delivery-batch creation without adding runtime adapter I/O or producers.
- [x] Preserve requested/resolved delivery separation and reject/resolve ambiguous caller-provided delivery overrides.
- [x] Ensure Codex/OpenCode/Claude live paths require explicit advertised capabilities and are not inferred from `agentType`.
- [x] Ensure model-visible delivery summaries contain only bounded normalized display/identity data, never raw metadata or payload references.
- [x] Add resolver tests for supported, unsupported, unauthorized, terminal target, expired/cancelled subscription, ambiguous delivery, record-only, queue fallback, and spawn/interrupt authorization boundaries.
- [x] Run focused tests plus relevant typecheck/lint/format gates.
- [x] Run specialist review and document results.
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

## Implementation Notes

- Shared contracts now include delivery capability modes, adapter descriptors, authorization flags, target lifecycle state, adapter decision, resolver reason, resolution output, and model-visible summary types.
- Resolved delivery values now include future adapter-backed outcomes (`runtime_steer`, `runtime_interrupt`, `spawn_task`) in addition to the B1 durable baseline values.
- `resolveProjectEventDelivery()` is pure: it selects queue/runtime/spawn only from explicit advertised capabilities plus matching authorization; otherwise it terminalizes as unsupported, unauthorized, target-terminal, subscription-inactive, ambiguous, record-only, or recorded-not-injected.
- Codex and OpenCode decisions are not derived from `agentType`. Tests prove Codex ACP 1.1.2 with a failed version gate and OpenCode ACP with no advertised steer/queue capability remain unsupported.
- `createProjectEventDeliveryBatch()` persists `adapter_decision_json`, requested delivery, and resolved delivery. Pending queue/runtime/spawn decisions do not perform adapter I/O, do not call `acceptPromptDelivery()`, and do not write `session_inbox`.
- Model-visible summaries contain only event id/source/type/subject/severity/timestamps and bounded `display` data; metadata, delivery keys, fingerprints, and raw payload references are excluded.
- Review follow-up: ProjectData delivery-batch normalization now accepts adapter records with an empty capability list so unsupported integrations such as current OpenCode ACP can be represented without failing boundary validation. Adapter-delivery input normalization was split into `project-events-delivery-input-normalization.ts`, reducing `project-events-normalization.ts` from 783 to 587 lines.

## Specialist Review Evidence

| Skill | Verdict | Evidence |
| --- | --- | --- |
| task-completion-validator | PASS after fix | Research findings, checked implementation items, and acceptance criteria map to the B2 diff. One review gap was fixed: empty advertised capability arrays now pass ProjectData normalization and have a unit test. |
| test-engineer | PASS | Pure resolver matrix test covers supported, unsupported, unauthorized, terminal, inactive, ambiguous, record-only, queue fallback, spawn, interrupt, and model-summary safety. Worker slice covers persisted queue decisions and no `session_inbox` writes. |
| cloudflare-specialist | PASS | DO migration 038 schema and 039 compatibility ALTER are additive/non-destructive; ProjectData SQL remains bounded by normalized match IDs and existing limits. |
| constitution-validator | PASS | Scoped diff scan found no hardcoded URLs, timeouts, expiry values, operational limits, or deployment identifiers. New mode strings are protocol/contract constants. |
| security-auditor | PASS | Resolver is fail-closed by default, requires explicit authorization for queue/steer/interrupt/spawn, and model-visible summaries omit raw payload refs, metadata, fingerprints, and delivery keys. |
| doc-sync-validator | PASS | Architecture docs now describe adapter-capability resolution, separate requested/resolved/adapter-decision audit data, and intentionally deferred runtime injection/steering/spawn work. No env, route, or public API docs needed for this no-API/no-UI wave. |

## Validation Evidence

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/durable-objects/project-events-delivery-resolver.test.ts tests/unit/durable-objects/project-events-normalization.test.ts tests/unit/durable-objects/migrations.test.ts` — passed, 31 tests.
- `pnpm --filter @simple-agent-manager/shared typecheck` — passed.
- `pnpm --filter @simple-agent-manager/shared build` — passed; required before worker tests because `@simple-agent-manager/shared` resolves through `dist`.
- `pnpm vitest run --config vitest.workers.config.ts tests/workers/project-data-events.test.ts --reporter=verbose` from `apps/api` — passed, 9 tests.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed.
- `pnpm --filter @simple-agent-manager/api build` — passed.
- `pnpm --filter @simple-agent-manager/shared lint` — passed.
- `pnpm --filter @simple-agent-manager/www build` — passed.
- `pnpm format:check` — passed.
- `pnpm quality:do-migration-safety` — passed.
- `pnpm quality:migration-safety` — passed.
- `pnpm quality:type-boundaries` — passed; 0 blocking findings.
- `pnpm quality:file-sizes` — passed; no files exceed 800 lines.
- `git diff --check` — passed.
