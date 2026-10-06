# Message-anchored comments web contract

This contract is assumed by the production web UI constituent PR for SAM idea
`01M0JQB842XSJ3W172DYPB37HN`. The backend constituent PR
`01M0K4EP5SND5CPK2N6GYS4449` or the primary integration PR may rename fields or
paths, but should preserve these semantics or update the web client in the same
integration.

## Scope

This document covers message-anchored comments only. File anchors, markdown
block anchors, fuzzy re-anchoring, mentions, reactions, notifications, and a
global comments inbox are intentionally out of scope for this MVP slice.

## Types

```ts
type MessageCommentStatus = 'open' | 'sent' | 'resolved';
type MessageCommentAction = 'note' | 'send_to_agent';

type MessageCommentAnchor = {
  kind: 'message';
  messageId: string;
  quote?: string;
};

type MessageCommentAuthor = {
  id: string;
  name: string | null;
  email?: string | null;
  avatarUrl?: string | null;
  kind: 'human' | 'agent';
};

type MessageCommentReply = {
  id: string;
  clientId?: string | null;
  author: MessageCommentAuthor;
  body: string;
  createdAt: number;
  updatedAt?: number | null;
  sentToAgent?: boolean;
};

type MessageCommentThread = {
  id: string;
  clientId?: string | null;
  projectId: string;
  sessionId: string;
  anchor: MessageCommentAnchor;
  author: MessageCommentAuthor;
  body: string;
  createdAt: number;
  updatedAt: number;
  status: MessageCommentStatus;
  replies: MessageCommentReply[];
};
```

`status: "sent"` means the thread has been dispatched to the agent as a
follow-up instruction. Resolving a sent thread sets `status: "resolved"`;
reopening a resolved thread sets `status: "open"`.

`clientId` is optional but strongly recommended. The web client sends a stable
client-generated id for optimistic create/reply actions so the server response or
WebSocket echo can replace the optimistic row without duplicating it.

## REST endpoints

All endpoints require normal project/session authorization.

### List session message comments

`GET /api/projects/:projectId/sessions/:sessionId/comments?anchorKind=message`

Response:

```ts
{
  comments: MessageCommentThread[];
}
```

The response should include all message-anchored comment threads for the loaded
session, not only comments whose messages are currently mounted in the
virtualized viewport.

### Create a thread

`POST /api/projects/:projectId/sessions/:sessionId/comments`

Request:

```ts
{
  clientId: string;
  anchor: MessageCommentAnchor;
  body: string;
  action: MessageCommentAction;
}
```

Response:

```ts
{
  comment: MessageCommentThread;
}
```

`action: "note"` creates an open note. `action: "send_to_agent"` creates the
thread and queues the quoted instruction for the agent; the returned thread uses
`status: "sent"`.

The server is the write boundary for maximum body and quote length. Those limits
must be configurable server-side; the web client may have display clamps but
must not be treated as the storage safety boundary.

### Reply to a thread

`POST /api/projects/:projectId/sessions/:sessionId/comments/:commentId/replies`

Request:

```ts
{
  clientId: string;
  body: string;
  action: MessageCommentAction;
}
```

Response:

```ts
{
  comment: MessageCommentThread;
}
```

If `action` is `send_to_agent`, the server queues the reply as an agent
instruction and returns the updated thread with `status: "sent"` unless it is
already resolved.

### Resolve / reopen

`POST /api/projects/:projectId/sessions/:sessionId/comments/:commentId/resolve`

`POST /api/projects/:projectId/sessions/:sessionId/comments/:commentId/reopen`

Response:

```ts
{
  comment: MessageCommentThread;
}
```

### Send an existing thread to the agent

`POST /api/projects/:projectId/sessions/:sessionId/comments/:commentId/send`

Request body is optional:

```ts
{
  body?: string;
}
```

If `body` is present, the server may append it as a reply before dispatching the
instruction. The response is:

```ts
{
  comment: MessageCommentThread;
}
```

## WebSocket events

The existing project/session chat WebSocket carries server-authoritative comment
events. Payloads must include `projectId` and `sessionId`; clients ignore events
for other sessions.

```ts
type MessageCommentRealtimeEvent =
  | {
      type: 'comment.thread.created' | 'comment.thread.updated';
      payload: {
        projectId: string;
        sessionId: string;
        comment: MessageCommentThread;
      };
    }
  | {
      type: 'comment.reply.created';
      payload: {
        projectId: string;
        sessionId: string;
        comment: MessageCommentThread;
        replyId: string;
      };
    };
```

The web client treats all three event types as an upsert of `payload.comment`
into the session comment query cache. Replacement matches by `id` first and then
by `clientId`.
