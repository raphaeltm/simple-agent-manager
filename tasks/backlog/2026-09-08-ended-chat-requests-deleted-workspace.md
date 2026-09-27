# Avoid deleted-workspace requests when opening ended chat history

## Reproduction and evidence

On staging, open Deployment Test 1 session `79aaaa68-6ddc-464f-ab23-9389c08d1a69` (an old completed smoke test). The transcript renders, but the browser requests `/api/workspaces/01KZR0X61YM6YG7G9P7JSW1NBZ`, which returns 404 because the workspace no longer exists. Chromium reports the resource failure in the console.

This was observed with history restored to root before compact migration succeeded, so it is not evidence of a compact archive read regression. Keep it distinct from the temporary exact-read fence raised by the failed remigration journal, which is handled by the compact archive task's successor-intent fix.

## Acceptance criteria

- [ ] Determine which optional ended-session surface fetches workspace state.
- [ ] Render retained history without a failed request for a known deleted workspace, while preserving access to available workspace/snapshot actions.
- [ ] Add an ended-session/deleted-workspace browser regression scenario.

## Update 2026-09-27

Seen again during staging verification for project chat instant switching (baseline run on the
pre-change build, same result after): opening ended chats in Test Project 1 logs
`Failed to load resource: 404` for `GET /api/workspaces/:id` of workspaces whose D1 status is
`deleted` (for example `01M33BPH6TG99TR9YQEEVSP21J`, `01M38EYR5S0CP35RY4QBZW18HF`).

Source: `useSessionInfrastructure` (`apps/web/src/components/project-message-view/useSessionInfrastructure.ts`)
fetches the session's workspace through `useRetryingInfrastructureResource`, which also retries a
404 on its `VITE_SESSION_INFRA_RETRY_DELAYS_MS` schedule (2 s, 5 s, 10 s), so a reader who stays on
the chat sees up to four failed requests per open.
