# Origin-tag SAM-injected chat messages and hide them in the UI (persisted path)

**Idea:** `01KWYF4H28MM5T679P55BMZXMT`
**Depends on:** PR #1531 (vm-agent `parsePromptBlocks` preserves inbound `_meta`) — this branch stacks on it.
**Slice:** 2 of N — the "consumer/producer" half.

## Goal

Make the `get_instructions` reminder (injected into the first task prompt) render **collapsed**
in the project chat, instead of as visible user-message noise. Deliver the reusable `origin`
pipeline end-to-end for the **persisted** message path (DB → API → web).

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
- **Web (persisted):** `ChatMessageResponse` + `UserMessage` gain `origin?`;
  `chatMessagesToConversationItems` sets it; `AcpConversationItemView` renders an origin=system
  user message **collapsed with a chevron** (reuse a `<details>`-style disclosure).

## Explicitly OUT of scope (documented follow-ups)

1. **Live-session hiding.** The SDK's `ContentBlock.MarshalJSON` strips `_meta` from the live
   mirror broadcast (PR #1531 finding), so the live ACP `user_message` update cannot carry
   `origin`. Live hiding needs a SAM-owned broadcast field + acp-client parsing — separate slice.
   Until then, an injected message may flash live and collapse on reload. Acceptable + documented.
2. Hiding attachment-context / `systemPromptAppend` (keep visible for now).
3. Excluding origin=system content from FTS/dedup tuning beyond the basic column.

## Implementation checklist

Producer (TS):
- [ ] `buildTaskInitialPrompt` (`apps/api/.../task-runner/agent-session-step.ts`) returns the visible
      prompt without the reminder; expose the reminder separately (new return or config field).
- [ ] `startAgentSessionOnNode` (`apps/api/src/services/node-agent.ts`) sends `injectedInstructions`.
- [ ] vm-agent create-session body (`internal/server/workspaces.go`) accepts `injectedInstructions`.
- [ ] `startAgentWithPrompt` emits the two-block prompt with the marker on the injected block.
- [ ] Cross-boundary contract test (rule 23) for the new field.

vm-agent consumer:
- [ ] `MessageReportEntry` (`internal/acp/gateway.go`) gains `Origin string`.
- [ ] `ExtractMessages` (`internal/acp/message_extract.go`) reads `_meta["sam.origin"]`, sets Origin.
- [ ] `injectUserMessageNotifications` threads Origin into the reporter enqueue.
- [ ] message-outbox schema (`internal/messagereport/schema.go`) + migration: `origin` column.
- [ ] reporter payload (`internal/messagereport/reporter.go`) includes `origin`.
- [ ] Go tests: marker→Origin extraction; outbox persist/read of origin; contract test payload.

API + DO:
- [ ] `MessageEntrySchema` (`apps/api/src/schemas/workspaces.ts`) `origin: optional(nullable string)`.
- [ ] DO `BatchMessageInput` + INSERT (`durable-objects/project-data/messages.ts`,
      `message-persistence.ts`) write `origin`.
- [ ] additive migration in `durable-objects/migrations.ts` (ADD COLUMN origin, default 'user').
- [ ] read path returns `origin`; row parser includes it.
- [ ] Vitest (Miniflare) vertical-slice test: POST messages with origin=system → GET returns origin.

Web:
- [ ] `ChatMessageResponse` (`apps/web/src/lib/api/sessions.ts`) + `UserMessage`
      (`packages/acp-client/.../useAcpMessages.types.ts`) gain `origin?: 'user'|'system'`.
- [ ] `chatMessagesToConversationItems` sets origin.
- [ ] `AcpConversationItemView` renders origin=system user message collapsed (chevron/disclosure).
- [ ] Component test: origin=system renders collapsed; origin=user renders normally.
- [ ] Playwright visual audit (mobile+desktop) for the collapsed state (rule 17).

## Acceptance criteria

- [ ] A prompt block with `_meta.sam.origin=system` is persisted with `origin='system'` (Go + DO tests).
- [ ] The persisted-message read path returns `origin` (Miniflare test).
- [ ] The web collapses an origin=system user message and shows normal messages unchanged (component test).
- [ ] Migration is additive (no DROP); `pnpm quality:migration-safety` passes.
- [ ] Existing messages (no origin) default to 'user' and render normally (regression).

## Constraints

- **Staging deployment + merge SKIPPED** per user instruction. This touches `packages/vm-agent/` +
  a DO migration; normally requires infra + staging verification (rules 13/22/27/31). Because both
  are skipped, PR is `needs-human-review`, MUST NOT self-merge. Final E2E (real workspace: injected
  message hidden on reload) is deferred to human staging verification.
- Branch stacks on `sam/important-before-starting-any-01kwy7` (PR #1531).

## References

- Idea `01KWYF4H28MM5T679P55BMZXMT`; PR #1531
- Path map: vm-agent `gateway.go`/`message_extract.go`/`messagereport/*`; API `schemas/workspaces.ts`,
  `routes/workspaces/runtime.ts`, `durable-objects/project-data/messages.ts`, `migrations.ts`;
  web `lib/api/sessions.ts`, `project-message-view/types.ts`, `AcpConversationItemView.tsx`,
  acp-client `useAcpMessages.types.ts`
- Rules: 23 (contract), 31 (migration safety), 35 (vertical slice), 44 (dual-write/outbox), 17 (visual)

## Implementation status (2026-07-07)

All layers implemented + committed. Local validation:
- Go (vm-agent): build, `go vet`, `go test ./internal/acp ./internal/messagereport` GREEN; new tests
  (marker extraction, outbox persist/forward+omitempty, migration idempotency). gofmt clean on all
  touched files. `internal/server` has one FAIL that is ENVIRONMENTAL ONLY (`docker` not in sandbox
  PATH — `TestBootstrapLifecycle_SessionsUseDetectedUser`), unrelated to this change.
- API: `pnpm --filter api typecheck` GREEN; task-runner prompt/agent-session unit tests updated + GREEN;
  `pnpm quality:migration-safety` + `quality:do-migration-safety` GREEN (additive column, no DROP).
- Web: `pnpm --filter web typecheck` GREEN; new collapse component test GREEN.
- DO vertical-slice test (`tests/workers/project-data-do.test.ts` "persists and returns the origin
  marker") written; the Miniflare **workers pool crashes in this sandbox** ("Worker exited
  unexpectedly") for ALL workers tests including pre-existing ones — an environment limitation, so it
  will run in CI, not locally here.
- Lint: warnings only (pre-existing patterns); no new errors.

Staging + merge SKIPPED per user instruction → PR is `needs-human-review`, not self-merged. Human must
staging-verify end-to-end (submit a task; confirm the get_instructions reminder renders collapsed on
reload) before merge.
