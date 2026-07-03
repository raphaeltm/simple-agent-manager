# Async Title Generation and WebSocket-First Chat

## Problem

Production evidence showed new chat submissions sometimes spent 5-15 seconds before the UI received an acknowledgement. The most likely request-path cause is synchronous AI task title generation inside `POST /api/projects/:projectId/tasks/submit`, which blocks task/session creation and TaskRunner start. Active chat sessions also do a full session-detail poll every 3 seconds even when the Durable Object WebSocket is connected, adding avoidable load to the hot session detail endpoint.

## Research Findings

- `apps/api/src/routes/tasks/submit.ts` awaits `generateTaskTitle()` before inserting the task, creating the ProjectData chat session, persisting the first user message, and starting the TaskRunner DO.
- `apps/api/src/services/task-title.ts` already falls back to truncation and has bounded timeouts, but the successful path is still request-path model latency.
- `apps/web/src/components/project-message-view/useSessionLifecycle.ts` opens a chat WebSocket and handles message/activity events, but still polls `getChatSession()` every 3 seconds while a session is active.
- `apps/web/src/components/project-message-view/useActivityVerifyTimer.ts` verifies activity decay by calling full `getChatSession(..., { limit: 0 })`, which still resolves session, ACP state, and task metadata server-side.
- `apps/web/src/hooks/useChatWebSocket.ts` handles message, activity, stopped, failed, and completed events, but not `session.updated`, so server-side topic updates are not applied live without polling.
- Relevant rules: `.claude/rules/06-api-patterns.md`, `.claude/rules/14-do-workflow-persistence.md`, `.claude/rules/35-vertical-slice-testing.md`, `.claude/rules/17-ui-visual-testing.md`.

## Implementation Checklist

- [ ] Change `tasks/submit` to create task/session using an immediate deterministic fallback title.
- [ ] Schedule AI title generation with `executionCtx.waitUntil()` after task/session creation.
- [ ] Update both the D1 task title and ProjectData session topic when async title generation produces a better title.
- [ ] Add a lightweight chat session state endpoint that returns ACP activity state without loading messages or task metadata.
- [ ] Update the web activity verify timer to call the lightweight state endpoint.
- [ ] Gate full session-detail polling so connected active sessions rely on WebSocket events and reconnect catch-up.
- [ ] Keep a slower full-session fallback only while the WebSocket is not connected.
- [ ] Handle `session.updated` WebSocket events so async topic/title changes reach the chat UI live.
- [ ] Update API reference material for the new endpoint.
- [ ] Add regression tests proving submit does not await AI title generation, lightweight state reads avoid message loading, and WebSocket session updates are handled.
- [ ] Run API/web tests, typechecks, lint, and build.
- [ ] Run specialist validation for API/Cloudflare patterns, UI behavior, tests, task completion, documentation sync, and no-hardcoded-values compliance.
- [ ] Deploy to staging and verify the changed behavior end-to-end.

## Acceptance Criteria

- New chat submit returns without waiting for model-based title generation.
- AI-generated task/session titles still appear after creation when generation succeeds.
- Active connected chat sessions do not continuously poll the full session-detail endpoint.
- Fallback refresh behavior remains available during WebSocket reconnect/disconnect states.
- Activity decay verification uses a lightweight endpoint and does not fetch messages.
- Tests cover the changed API and WebSocket/client behavior.
- Staging verification confirms the deployed branch works before merge.
