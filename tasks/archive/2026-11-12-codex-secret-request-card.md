# Codex `request_secret` renders as raw JSON instead of the secure card

Task `01M7823R2H8NBNAVAR4BFSWFV2`, parent coordinator `01M77EEHZSBVF3X55FRXHHD46W`. Draft PR;
the coordinator approves the exact head SHA before ready/merge.

## Problem

After PR #2688 shipped to production (`d3204f34d`), the user called `request_secret` from a Codex
conversation (session `b0c764d3-1270-44d2-a8fa-2510d4c10814`, request
`01M781STQK6N3SY47G641QTS2X`, 14:15 UTC). The call succeeded, but the chat showed a generic
"2 tool calls" group holding `mcp.sam-mcp.request_secret` and its raw JSON. No secure input card
rendered. The user asked whether we had only tested with Claude Code, and whether we have guidance
for making cards work across harnesses.

The real production request stays pending for the user's retest after deployment.

## Research findings

- `tool-cards/registry.ts` (`resolveToolCard`) recognises `request_secret` under any separator and
  needs only `secretRequest.id` from the result (`extractSecretRequestId`). The registry is correct.
- `normalizeToolName` already splits `.`, so `mcp.sam-mcp.request_secret` normalizes to
  `request_secret`. There is no separator bug.
- Codex (via the maintained ACP wrapper) persists three sparse rows per MCP call (see
  `tasks/archive/2026-08-03-fix-sparse-codex-library-card-updates.md`): an initial row with a dotted
  title, a status-only update, and a completed update carrying only `toolCallId` + `status`, with
  the tool's JSON result only in message `content` (no title, toolName or rawOutput).
- The VM agent sets `toolName` from the title only for library tools or `mcp__` names
  (`message_extract.go:extractToolName`, `rawCaptureToolNames`), so Codex's `request_secret` initial
  row has **no** `toolName`. It also captures no rawOutput for it (deliberate data minimization).
- `project-message-view/types.ts`: `inferToolNameFromTitle` and `legacyCardRawOutput` (the
  content-only result recovery during the toolCallId merge) both gate on `isTypedCardTool`, a
  second hand-maintained list of typed-card tools that names documents, approvals and human input
  but **not** `request_secret`. So the Codex item ends with no `toolName`, no `rawOutput` and lazy
  content; `extractSecretRequestId` finds no id, `matchToolCard` returns null, and
  `groupToolCallItems` absorbs the call into a generic group. **This is the root cause.**
- Claude Code worked because claude-agent-acp puts `_meta.claudeCode.toolName` on every update row,
  and the API compact path (`row-schemas/messages.ts:cardPayloadMatcher`, which already lists
  `request_secret`) keeps `secretRequest.id` as rawOutput.
- The API keeps the row `content` column in compact mode, so the web converter fix also recovers
  already-stored production rows after a reload. No VM-agent change or rollout is needed. The
  final scope is shared (`TYPED_CHAT_CARD_TOOLS`), web (converter and registry derive from it) and
  API (`CARD_PAYLOAD_MATCHERS` typed against it for compile-time parity); the API change is a
  parity refactor, not part of the user-visible fix.
- Two lists of typed-card tools (registry predicates and `isTypedCardTool`) is what let a new card
  ship registered in one and missing from the other. This is the third Codex card incident
  (2026-08-03 twice for library cards). Project knowledge (`ShippingVerification`) already said
  runtime tests are not harness coverage, but no repository rule required one shared card list or
  a cross-harness test; this PR adds `apps/web/.claude/rules/82-typed-cards-every-harness.md`.
- PR #2688's VM and Instant staging proof used Claude only. VM/Instant are runtimes, not harnesses.

## Implementation checklist

- [x] Failing regression: exact Codex dotted/sparse `request_secret` sequence through
      `chatMessagesToConversationItems` → `matchToolCard` → `groupToolCallItems` renders
      `SecretRequestCard` outside any generic group (fails on pre-fix code).
- [x] One canonical typed-card tool set in `tool-cards/` consumed by both the registry and the
      message converter, so a card cannot be registered without the converter recovering it.
- [x] Cover: title-only/empty toolName inference, compact/reloaded history (content-only result),
      malformed result and failed call stay generic, live in-progress stays generic.
- [x] Contract test over every typed-card tool in the Codex sparse shape (and Claude shape), so a
      future card without harness coverage fails.
- [x] Existing Claude / library / approval / human-input tests stay green.
- [x] Concise scoped rule in `apps/web/.claude/rules/` for cross-harness typed cards.
- [x] Local Playwright audit of the full conversation path (mobile + desktop), screenshots viewed.
- [x] Lint, typecheck, test, build.
- [x] Local specialists: task-completion-validator, ui-ux-specialist, test-engineer.
- [x] Staging: real Codex `request_secret` → visible card → browser save → metadata-only notice →
      `exec_with_secrets` use; live and after reload/compact. Real Claude control. Fixtures cleaned.
- [ ] Draft PR with evidence; coordinator approves exact SHA; CodeRabbit best effort; merge;
      main CI → production deploy → health/static smoke.

## Implementation notes

- Review follow-ups (all reviewers 0 CRITICAL/HIGH): the tool list moved to shared
  `TYPED_CHAT_CARD_TOOLS`; the API's `CARD_PAYLOAD_MATCHERS` is a `Record` over it (compile-time
  parity); an API compact test pins the nameless Codex result row; web tests loop both harness
  shapes over every card, cover incremental row arrival and a deduplicated request; the Playwright
  failed case expands the group.
- PR #2688's compact test assumed Codex result rows carry a `sam-mcp/request_secret` title. Real
  Codex result rows carry no title, which is why the fixture-only proof missed this.
- Discrimination: with only `types.ts` reverted to `d3204f34d`, 6/16 original cross-harness
  tests, the rendered Codex test and both Playwright Codex audits go red.

## Staging evidence (deploy run 43245984878 at 9d4b4e1e7)

- Pre-fix reproduction (staging still on #2688 code): Codex on a Hetzner VM (project Potato,
  session `ff0d98a2…`) rendered a generic "2 tool calls" group and no card, desktop and mobile.
  Real rows: call `{title: mcp.sam-mcp.request_secret, kind: execute, status: in_progress}` with no
  toolName; result `{toolCallId, status: completed, contentSize}` with the JSON as bare content.
- Fixed build: the same stored rows render the card on load and after reload (desktop, mobile);
  browser save → "Secret … supplied" metadata-only notice → slept session woke →
  `exec_with_secrets` stdout hash equals the browser-computed hash. A follow-up request arrived over
  the open WebSocket as a new card in ~14 s with zero console errors.
- Claude Code control (session `c600096d…`): card renders, save → wake → matching hash; value absent
  from page and stored transcript.
- A first Codex attempt in the `crewai` test project failed at agent start (steerable Codex runtime
  needs an x86_64 Node 22 devcontainer, by design); not related to this change.
- Cleanup: two live-test requests declined, two collected secrets deleted, three sessions stopped
  (workspaces deleted), three nodes deleted.
- Pre-existing, unrelated: slept chats log 404s fetching their retired workspace →
  `tasks/backlog/2026-11-12-slept-session-workspace-404-console-errors.md`.

## Acceptance criteria

- A Codex `request_secret` result renders `SecretRequestCard` live and after reload, not inside a
  generic tool group, on staging with a real Codex session.
- Claude Code `request_secret` still renders the card (real staging control).
- Failed or malformed `request_secret` results keep the generic tool card.
- Library, approval and human-input cards are unchanged for both harnesses.
- No secret value appears in transcripts, tool outputs, logs or screenshots.
