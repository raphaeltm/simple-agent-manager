# Comment idempotency conflicts return 500 instead of 409

## Problem

When a client reuses a comment `clientMutationId` with different content, the comment routes should return `409`. They return `500`.

`rethrowCommentError` (`apps/api/src/lib/comment-http.ts`) recognises `CommentIdempotencyConflictError` by `instanceof`, `code` or `name`. None of these survive the ProjectData Durable Object RPC. The caller receives a plain `Error` with `name` `"Error"` and no `code`, and the class name is folded into the message: `"CommentIdempotencyConflictError: clientMutationId already belongs to a different comment mutation"`. The mapper falls through and rethrows the raw error, so `app.onError` answers `500`.

Not-found errors are unaffected. They cross with their plain message (`"Message not found"`), and `isSerializedCommentNotFoundError` maps them to `404` (checked the same way, below).

## Context

- Found by the staging probe for PR #2381 on 2026-10-20 at 01:22 UTC. `POST /api/projects/:id/sessions/:sessionId/comments` was sent a second time with the same `clientMutationId` and a different `mentions` list, and returned `500`.
- Reproduced locally in the Workers runtime: calling `projectDataService.createCommentThread` twice with the same `clientMutationId` and a different `body` gives the error shape above, and `rethrowCommentError` does not map it.
- Pre-existing. The error classes and the mapper are unchanged since #1882/#1897. PR #2381 only added mentions to the fingerprint, which is one more way to produce a conflicting replay. A different `body` already produced one.
- Normal clients do not hit this path, because the web app sends a new `clientMutationId` for every mutation and replays identical content.

## Acceptance Criteria

- [ ] A conflicting replay through the real comment route returns `409`. Test it in `apps/api/tests/workers/`, through the real DO RPC, not by throwing the class in-process (`.claude/rules/63`, RPC fidelity).
- [ ] `CommentValidationError` and `CommentLimitExceededError` are checked across the RPC the same way and map to `400`/`422`.
- [ ] Library-file comment routes and the MCP comment tools (`mapCommentError` in `apps/api/src/routes/mcp/comment-tool-helpers.ts`) are checked for the same gap.
- [ ] The new test fails against the current mapper and passes with the fix (record which test went red).
