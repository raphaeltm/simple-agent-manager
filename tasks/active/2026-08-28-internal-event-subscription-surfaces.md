# Internal ProjectData event subscription surfaces

## Task

Implement Wave B3 internal API/MCP-adjacent service surfaces on top of the Wave B1 ProjectData event-subscription core.

## Source of Truth

- SAM task: `01M13YWZSRSN66B9MH4N90VXWD`
- Parent task: `01M13WFSD5VXMAHP5V39FEKFR3`
- Base branch: `sam/wave-b1-retry-implement-ft51wx`
- Integration target: `sam/weve-previously-talked-eventing-y207hp`
- Output branch: `sam/wave-b3-add-internal-90vxwd`
- B1 PR reference: <https://github.com/raphaeltm/simple-agent-manager/pull/1954>

## Explicit Constraints

- Do not deploy to, mutate, or validate staging.
- Open a draft PR against `sam/weve-previously-talked-eventing-y207hp`; do not merge.
- Keep subscription creation/list/get/cancel/expire surfaces internal/platform-safe.
- Do not expose broad user-facing controls or unaudited external mutation paths.
- Do not implement event producers, GitHub/deployment integrations, UI inspector, staging behavior, actual runtime injection, or Claude/Codex/OpenCode fast paths.
- Coordinate conceptually with Wave B2, but do not depend on unmerged B2 code unless explicitly required.

## Research Findings

- B1 added durable ProjectData subscription RPCs and service wrappers in `apps/api/src/services/project-data.ts`; those wrappers inject `projectId` but intentionally do not validate caller identity, target ownership, or MCP/tool authorization.
- Subscription records and limits are defined in `packages/shared/src/types/project-events.ts` and `packages/shared/src/constants/project-events.ts`.
- ProjectData already enforces per-project binding, idempotency fingerprint conflicts, active caps, TTL expiry, cancellation terminalization, and filter normalization at the storage boundary.
- MCP tokens carry `projectId`, `userId`, `workspaceId`, `taskId`, optional `chatSessionId`, and optional `agentSessionId`; existing mailbox/wait tools validate these identities against D1 rows before ProjectData writes.
- Existing MCP routes expose task-agent-only tools through JSON-RPC `tools/call`; schemas are explicit and handlers must reject project/owner override attempts for internal safety.
- Wave A semantics require voluntary agent-owned short-lived subscriptions, separately-owned policy/standing-watch subscriptions, and separation between requested delivery policy and event matching/routing.
- Wave B2 currently has planning-only local branch content for delivery resolution; B3 should not import B2 abstractions or create conflicting resolver code.

## Implementation Checklist

- [x] Add typed internal request/response contracts for creating, listing, getting, cancelling, and expiring ProjectData event subscriptions.
- [x] Add an API service layer that derives project/owner/target identity from an agent or platform caller instead of trusting user-supplied project IDs.
- [x] Enforce agent session scoping, invalid owner/target/project rejection, authorization placeholders/gates for platform-owned policy/standing-watch/system subscriptions, idempotency conflict surfacing, TTL bounds, and cancellation/expiry semantics.
- [x] Add MCP tool definitions and handlers for task agents to create, list, get, and cancel their own ProjectData event subscriptions without exposing project or owner overrides.
- [x] Keep expiry and platform-owned subscription controls internal-service only for this wave.
- [x] Add focused tests covering agent-owned session subscriptions, policy/standing-watch ownership, required-subscription behavior, invalid owner/target/project access, and cancellation/expiry races.
- [x] Run focused tests plus relevant typecheck/lint/format/static gates.
- [x] Complete specialist reviews and task-completion validation before handoff.
- [ ] Push commits and open a draft PR targeting `sam/weve-previously-talked-eventing-y207hp`.

## Implementation Evidence

- Added shared internal contracts in `packages/shared/src/types/project-event-subscriptions.ts` and re-exported them from `packages/shared/src/types/index.ts`.
- Added `apps/api/src/services/project-event-subscriptions.ts` as the typed internal service facade over the B1 `project-data` RPC wrappers.
- Added `apps/api/src/services/project-event-subscriptions-access.ts` for caller-derived project binding, D1 task/workspace/agent-session validation, owner/target guards, platform permission placeholders, MCP-token TTL caps, and Wave A delivery semantics.
- Added MCP task-agent tools in `apps/api/src/routes/mcp/tool-definitions-event-subscription-tools.ts` and `apps/api/src/routes/mcp/event-subscription-tools.ts`, then registered them through `apps/api/src/routes/mcp/tool-definitions.ts` and `apps/api/src/routes/mcp/index.ts`.
- Updated API-reference skill notes for the new internal MCP surface.

## Validation Plan

- Focused unit tests for typed service contracts and identity/authorization behavior.
- Focused MCP route/tool tests for the task-agent surface.
- Existing ProjectData event worker tests to verify the B1 durable layer remains intact.
- Shared/API typecheck, lint, formatting, and relevant static quality gates.
- No staging validation by explicit task instruction.

## Validation Evidence

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/project-event-subscriptions.test.ts tests/unit/routes/mcp-event-subscription-tools.test.ts tests/unit/routes/mcp.test.ts` — passed, 3 files, 252 tests.
- `pnpm vitest run --config vitest.workers.config.ts tests/workers/project-data-events.test.ts --reporter=verbose` from `apps/api` — passed, 1 file, 8 tests.
- `pnpm --filter @simple-agent-manager/shared build && pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed.
- `pnpm --filter @simple-agent-manager/shared typecheck && pnpm --filter @simple-agent-manager/shared lint` — passed.
- `pnpm format:check` — passed.
- `pnpm quality:file-sizes && pnpm quality:type-boundaries && pnpm quality:source-contract-tests && pnpm quality:migration-safety && git diff --check` — passed.

## Specialist Review Results

- Security audit: PASS. MCP handlers reject `projectId`, `owner`, `ownerScope`, and `cancelledBy`; service validates task/workspace/agent-session D1 bindings before ProjectData mutation; agent read/cancel returns 404 for out-of-scope subscriptions.
- Cloudflare review: PASS. The change uses existing D1 and ProjectData Durable Object service boundaries, adds no migrations, no Wrangler changes, no KV/R2 changes, and no staging operations.
- Constitution Principle XI review: PASS. TTL behavior derives from existing configurable MCP token settings; no hardcoded internal URLs, deployment identifiers, or new unconfigurable limits were added.
- Documentation sync review: PASS. No public HTTP routes, env vars, or deployment docs changed; internal API-reference skill notes were updated for the new MCP tools.
- Test-engineer review: PASS. Tests exercise realistic D1 task/workspace/agent-session state, service-to-ProjectData boundary payloads, MCP handler contracts, error paths, idempotency conflicts, and cancellation/expiry races.

## Task Completion Validation Report

### Verdict: PASS

| Check | Status | Evidence |
| --- | --- | --- |
| A: Research → Checklist | PASS | Every research finding is represented in the implementation checklist. |
| B: Checklist → Diff | PASS | Checked items map to shared contracts, API service/access code, MCP tool wiring, tests, and reference notes. |
| C: Criteria → Tests | PASS | Focused service/MCP tests cover owner scopes, project/target binding, required semantics, idempotency, TTL, and cancel/expiry races. |
| D: UI → Backend | N/A | No UI work was in scope or changed. |
| E: Multi-resource selection | N/A | No provider/resource selection logic was introduced. |
| F: Vertical slice coverage | PASS | Service tests use realistic D1 boundary state and assert ProjectData boundary payloads; MCP tests assert handler request/response contracts. |

## Intentionally Deferred

- Event producers and GitHub/deployment integrations.
- Public auth/UI routes, broad user-facing subscription controls, and UI inspector.
- Staging deploys, staging validation, or staging mutation.
- Runtime injection, Claude/Codex/OpenCode fast paths, interrupt/steer/spawn behavior, and B2 delivery resolver integration.

## Handoff Notes

- PR must remain draft and must not be merged.
- Handoff must list contracts exposed, tests run, commit IDs, PR URL, CI status if available, and deferred public/UI/runtime work.
