# Message comment MCP/directive adapter contract

This note documents the backend seam used by the MCP/agent-directive constituent
PR for the message-anchored commenting MVP. The backend constituent PR owns
ProjectData SQLite tables, migrations, indexing, and authoritative message
anchor validation. This PR only calls the methods below through
`apps/api/src/services/message-comments.ts`.

## Scope

- Message anchors only: `{ kind: "message", messageId, quote }`.
- No file comments, re-anchoring, mentions, reactions, or passive full-thread
  context injection.
- All caller identity is derived outside ProjectData from the verified MCP token
  or authenticated browser session. Backend RPCs must still enforce `projectId`
  by the ProjectData object name and `sessionId` by stored thread rows.

## ProjectData RPC methods required

The backend sibling should implement these methods on the ProjectData Durable
Object stub:

```ts
listMessageCommentThreads(input: {
  sessionId: string;
  status?: "open" | "sent" | "resolved" | "all";
  messageId?: string | null;
  cursor?: string | null;
  limit: number;
}): Promise<{
  threads: MessageCommentThreadSummary[];
  nextCursor: string | null;
  hasMore: boolean;
}>;

getMessageCommentThread(input: {
  sessionId: string;
  threadId: string;
}): Promise<MessageCommentThread | null>;

createMessageCommentThread(input: {
  sessionId: string;
  messageId: string;
  quote: string | null;
  body: string;
  author: MessageCommentAuthor;
  provenance: MessageCommentActorProvenance;
}): Promise<MessageCommentThread>;

replyToMessageCommentThread(input: {
  sessionId: string;
  threadId: string;
  body: string;
  author: MessageCommentAuthor;
  provenance: MessageCommentActorProvenance;
}): Promise<MessageCommentThread>;

updateMessageCommentThreadStatus(input: {
  sessionId: string;
  threadId: string;
  status: "open" | "resolved";
  actor: MessageCommentAuthor;
  provenance: MessageCommentActorProvenance;
}): Promise<MessageCommentThread>;

markMessageCommentThreadObserved(input: {
  sessionId: string;
  threadId: string;
  observer: MessageCommentAuthor;
  provenance: MessageCommentActorProvenance;
}): Promise<{ observed: boolean }>;

recordMessageCommentDirectiveDelivery(input: {
  sessionId: string;
  threadId: string;
  delivery: MessageCommentDirectiveState;
  sentByUserId: string;
  sentAt: number;
}): Promise<MessageCommentThread | null>;
```

The shared TypeScript shapes live in
`packages/shared/src/types/comments.ts`.

## Backend invariants

- Every method is scoped to the ProjectData object selected by `projectId`; a
  method must not accept or trust a caller-supplied `projectId`.
- `sessionId` must match the stored thread/session. Wrong-session access must
  return null or a deterministic authorization error; it must never fall back to
  a cross-session lookup.
- `createMessageCommentThread` must verify that `messageId` exists in the same
  session and should preserve a bounded quote/source-message snapshot for agent
  citation.
- `recordMessageCommentDirectiveDelivery` must be idempotent for the same
  `delivery.deliveryId` and thread. Retries from the browser route use the
  stable delivery ID `comment-directive-${threadId}`.
- Durable comment directive delivery must fail closed when
  `DURABLE_PROMPT_DELIVERY_ENABLED=false`; callers must not report a queued
  directive unless the ProjectData prompt-delivery engine is enabled.
- Delivery acknowledgement/read state is the existing ProjectData mailbox
  lifecycle: `deliveryState`, `promptMessageId`, `acceptedAt`, and `ackedAt`.
  Do not create a second inbox for comment directives.
- Prompt delivery and pending mailbox reads must order same-priority,
  same-`created_at` rows by SQLite insertion order (`rowid ASC`) so
  same-session comment directives have a deterministic FIFO tie-breaker at the
  storage/claim boundary.
- Returned thread summaries must be ordered deterministically, cursor-paginated,
  and bounded. The MCP layer applies an additional cap/redaction pass, but the
  storage layer should not rely on callers to avoid unbounded scans.
