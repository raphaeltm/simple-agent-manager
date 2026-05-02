# Preserve Tool Call Display Details

## Problem

Tool calls initially render with rich detail from the live ACP WebSocket stream, but after the UI switches to ProjectData Durable Object persisted history, some tool calls render generically as "Tool Call" with little or no visible detail. The persisted conversation should be able to recreate the same tool call card users saw while the agent was connected.

## Research Findings

- The project message view prefers live ACP items while the agent is prompting or within the ACP grace period, then switches to DO-backed messages after `committedToDoViewRef` is set.
  - `apps/web/src/components/project-message-view/index.tsx`
  - `apps/web/src/components/project-message-view/useConnectionRecovery.ts`
- The VM agent extracts ACP notifications into persisted messages in `packages/vm-agent/internal/acp/message_extract.go`.
- Tool messages are persisted through `POST /api/workspaces/:id/messages`, then into `chat_messages.content` and `chat_messages.tool_metadata`.
  - `apps/api/src/routes/workspaces/runtime.ts`
  - `apps/api/src/durable-objects/project-data/messages.ts`
- Persisted messages are converted back into shared ACP conversation items in `apps/web/src/components/project-message-view/types.ts`.
- Previous postmortem `docs/notes/2026-03-12-message-misrouting-and-metadata-loss-postmortem.md` warns that silent metadata loss is high risk and must be tested behaviorally.
- Previous postmortem `docs/notes/2026-03-23-disappearing-messages-postmortem.md` warns against tests that merely document broken message behavior instead of user-visible contracts.

## Implementation Checklist

- [x] Verify VM agent coverage proves terminal/tool call metadata survives extraction with enough raw detail for persisted display.
  - Existing VM agent tests already assert terminal raw content is preserved as `type=terminal` with `terminalId`.
- [x] Preserve tool call metadata through ProjectData batch persistence without dropping structured content.
  - Existing DO path persists and broadcasts parsed `toolMetadata`; no API/DO code change was required for this bug.
- [x] Update persisted message to conversation item reconstruction so it renders useful details from metadata and raw ACP content instead of falling back to generic labels.
- [x] Add web tests proving persisted tool messages reconstruct the same meaningful card fields as live ACP tool messages.
- [x] Run focused Go and TypeScript tests for the modified paths.
  - TypeScript focused test passed: `pnpm --filter @simple-agent-manager/web test -- chatMessagesToConversationItems.test.ts`
  - Go test could not be run in this workspace because `go` is not installed (`which go` returned no path).
- [x] Run local UI visual audit for persisted tool call cards on mobile and desktop.
  - Added `apps/web/tests/playwright/project-chat-tool-call-audit.spec.ts`.
  - Passed: `npx playwright test tests/playwright/project-chat-tool-call-audit.spec.ts --project="iPhone SE (375x667)" --project="Desktop (1280x800)"`.
- [x] Run quality checks that are practical in this workspace and document any skipped checks.
  - Full `pnpm test` initially failed in unrelated `packages/ui/tests/ButtonGroup.test.tsx` because jsdom normalized `borderRadius: 0` to `0px`; fixed the assertion and the focused UI test now passes.
  - Passed: `pnpm typecheck`.
  - Passed: `pnpm lint` (warnings only, no errors).
  - Passed: `pnpm test`.
  - Passed: `pnpm build`.

## Acceptance Criteria

- Persisted tool call rows retain structured metadata needed for display.
- Persisted terminal/tool call messages do not collapse to generic "Tool Call" when metadata contains useful detail.
- Live ACP tool calls and persisted DO tool calls use the same mapping logic for raw ACP content where possible.
- Regression tests cover the VM extraction path and persisted UI reconstruction path.
- No staging deployment is performed for this task; PR is opened but not merged.
