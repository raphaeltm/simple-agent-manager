# Bound the session comment-list payload, with client pagination

## Problem

`listCommentThreads` / `listFileCommentThreads` (via `listThreadRecords` in
`apps/api/src/durable-objects/project-data/anchored-comment-store.ts`) return up to the list limit
of threads (default 100, max 500) with every reply body. A thread can hold up to 200 replies of up to
8,000 characters. A page made of many such threads can approach the 32 MiB Durable Object RPC
serialization ceiling, which would fail the whole read. Only the project inbox has a byte budget
(`PROJECT_COMMENT_LIST_MAX_BYTES`).

This predates the comment-core unification (PR #2541): main had the same unbounded payload at the
default limit of 100. #2541's bind-parameter batching also makes explicit limits above about 100
threads work, where before they failed on the bind ceiling.

A server-only fix (trim the page at thread boundaries and return `hasMore: true`) would silently hide
threads: the web client (`apps/web/src/lib/api/comments.ts`, `library-file-comments.ts`) never sends
`afterSequence` and ignores `hasMore` for session and file lists.

## Context

- Raised by CodeRabbit on PR #2541 (`anchored-comment-store.ts:199`), declined there for the reason
  above.
- Realistic exposure today is low (it needs roughly 20 maximum-size threads in one page), but the
  limit is configurable.

## Acceptance Criteria

- [ ] The session and file comment lists stop adding threads once a configurable byte budget is
      reached, keep at least one thread, and return `hasMore: true`
- [ ] The web clients follow `hasMore` with `afterSequence` so every thread is reachable
- [ ] A test drives a page over the budget and asserts every thread arrives across pages
