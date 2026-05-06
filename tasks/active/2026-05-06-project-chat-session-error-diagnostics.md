# Project Chat Session Error Diagnostics

## Problem

Project chat session detail loads can fail with a generic `Internal server error`, leaving the user and agents without enough information to identify the actual failing phase or bad data row.

The affected user flow is loading a project chat session:

- Frontend: `apps/web/src/components/project-message-view/useSessionLifecycle.ts`
- API route: `apps/api/src/routes/chat.ts`
- ProjectData service/DO: `apps/api/src/services/project-data.ts`, `apps/api/src/durable-objects/project-data/messages.ts`

## Research Findings

- `GET /api/projects/:projectId/sessions/:sessionId` loads the session and messages before optional task/ACP lookup fallback handling.
- Failures from `projectDataService.getSession()` or `projectDataService.getMessages()` are currently handled only by the global `app.onError()` handler, which returns `{ error: "INTERNAL_ERROR", message: "Internal server error" }`.
- `getMessages()` maps each row through `parseChatMessageRow()`.
- `parseChatMessageRow()` currently does a raw `JSON.parse(r.tool_metadata)`, so a single malformed `tool_metadata` value can make the entire session fail to load.
- Cloudflare Workers logs are sampled and did not reliably expose recent `request_error` entries for this route. Staging observability D1 also did not show durable API request errors for the tested failures, so relying on console logs is insufficient.
- Staging API smoke auth can list sessions and load several large session details successfully, which suggests the failure is likely session/data-specific rather than a broad auth/routing outage.

## Relevant Rules And Docs

- `.claude/rules/06-api-patterns.md` — API errors should be structured and route errors must go through `app.onError()`.
- `.claude/rules/26-project-chat-first.md` — project chat is the primary UX surface.
- `.claude/rules/32-cf-api-debugging.md` — use Cloudflare API and staging state before guessing.
- `docs/adr/004-hybrid-d1-do-storage.md` — ProjectData DO stores chat sessions/messages.
- `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md` — preserve canonical ProjectData mappings and avoid inferred chat session state.
- `docs/notes/2026-03-23-disappearing-messages-postmortem.md` — message persistence failures need durable visibility.

## Implementation Checklist

- [ ] Add a safe helper for chat session load diagnostics with a generated request ID, phase, project ID, session ID, error name/message/stack, and sanitized response details.
- [ ] Persist chat session detail load failures to observability D1 when available, not only sampled Worker logs.
- [ ] Return a structured 500 response for chat session detail failures that includes a safe `requestId` and phase.
- [ ] Expose admin-only diagnostic details for chat session load errors while keeping regular-user responses safe.
- [ ] Make `tool_metadata` parsing resilient so malformed metadata does not prevent a session from loading.
- [ ] Add regression tests for malformed `tool_metadata` and chat session detail diagnostic responses.
- [ ] Update documentation for the troubleshooting/debugging path.
- [ ] Run relevant API tests and quality checks.
- [ ] Deploy to staging and verify the changed endpoint behavior with a real authenticated request.

## Acceptance Criteria

- A malformed message metadata row cannot make an entire chat session unloadable.
- If the session detail route still fails, the API response includes a safe request ID that can be searched in logs/observability.
- Admin users can see enough sanitized diagnostic detail to copy into an agent task.
- Non-admin users do not receive stack traces or sensitive details.
- Tests cover the original failure class and the diagnostic response shape.
