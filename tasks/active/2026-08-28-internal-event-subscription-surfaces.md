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

- [ ] Add typed internal request/response contracts for creating, listing, getting, cancelling, and expiring ProjectData event subscriptions.
- [ ] Add an API service layer that derives project/owner/target identity from an agent or platform caller instead of trusting user-supplied project IDs.
- [ ] Enforce agent session scoping, invalid owner/target/project rejection, authorization placeholders/gates for platform-owned policy/standing-watch/system subscriptions, idempotency conflict surfacing, TTL bounds, and cancellation/expiry semantics.
- [ ] Add MCP tool definitions and handlers for task agents to create, list, get, and cancel their own ProjectData event subscriptions without exposing project or owner overrides.
- [ ] Keep expiry and platform-owned subscription controls internal-service only for this wave.
- [ ] Add focused tests covering agent-owned session subscriptions, policy/standing-watch ownership, required-subscription behavior, invalid owner/target/project access, and cancellation/expiry races.
- [ ] Run focused tests plus relevant typecheck/lint/format/static gates.
- [ ] Complete specialist reviews and task-completion validation before handoff.
- [ ] Push commits and open a draft PR targeting `sam/weve-previously-talked-eventing-y207hp`.

## Validation Plan

- Focused unit tests for typed service contracts and identity/authorization behavior.
- Focused MCP route/tool tests for the task-agent surface.
- Existing ProjectData event worker tests to verify the B1 durable layer remains intact.
- Shared/API typecheck, lint, formatting, and relevant static quality gates.
- No staging validation by explicit task instruction.

## Handoff Notes

- PR must remain draft and must not be merged.
- Handoff must list contracts exposed, tests run, commit IDs, PR URL, CI status if available, and deferred public/UI/runtime work.
