# Move the workspace-page chat onto the shared transcript cache

## Problem

The project chat now reads each chat's transcript from the TanStack Query cache
(`useSessionTranscript` in `apps/web/src/components/project-message-view/`). It opens
cached chats at once, loads the newest page first, and keeps recent transcripts for 24 h
(PR for task `2026-09-27-project-chat-instant-switching`).

The workspace page's chat (`apps/web/src/pages/workspace/WorkspaceChatView.tsx`) still
loads the same endpoint through a hand-rolled `useState` + `useEffect` loader:

- `getChatSession(projectId, sessionId)` with no `limit`, so it gets the server's default page;
- its own `messages`, `hasMore`, `loading`, `firstItemIndex` and `followUp` state;
- a full reload on every mount.

It reimplements the same paging helpers (`mergeMessages`, `oldestPersistedCursor`,
`countDisplayRows`) instead of sharing the transcript layer.

The two chat surfaces now behave differently for the same session, and every fix to
transcript loading has to be made twice. Rule 60 also requires new fetch surfaces to use
TanStack Query.

## Context

The architecture review of the project chat instant-switching PR raised this on
2026-09-27. It was out of that PR's scope, because project chat is the primary surface
(rule 26).

## Acceptance Criteria

- [ ] `WorkspaceChatView` reads its transcript through `chatSessionMessagesQueryOptions` /
      `useSessionTranscript` (or a shared extraction of them), not a local loader.
- [ ] Opening a session already cached by the project chat renders it at once on the
      workspace page, and the reverse.
- [ ] Scroll-up paging on the workspace page uses the shared `loadMore`, gated the same way
      as the project chat (only once the reader has left the bottom).
- [ ] The duplicated merge/cursor/row-count code in `WorkspaceChatView.tsx` is removed.
- [ ] Tests enter through the real triggers: mount, socket rows, and scroll-up.
