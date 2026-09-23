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
- [x] Vitest (Miniflare) vertical-slice test: POST messages with origin=system → GET returns origin
      (`project-data-do.test.ts` "persists and returns the origin marker", plus new topic-exclusion
      regression + attention-exclusion regression in `attention-markers.test.ts`). Written; runs in
      CI — local workerd (miniflare 4.20260329) SIGSEGVs before collection on ANY worker test
      (reproduced on unrelated `mailbox-do.test.ts`), so this suite is CI-gated locally.

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

## Specialist review findings (2026-07-11) and resolutions

Ran 9 local specialist reviewers (go, cloudflare, security, constitution, test, ui-ux, doc-sync, env,
task-completion). Fixes applied on this branch:

- **[CRITICAL ui-ux] invisible focus ring** — `AcpConversationItemView` summary used the undefined
  Tailwind token `ring-accent-primary`; changed to `ring-focus-ring` (WCAG 2.4.7).
- **[HIGH security] browser-spoofable origin marker** — a browser viewer `session/prompt` could carry
  `_meta["sam.origin"]="system"` and hide its own content from search/dedup/topic/attention.
  `HandlePrompt` now takes `trustedSource`; the marker is stripped (`stripInjectedOriginMarker`) from
  untrusted (gateway/browser + follow-up) prompts and honored ONLY for the SAM initial task prompt.
  Regression test `TestHandlePrompt_OriginMarkerHonoredOnlyForTrustedSource`.
- **[HIGH cloudflare] message.new omitted origin** — single-message broadcast now emits `origin: null`
  (this path only persists browser/RPC user messages) to keep the payload shape aligned with
  `messages.batch`.
- **[HIGH test] coverage gaps** — added: dedup-bypass regression for system origin
  (`useAcpMessages.test.ts`), `chatMessagesToConversationItems` origin mapping matrix, DO auto-topic
  exclusion regression, and attention-resolution exclusion regression.
- **[HIGH ui-ux] Playwright flakiness** — audit now waits for the disclosure to mount, uses boolean
  `open` assertions, and a robust `details summary` selector.
- **[HIGH doc-sync] docs** — added CLAUDE.md "Recent Changes" entry and updated the public
  architecture `overview.md` `chat_messages` description. Spec files left unchanged (rule 01: outside
  active spec context).
- **[LOW doc] migration comment** `0NN` → `024-chat-message-origin` in `row-schemas/messages.ts`.

Reviewed and intentionally NOT changed (documented rationale):
- **[MEDIUM security] FTS query-time origin filter** — not needed: `chat_messages_grouped` is written
  only by `materializeSession`, which already excludes `origin=system`, so system rows never enter the
  FTS index; the non-materialized fallback (`searchMessagesLike`) has an explicit origin filter. Adding
  a filter on grouped rows would be redundant and incorrect (grouped rows have no 1:1 origin).
- **[MEDIUM security] POST /:id/messages accepts origin=system from callback-token holders** — the
  container subprocess has no callback token (confirmed by security-auditor), so the trust boundary is
  the vm-agent, which is now hardened. The reporter is the legitimate origin=system producer.
- **[MEDIUM cloudflare] picklist `'user'`** — harmless: read paths treat `'user'`≡NULL; the vm-agent
  never emits `'user'`. Kept for schema clarity.
- **[LOW constitution] hardcoded `sam-mcp`/`get_instructions`** — SAM-owned agent instruction prose,
  not an operational/deployment identifier; env-configurability is out of scope for this feature.

## Post-mortem — origin dropped at the service boundary (found on staging E2E)

- **What broke:** On staging, the SAM-injected reminder was correctly split into its own user message,
  but it persisted with `origin=null` — so it rendered as a normal (uncollapsed) user message instead
  of collapsed system context. The feature was visibly broken end-to-end despite all local gates green.
- **Root cause:** `apps/api/src/services/project-data.ts:persistMessageBatch` re-maps batch messages
  before the DO RPC and did not include `origin` (neither the param type nor the `messages.map(...)`).
  The vm-agent sent `origin=system`, `routes/workspaces/runtime.ts:toProjectDataMessages` forwarded it,
  but this intermediate service layer silently dropped it before the DO INSERT.
- **Class of bug:** Missing propagation across an intermediate boundary that no test exercised. The
  vm-agent tests mock the reporter; the DO worker tests call the stub directly; the API route tests
  don't traverse the service→stub hop. Compounded by CI **not running the DO worker suite at all**
  (`test:workers` is absent from `ci.yml`) and that suite SIGSEGV-ing locally — so the DO-side origin
  tests ran nowhere.
- **Why not caught:** No vertical-slice test crossed runtime.ts → project-data service → DO stub
  (rule 35/10). Local + CI both skipped the worker suite; only real staging E2E exercised the full path.
- **Process fix (this PR):** Added a Node-pool service-layer regression test
  (`tests/unit/services/project-data-retry.test.ts` → "forwards origin to the DO stub in
  persistMessageBatch") that runs in CI and fails on the pre-fix code. Filed
  `tasks/backlog/2026-07-11-ci-does-not-run-do-worker-tests.md` to make the DO worker suite run in CI.

## Staging coordination note

Priority-1's branch (`sam/implement-phase-3a-idea-04cwjb`) re-deployed staging at 18:58 (after its
own turn and after my 18:48 deploy), overwriting my Worker + vm-agent binary. My first E2E attempt
tested priority-1's code (main-based concatenation), not mine. Re-deployed my branch (19:26) and
re-verified against my own code; that is when the service-boundary bug surfaced.

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
