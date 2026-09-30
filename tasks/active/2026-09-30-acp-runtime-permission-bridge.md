# ACP Runtime Permission Bridge

## Problem

The VM agent currently broadcasts raw ACP `permission/request` payloads to viewers and automatically selects the first option. This bypasses the durable Cloudflare interaction authority delivered by foundation PRs #2182 and #2187, leaks untrusted request content onto the viewer channel, and cannot safely handle reconnects, duplicate answers, cancellation, deadlines, or runtime loss.

Slice B connects ACP `RequestPermission` to the shipped Cloudflare create/answer/settle contracts. Cloudflare remains the sole request and answer authority. This task owns `packages/vm-agent` plus the narrow Worker start-contract and runtime fixture changes needed for that bridge; UI, forms, URL elicitation, auth flows, and token custody are out of scope.

## Authority and Constraints

- Canonical Idea `01M3P2E0JJNQRXX020P65ZRKEJ`, approved execution plan v2, supersedes historical review.
- SAM task `01M3RF53QVR8ZWK446ZSZAFWB6`; coordinator task `01M3REXNKF8VSKT3QY4P0JPAVM`.
- Required branch: `sam/execute-task-using-skill-zafwb6`.
- Keep `ACP_INTERACTIONS_ENABLED=false`; do not mark the PR ready, merge, deploy, activate production flags, or mutate shared staging.
- Do not edit `apps/web` or `packages/acp-client` and do not advertise form or URL capability.
- Final integrated staging is explicitly deferred to the coordinator; local and CI evidence remain required.

## Research Findings

- PRs #2182/#2187 are present on current `main` and provide the shared `acp-interactions.ts` envelope, encrypted `InteractionStore`, callback-JWT create/settle routes, browser answer route, no-wake Worker delivery service, capability probe, and dormant VM answer endpoint.
- `sessionHostClient.RequestPermission` in `packages/vm-agent/internal/acp/session_host_client.go` still broadcasts the raw request and selects `params.Options[0]`; both behaviors must be removed.
- `SessionHost` owns the ACP connection and survives browser disconnects. `attachACPConnection` runs for each new ACP connection, so it is the correct point to mint a fresh opaque UUID generation. A recreated `SessionHost` also reaches this path and therefore receives a distinct generation.
- The VM answer endpoint already uses node-management JWT auth bound to the route workspace and checks the server execution runtime identity. Its dormant `no_waiter` response must be replaced with a session-host registry lookup that also validates connection generation.
- Worker runtime create/settle routes are mounted before browser-authenticated project routes and verify workspace callback JWTs plus the current running agent-session row. The Go client must use the workspace callback token and those existing endpoints.
- `apps/api/src/services/node-agent.ts` is the single start-session choke point for VM and Instant paths. An additive per-session interaction config here covers both runtimes without adding a second launch path.
- The approved defaults are centralized in `packages/shared/src/acp-interactions.ts`. The Worker must serialize the relevant limits/deadline into the start contract so Go does not invent divergent production constants.
- Existing no-wake delivery already calls low-level `nodeAgentRequest` with `recoverContainerOnTimeout=false`; runtime answer handling must never invoke prompt delivery or recovery.
- Relevant retained incident: callback routes placed under browser session middleware silently return 401. Existing extracted ACP callback routes follow rule 34 and must remain there.

## Implementation Checklist

- [x] Add an additive versioned ACP interaction start contract derived from the centralized Worker config and task mode; missing/off/unsupported remains explicit fail-closed.
- [x] Store per-session permission bridge settings in the VM agent and mint a new UUID generation for every ACP connection attachment.
- [x] Add a bounded, concurrency-safe in-memory waiter and receipt registry keyed by interaction ID and bound to agent session, execution runtime identity, and connection generation.
- [x] Replace raw viewer broadcast and first-option fallback with validated permission detail creation, durable Worker create, wait for exact option ID, and explicit cancellation on every unsupported/error path.
- [x] Implement deadline and inbound context cancellation, connection replacement/process loss, and explicit `Stop` settlement without waking or recreating a runtime.
- [x] Deliver settle callbacks with bounded retry on an independent bounded context and structural logging only.
- [x] Complete the trusted answer endpoint with consumed/duplicate/conflict/stale-generation/no-waiter receipts and bounded tombstones.
- [x] Add deterministic real ACP fixture behavior with reversed safety options for the coordinator's final staged roundtrip.
- [x] Add contract and race tests for callback JWT workspace/session identity, recreated `SessionHost` generation, reversed options, duplicate/conflicting answer, process loss, explicit Stop, deadlines/cancellation, feature-off/unsupported behavior, and VM/Instant no-wake transport.
- [x] Update narrow API/runtime contract documentation and fixtures without claiming unproven form/URL capability.
- [x] Run package and repository validation, task-completion validation, and relevant Go, Cloudflare, security, constitution, test, and documentation reviews.
- [x] Open an implementation-ready draft PR and record exact branch/contracts/test/review evidence for the coordinator.

## Acceptance Criteria

- A permission request creates a durable Cloudflare interaction before waiting and returns only the exact answered option ID; option order never grants authority.
- Cloudflare is the only request/answer authority. No raw permission request is broadcast to browsers and no browser-to-VM response channel exists.
- Every ACP connection attachment has a fresh UUID generation, including after `SessionHost` recreation. Answers are bound to workspace, agent session, execution runtime, connection generation, and interaction ID.
- Duplicate delivery is idempotent, conflicting delivery is rejected, and bounded receipt eviction returns `no_waiter` without re-execution.
- Request cancellation, deadline, process loss, connection replacement, and explicit Stop resolve waiters once and settle the durable record honestly.
- Missing/off/version-skew/invalid/oversized/create-failed paths cancel explicitly and never choose an option.
- Answer delivery uses the existing no-wake Worker transport for both VM and Instant. A lost runtime is rejected and is never started, restored, or woken.
- Payloads contain only bounded permission detail needed by the creator UI; arbitrary tool arguments/content never enter logs, viewer frames, or plaintext durable storage.
- Global rollout remains disabled and forms/URLs are not advertised.
- Meaningful local tests and specialist reviews pass; the draft PR remains unmerged and undeployed for coordinator review and integrated staging.

## References

- `packages/shared/src/acp-interactions.ts`
- `apps/api/src/routes/projects/acp-interaction-callback.ts`
- `apps/api/src/services/acp-interaction-delivery.ts`
- `apps/api/src/services/node-agent.ts`
- `packages/vm-agent/internal/acp/session_host_client.go`
- `packages/vm-agent/internal/acp/session_host_startup.go`
- `packages/vm-agent/internal/server/workspaces.go`
- `specs/001-mvp/contracts/api.md`
- `.claude/rules/34-vm-agent-callback-auth.md`
- `packages/vm-agent/.claude/rules/54-vm-agent-rollout-compatibility.md`
- `packages/vm-agent/.claude/rules/71-request-context-must-not-outlive-its-request.md`

## Delivery

- Branch: `sam/execute-task-using-skill-zafwb6`
- Draft PR: `#2201`
- Final implementation commit: `ea3dbad82`
- Integrated staging: explicitly deferred to coordinator before readiness or merge
