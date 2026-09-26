# A chat reopened within its cache's stale time never shows messages written while it was closed

## Problem

The project chat serves its transcript from the TanStack Query cache, which is persisted to IndexedDB (`apps/web/src/lib/query-persistence.ts`). When a chat is reopened within `staleTime` (15 s, `apps/web/src/lib/query-client.ts`) of that cache's last update, the session query is fresh. So the `useSessionLifecycle` `queryFn`, the forward refresh `refreshCachedTranscript`, never runs. The chat WebSocket catches up only on a reconnect: `useChatWebSocket` `ws.onopen` skips the first connect because "the initial REST load already fetches messages". So a message persisted while the chat was closed stays missing for the life of the page. Nothing else refetches a connected session either: the fallback poll runs only while the socket is down, and `refetchOnWindowFocus` is off.

There is a related window when the forward refresh does run:

- Its result is built from the cache snapshot taken when it started (`refreshCachedTranscript(..., cached, ...)`), and TanStack replaces the query data with that result.
- The hook then replaces its state with the query data (`setMessages(sessionQuery.data.messages)`).
- So a WebSocket message merged into the cache while the refresh was in flight, but persisted after the server read its page, drops out of view until the next refetch.

## Reproduction (staging, 2026-09-26)

Staging `hono` project, session `554d9f3c-1cb9-4d3c-b628-ffc4654cff44`, one browser profile:

1. Open the chat, let it load, close the tab.
2. Send `POST /api/projects/:projectId/sessions/:sessionId/prompt` and wait until the agent's reply is persisted.
3. Reopen the chat 8.7 s after closing it. No session request is made, and the persisted reply is still not rendered 30 s later.
4. Control: reopen 20 s after closing instead. The page issues `GET /sessions/:sessionId?after=[createdAt,sequence,id]` and renders the reply.

## Acceptance Criteria

- [ ] Opening a chat always reconciles a cached transcript with the server through the forward refresh, however fresh the cache is. Cached content stays visible meanwhile (stale-while-revalidate, `apps/web/.claude/rules/48-stale-while-revalidate-ui.md`).
- [ ] A WebSocket message that arrives while that refresh is in flight is still shown after the refresh resolves.
- [ ] Hook tests enter through the real triggers (`.claude/rules/62-tests-must-observe-the-real-trigger.md`):
  - mounting with a fresh cached transcript;
  - a socket message delivered while a deferred refresh is still pending.
- [ ] Each guard is reverted once and the intended test goes red.
- [ ] On staging, the reopen-within-15-s reproduction above renders the reply.

## Context

Found during staging verification of the transcript-boundary fix (`tasks/archive/2026-09-25-transcript-boundary-and-reporter-payloads.md`). The gap predates that branch: `useChatWebSocket.ts`, the query `staleTime` and the cache persistence are unchanged by it. What that branch changed is what the refresh does once it runs, and the control step above exercises exactly that.

Related: `tasks/backlog/2026-09-26-chat-recent-window-merge-can-leave-gap.md`.
