# Project chat message truncation

## Problem

Opening a project chat can briefly show the conversation and then collapse to the latest paginated slice, sometimes leaving only a few messages or part of a long assistant response with a `Load earlier messages` button.

## Research Findings

- Project chat history is initially loaded via `getChatSession()` in `apps/web/src/components/project-message-view/useSessionLifecycle.ts`.
- The route `apps/api/src/routes/chat.ts` returns cursor-paginated messages from `projectDataService.getMessages()`.
- `apps/api/src/durable-objects/project-data/messages.ts` orders by newest rows, limits to `SAM_HISTORY_LOAD_LIMIT`, then reverses into chronological order.
- Active project chat sessions also receive messages from the DO WebSocket (`apps/web/src/hooks/useChatWebSocket.ts`) and ACP session state (`apps/web/src/hooks/useProjectAgentSession.ts`).
- The destructive path was in `useSessionLifecycle.ts`: polling fallback and reconnect catch-up used `mergeMessages(..., 'replace')`, treating a latest REST page as the full authoritative transcript.

## Implementation Checklist

- [x] Add a message reconciliation strategy for latest-page REST refreshes.
- [x] Preserve older messages already loaded through pagination when polling/catch-up refreshes.
- [x] Keep `hasMore` from regressing when a refresh page reports older rows exist but the client already has those rows.
- [x] Update polling fallback and WebSocket catch-up to use the non-destructive refresh strategy.
- [x] Add regression tests for latest-page refresh and pagination state.
- [x] Add component regression coverage for active polling returning only the latest page.
- [x] Run targeted tests, lint, and typecheck.

## Acceptance Criteria

- [x] Active-session polling does not truncate an already-loaded transcript when the REST endpoint returns only the latest page.
- [x] Reconnect catch-up with empty or partial REST data does not wipe the displayed conversation.
- [x] New messages from REST refreshes still appear.
- [x] Pagination `Load earlier messages` visibility does not regress after older messages have already been loaded.

## Validation

- `pnpm --filter @simple-agent-manager/web test -- tests/unit/lib/merge-messages.test.ts`: passed.
- `pnpm --filter @simple-agent-manager/web test -- tests/unit/components/project-message-view.test.tsx`: passed.
- `pnpm --filter @simple-agent-manager/web test`: passed, 158 files / 2008 tests.
- `pnpm --filter @simple-agent-manager/web lint`: passed with existing warnings.
- `pnpm --filter @simple-agent-manager/web typecheck`: passed.
- `pnpm --filter @simple-agent-manager/web build`: passed.

## Notes

- An unrelated existing Playwright audit failure was filed separately at `tasks/backlog/2026-05-04-project-chat-tool-call-audit-failure.md`.
