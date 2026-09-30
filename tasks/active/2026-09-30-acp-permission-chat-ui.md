# ACP permission cards in real chat

## Problem

The durable ACP interaction foundation is live, but project chat does not read or answer its permission requests. Users cannot see a permission next to the tool call that caused it, recover after a refresh, or distinguish an accepted answer from its runtime delivery outcome. The old `packages/acp-client` permission dialog is unused and implements a second, unsafe callback contract.

This task implements slice B's web-owned surface only. Runtime bridge task `01M3RF53QVR8ZWK446ZSZAFWB6` owns VM/runtime emission and delivery. This branch must not edit VM code, Worker routes, or shared schemas.

## Approved source and current-main contracts

- Approved v2 section of SAM idea `01M3P2E0JJNQRXX020P65ZRKEJ`, especially H6/H7, M11/M12, M15, L20-L22.
- Merged foundation PRs #2182 and #2187.
- Snapshot: `GET /api/projects/:projectId/sessions/:sessionId/interactions`.
- Creator detail: `GET /api/projects/:projectId/sessions/:sessionId/interactions/:interactionId`, `Cache-Control: private, no-store`.
- Creator answer: `POST /api/projects/:projectId/sessions/:sessionId/interactions/:interactionId/answer` with `AcpInteractionBrowserAnswer`.
- Snapshot state values: pending, answered, delivery_confirmed, delivery_unconfirmed, interrupted, expired, cancelled.
- Main intentionally types decrypted `detail` as `Record<string, unknown>`. This slice parses only exact option objects accepted by `AcpInteractionOptionSchema`, optional `title`/`description`, and the foundation fixture's `permissionName` label. Malformed detail is never converted into an inferred choice.
- The browser hashes the exact selected option ID into `answerHash`; the runtime task must consume `optionId` as authority and treat the hash as an integrity/idempotency field, not another choice channel.

## UI variants considered

1. Add a separate permission row immediately after the matching tool row; append unmatched requests at the live tail. This preserves tool cards and works for requests without `toolCallId`.
2. Render the permission controls inside `ToolCallCard`. This is visually tight, but couples durable interaction state to lazy tool-card expansion and hides prompts inside collapsed groups.
3. Put all requests in a composer dock. This is simple, but loses the tool-call anchor and makes settled history hard to understand.

Selected: variant 1. The permission stays visible even when a tool group is collapsed, remains part of chat history, and unmatched requests still have a deterministic place.

## Implementation checklist

- [x] Add typed web API functions for snapshot, no-store transient detail, and Cloudflare answer mutation.
- [x] Add a TanStack snapshot hook with refresh/reconnect behavior and no persistent sensitive detail cache.
- [x] Parse permission detail defensively and render exact option IDs/names with no preselection or positional inference.
- [x] Insert permission rows after matching tool calls/groups and append requests without a matching `toolCallId`.
- [x] Render owner actions and noncreator generic waiting states without leaking detail.
- [x] Render pending, answered, delivery-confirmed, delivery-unconfirmed, expired, cancelled, and interrupted states.
- [x] Support two-tab conflicts, lost-receipt retry with the same answer key, access revocation, deadline expiry, and detail-fetch retry.
- [x] Preserve existing `needs_input` attention indicators and history.
- [x] Remove the orphan `PermissionDialog` export and component from `packages/acp-client`.
- [x] Add focused unit/integration coverage using production chat components and mocked production API routes.
- [x] Add a Playwright stress fixture for desktop/mobile with long text, 30+ interactions, special characters, owner/nonowner states, and overflow assertions.
- [ ] Capture, inspect, and post desktop/mobile screenshots.
- [ ] Run scoped lint, typecheck, tests, build, task completion validation, and specialist reviews.
- [ ] Create a draft PR only. Do not mark ready, merge, deploy, mutate staging, or activate global flags.

## Acceptance criteria

- A permission with a known `toolCallId` is rendered directly after the matching tool activity row; a request with no/missing tool anchor still renders.
- Option buttons preserve backend order only as display data and submit the clicked exact ID; none is selected by default.
- Only the session creator fetches decrypted details or can answer. Other members see generic pending copy and no settled history/detail.
- Sensitive detail lives only in component memory, uses a no-store request, clears on identity/session/terminal changes, and never enters TanStack/persistent browser query data.
- Refresh/reconnect reconstructs state from Cloudflare. Answer delivery states are distinct and honest.
- A lost POST response offers retry with the same answer key; a second-tab conflict refreshes canonical state.
- The browser sends answers only to the Cloudflare answer endpoint.
- Desktop/mobile Playwright evidence uses real project-chat components and passes clipped-overflow checks.

## Constraints

- Draft PR and handoff only; coordinator owns integrated staging and activation.
- No VM, Worker route, shared schema, auth/token custody, form, or URL elicitation changes.
- Do not advertise forms or URL requests.
