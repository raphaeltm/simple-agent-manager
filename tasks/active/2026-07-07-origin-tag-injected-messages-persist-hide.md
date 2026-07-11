# Origin-tag SAM-injected chat messages and hide them in the UI (persisted path)

**Idea:** `01KWYF4H28MM5T679P55BMZXMT`
**Depends on:** PR #1531 (merged; vm-agent inbound marker foundation).
**Scope:** Remaining end-to-end user-visible feature, including live and persisted paths.

## Goal

Make the `get_instructions` reminder (injected into the first task prompt) render **collapsed**
in the project chat, instead of as visible user-message noise. Deliver the reusable `origin`
pipeline end-to-end for live broadcasts and persisted history (vm-agent → DO/RPC → web).

## Design (marker → origin → DB → web)

- **Marker convention:** an ACP text prompt block is system-injected when
  `_meta["sam.origin"] == "system"`. Documented; env-overridable key not needed (constant string).
- **Producer (control plane, TS):** `buildTaskInitialPrompt` stops concatenating the
  `get_instructions` reminder into the visible prompt. The reminder is passed separately as
  `injectedInstructions` through `startAgentSessionOnNode` → vm-agent create-session HTTP body.
  (Attachment context + `systemPromptAppend` stay in the visible prompt for now — hiding those is
  a follow-up.)
- **vm-agent producer:** `startAgentWithPrompt(..., initialPrompt, injectedInstructions)` emits ACP
  blocks: `[visible text block, injected text block with _meta{sam.origin:system}]` when
  `injectedInstructions` is non-empty. Both go to the agent as model input; the injected one
  becomes a **separate** user message.
- **vm-agent consumer:** `ExtractMessages` reads the block `_meta["sam.origin"]` and sets
  `Origin` on the `ExtractedMessage` (user role only). `injectUserMessageNotifications` threads
  `Origin` into `MessageReportEntry`. Outbox schema + reporter payload gain `origin` (needs a
  vm-agent message-outbox migration — rule 44).
- **API + DO:** `MessageEntrySchema` gains optional `origin`; DO `BatchMessageInput` + INSERT +
  **additive** migration `ALTER TABLE chat_messages ADD COLUMN origin TEXT` (rule 31, no DROP);
  read path returns `origin`.
- **Live broadcast:** vm-agent adds `origin` to SAM-owned `session/update` params; acp-client maps it without relying on stripped ACP metadata.
- **Web (live + persisted):** `ChatMessageResponse` + `UserMessage` gain `origin?`;
  `chatMessagesToConversationItems` sets it; `AcpConversationItemView` renders an origin=system
  user message **collapsed with a chevron** (reuse a `<details>`-style disclosure).

## Recovered implementation

The failed predecessor left no PR, but `origin/sam/origin-tag-injected-messages` contained two unmerged implementation commits. This task recovered those commits onto current `main`, then extended them for the shared bootstrap refactor, live SAM-owned broadcasts, origin-aware dedup/search, update parity, accessibility, and current release gates.

## Implementation checklist

Producer (TS):

- [x] `buildTaskInitialPrompt` (`apps/api/.../task-runner/agent-session-step.ts`) returns the visible
      prompt without the reminder; expose the reminder separately (new return or config field).
- [x] `startAgentSessionOnNode` (`apps/api/src/services/node-agent.ts`) sends `injectedInstructions`.
- [x] vm-agent create-session body (`internal/server/workspaces.go`) accepts `injectedInstructions`.
- [x] `startAgentWithPrompt` emits the two-block prompt with the marker on the injected block.
- [x] Cross-boundary contract test (rule 23) for the new field.

vm-agent consumer:

- [x] `MessageReportEntry` (`internal/acp/gateway.go`) gains `Origin string`.
- [x] `ExtractMessages` (`internal/acp/message_extract.go`) reads `_meta["sam.origin"]`, sets Origin.
- [x] `injectUserMessageNotifications` threads Origin into the reporter enqueue.
- [x] message-outbox schema (`internal/messagereport/schema.go`) + migration: `origin` column.
- [x] reporter payload (`internal/messagereport/reporter.go`) includes `origin`.
- [x] Go tests: marker→Origin extraction; outbox persist/read of origin; contract test payload.

API + DO:

- [x] `MessageEntrySchema` (`apps/api/src/schemas/workspaces.ts`) `origin: optional(nullable string)`.
- [x] DO `BatchMessageInput` + INSERT (`durable-objects/project-data/messages.ts`,
      `message-persistence.ts`) write `origin`.
- [x] additive migration in `durable-objects/migrations.ts` (ADD COLUMN origin, default 'user').
- [x] read path returns `origin`; row parser includes it.
- [ ] Vitest (Miniflare) vertical-slice test: POST messages with origin=system → GET returns origin.

Web:

- [x] `ChatMessageResponse` (`apps/web/src/lib/api/sessions.ts`) + `UserMessage`
      (`packages/acp-client/.../useAcpMessages.types.ts`) gain `origin?: 'user'|'system'`.
- [x] `chatMessagesToConversationItems` sets origin.
- [x] `AcpConversationItemView` renders origin=system user message collapsed (chevron/disclosure).
- [x] Component test: origin=system renders collapsed; origin=user renders normally.
- [x] Playwright visual audit (mobile+desktop) for the collapsed state (rule 17).

Additional end-to-end slices:

- [x] Live `session/update` envelope carries origin and acp-client maps it immediately.
- [x] Origin survives duplicate/status-only retries and appears in batch broadcast payloads.
- [x] System-origin content bypasses user-content dedup and is excluded from LIKE/FTS search and topic/attention semantics.
- [x] Old messages without origin map to normal user messages.
- [x] Add/run Playwright audits at 375px and 1280px with long injected and mixed content.

## Acceptance criteria

- [x] A prompt block with `_meta.sam.origin=system` is persisted with `origin='system'` (Go + DO tests).
- [x] The persisted-message read path returns `origin` (Miniflare test).
- [x] The web collapses an origin=system user message and shows normal messages unchanged (component test).
- [x] Migration is additive (no DROP); `pnpm quality:migration-safety` passes.
- [x] Existing messages (no origin) default to 'user' and render normally (regression).

## Release constraints

- Coordinate staging as turn 3 of 5: priorities `01KX8ST0S21H18QGN2NV5PQ45W` and `01KX8SWC9DEMHCA8RSPZN5W1V1` must finish staging first, and Actions must be clear.
- Because vm-agent changes, provision a fresh staging VM, verify heartbeat/workspace/agent, then clean it up.
- Merge only after local reviews, CI, staging E2E, and required deployment monitoring pass. Complete the idea only after production shipment is verified.

## References

- Idea `01KWYF4H28MM5T679P55BMZXMT`; PR #1531
- Path map: vm-agent `gateway.go`/`message_extract.go`/`messagereport/*`; API `schemas/workspaces.ts`,
  `routes/workspaces/runtime.ts`, `durable-objects/project-data/messages.ts`, `migrations.ts`;
  web `lib/api/sessions.ts`, `project-message-view/types.ts`, `AcpConversationItemView.tsx`,
  acp-client `useAcpMessages.types.ts`
- Rules: 23 (contract), 31 (migration safety), 35 (vertical slice), 44 (dual-write/outbox), 17 (visual)
