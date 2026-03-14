# Summarize Endpoint Hardening

**Created**: 2026-03-14
**Source**: Cloudflare specialist review of PR #376 (conversation forking)

## Problem

The `/summarize` endpoint works correctly but has several hardening opportunities identified in post-merge review:

1. **Role pre-filtering at DO boundary**: Route fetches all 1000 messages then filters in JS. Should use the `roles` parameter on `getMessages()` to filter at SQLite level, reducing DO RPC payload.
2. **No rate limiting**: Workers AI calls have no rate limit — repeated calls could burn AI budget. Should follow `RATE_LIMIT_TRANSCRIBE` pattern.
3. **Unsafe taskId cast**: `session.taskId as string | null` should use `typeof` guard instead of cast.
4. **Missing integration test**: No Miniflare test for the route handler — only unit tests for the service.
5. **CONTEXT_SUMMARY_* vars not in wrangler.toml**: Operators won't discover these config levers.
6. **classifyError shared utility**: Currently imported from `task-title.ts` — should be factored into `src/lib/errors.ts`.

## Acceptance Criteria

- [ ] `/summarize` route passes `['user', 'assistant']` as `roles` to `getMessages()`
- [ ] Rate limit added for `/summarize` endpoint (`RATE_LIMIT_SUMMARIZE` env var)
- [ ] `session.taskId` guarded with `typeof` check
- [ ] Miniflare integration test covers: session not found (404), empty messages (400), successful summarize
- [ ] `CONTEXT_SUMMARY_*` vars documented in `wrangler.toml` `[vars]` section
- [ ] `classifyError` moved to shared utility in `src/lib/errors.ts`, imported by both `task-title.ts` and `session-summarize.ts`

## Context

- `apps/api/src/routes/chat.ts` (summarize route, lines 300-373)
- `apps/api/src/services/session-summarize.ts`
- `apps/api/src/services/task-title.ts` (classifyError source)
- Review report: Cloudflare specialist review of PR #376
