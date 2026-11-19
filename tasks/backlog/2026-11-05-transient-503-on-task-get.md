# Transient 503 on GET /api/projects/:id/tasks/:taskId during staging chat runs

## Problem

During staging chat runs the web app logged `503` responses from
`GET /api/projects/01KTKXZ4ZZAT6MJFXRW1ZTQ7RB/tasks/<taskId>` (three times in one run and three in
another). Retrying the same URL 20 times afterwards returned 200 every time. The response body was
not captured, so the source is unconfirmed. The likely source is `read-auth-session.ts`, which
answers `503 AUTH_UNAVAILABLE` when the session read times out. That route has no 503 path of its own.

## Context

- Staging, 2026-11-05 between 18:42 and 19:08Z, with three VM chats and their sender chats
  open and polling at once (deploy run 42083339183).
- Task `01M6PH70E75K2SE398XZEKXQR6`; the earlier run logged the same console 503 without a URL.

## Acceptance Criteria

- [ ] Capture the response body (`error` code) for one occurrence, via a browser run or Worker logs.
- [ ] If it is `AUTH_UNAVAILABLE`, measure how often the auth session read times out under that load
      and decide whether the deadline or the retry policy needs tuning.
- [ ] The web app retries or tolerates a transient 503 on this poll without surfacing an error.
