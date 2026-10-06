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
- [x] Capture, inspect, and post desktop/mobile screenshots.
- [x] Run scoped lint, typecheck, tests, build, task completion validation, and specialist reviews.
- [x] Create a draft PR only. Do not mark ready, merge, deploy, mutate staging, or activate global flags.

### Parent review follow-up (PR #2200)

Preflight classification remains `cross-component-change`, `business-logic-change`,
`security-sensitive-change`, and `ui-change`, scoped to `apps/web`. The project-level
attention event already reaches `useSessionReducer`; the chat permission query needs an
explicit refresh signal from that state plus a slow, visibility-aware recovery cadence.
Choice acquisition needs a synchronous in-memory guard before Web Crypto yields. A
snapshot authorization failure must evict the rendered card immediately so its transient
detail component unmounts. The mobile jump control needs reserved clearance around exact
permission option hit targets, status copy, error states, and retry controls. No public API,
Worker, shared schema, VM, or documentation contract changes are required.

- [x] Refresh the permission snapshot when the active session attention marker changes.
- [x] Keep a bounded idle recovery poll while preserving the faster pending/delivery poll.
- [x] Prove empty → pending and a second post-settlement request without reconnect, focus, or remount, plus bounded request counts.
- [x] Clear rendered interactions and unmount cached transient detail on observed 401/403 authorization failure.
- [x] Acquire a synchronous option lock and answer key before hashing; re-check mount, identity, permission state, and deadline after hashing.
- [x] Surface digest failure safely and block concurrent option/retry submissions with deterministic deferred-digest tests.
- [x] Reserve mobile clearance between permission option hit targets and jump-to-latest; assert geometry at 320px, 375px, and desktop.
- [x] Extend jump-to-latest clearance to status copy and retry controls without forcing long retry labels into a narrow column.
- [x] Capture, inspect, and post updated Playwright screenshots.
- [x] Re-run focused checks, specialist review, and CI; preserve draft-only handoff.

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

---

_Reconciled 2026-10-05 (weekly queue reconciliation): draft PR #2200 was closed unmerged (2026-09-30T22:32Z). Its reviewed head `e13a166b5` shipped inside integration PR #2202 (`86e6c5b75`, merged 2026-09-30T16:16Z). That commit added `AcpPermissionCard.tsx`, `useAcpPermissionInteractions.ts` and `apps/web/src/lib/api/acp-interactions.ts`, and deleted `packages/acp-client/src/components/PermissionDialog.tsx`. First successful production deploy run 36744720219 (2026-09-30T16:30Z). Permission creation was enabled in production by deploy run 37137757826 (2026-10-03T16:41Z, #2217 release), and the `sam-api-prod` readback on 2026-10-05 shows `ACP_INTERACTIONS_ENABLED=true`. #2200's only later commit, `fca210a90`, is test-only, and main's audit spec has the retry-control clearance assertions (`apps/web/tests/playwright/acp-permission-chat-audit.spec.ts:524-548`). No boxes left unticked._
