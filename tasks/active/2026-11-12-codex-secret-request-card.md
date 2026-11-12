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
- The API keeps the row `content` column in compact mode, so the web-only fix also recovers
  already-stored production rows after a reload. No VM-agent change or rollout is needed.
- Two lists of typed-card tools (registry predicates and `isTypedCardTool`) is what let a new card
  ship registered in one and missing from the other. This is the third Codex card incident
  (2026-08-03 twice for library cards). There is no standing guidance on cross-harness card
  rendering.
- PR #2688's VM and Instant staging proof used Claude only. VM/Instant are runtimes, not harnesses.

## Implementation checklist

- [ ] Failing regression: exact Codex dotted/sparse `request_secret` sequence through
      `chatMessagesToConversationItems` → `matchToolCard` → `groupToolCallItems` renders
      `SecretRequestCard` outside any generic group (fails on pre-fix code).
- [ ] One canonical typed-card tool set in `tool-cards/` consumed by both the registry and the
      message converter, so a card cannot be registered without the converter recovering it.
- [ ] Cover: title-only/empty toolName inference, compact/reloaded history (content-only result),
      malformed result and failed call stay generic, live in-progress stays generic.
- [ ] Contract test over every typed-card tool in the Codex sparse shape (and Claude shape), so a
      future card without harness coverage fails.
- [ ] Existing Claude / library / approval / human-input tests stay green.
- [ ] Concise scoped rule in `apps/web/.claude/rules/` for cross-harness typed cards.
- [ ] Local Playwright audit of the full conversation path (mobile + desktop), screenshots viewed.
- [ ] Lint, typecheck, test, build.
- [ ] Local specialists: task-completion-validator, ui-ux-specialist, test-engineer.
- [ ] Staging: real Codex `request_secret` → visible card → browser save → metadata-only notice →
      `exec_with_secrets` use; live and after reload/compact. Real Claude control. Fixtures cleaned.
- [ ] Draft PR with evidence; coordinator approves exact SHA; CodeRabbit best effort; merge;
      main CI → production deploy → health/static smoke.

## Acceptance criteria

- A Codex `request_secret` result renders `SecretRequestCard` live and after reload, not inside a
  generic tool group, on staging with a real Codex session.
- Claude Code `request_secret` still renders the card (real staging control).
- Failed or malformed `request_secret` results keep the generic tool card.
- Library, approval and human-input cards are unchanged for both harnesses.
- No secret value appears in transcripts, tool outputs, logs or screenshots.
