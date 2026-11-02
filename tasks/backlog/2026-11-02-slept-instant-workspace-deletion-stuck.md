# Deleting a slept Instant workspace stays in `stopping`

## Problem

Deleting an Instant (cf-container) workspace whose container is asleep never finishes on staging.
`DELETE /api/workspaces/:id` returns `202 {"deletionStatus":"pending","workspaceStatus":"stopping","reason":"runtime_deletion_unconfirmed"}`,
the workspace stays `stopping`, and its node stays `sleeping`. The deletion queue keeps retrying
(`workspaces.updated_at` moves about hourly) without confirming the runtime is gone.

Stopping the chat session first does not help: `POST /api/projects/:id/sessions/:sessionId/stop`
returns `409 {"error":"CONFLICT","message":"Session archive cleanup is pending; saved workspace data is retained for retry"}`.

## Context

Found on 2026-11-02 while verifying PR #2490 (personal profile account pins) on staging. The user is
the smoke user, project `hono`, profile "Claude Code Chat" (Instant runtime). Each test chat ran,
answered, slept, and was then deleted through the API:

| Workspace                    | Node                         | Deleted at (UTC) | State at 03:47 UTC                    |
| ---------------------------- | ---------------------------- | ---------------- | ------------------------------------- |
| `01M6CYR2S52Z5JF5VSK6KDJY6H` | `01M6CYR2H8E50F3YZ9GGQFZJXY` | 02:13            | workspace `stopping`, node `sleeping` |
| `01M6CZ20D18FWCN4G68EJKYDFV` | `01M6CZ2054TZMR2EVWETFR7VX6` | 02:13            | workspace `stopping`, node `sleeping` |
| `01M6D5KY707D6JGHN9YMTGGZKQ` | `01M6D5KXYNT8648AM3ZTPTYGYG` | 03:46            | `stopping`, node `recovery`           |
| `01M6D5R4V381N8TXYP7HBK33PK` | `01M6D5R4JNDMYCA62HAY4WAARB` | 03:46            | `stopping`, node `sleeping`           |

PR #2490 does not touch deletion. The reason string comes from
`apps/api/src/services/workspace-deletion.ts` / `workspace-cleanup.ts`.

Hypothesis, not yet verified: the deletion proof needs a live container to confirm teardown, and a
slept container cannot answer. Rule 58's round-trip section warns about exactly this ("the
resumer must accept what the sleeper leaves").

## Acceptance Criteria

- [ ] Read the NodeLifecycle deletion queue and container DO logs for one of the workspaces above, and identify which proof step does not complete for a slept container
- [ ] Deleting a slept Instant workspace reaches a terminal deleted state, and the container is destroyed, without first waking it into a usable session
- [ ] A test drives the real sleep writers, then the real delete path, on one SQL engine (see `tests/integration/instant-idle-sleep-wake.test.ts`), and fails before the fix
- [ ] Session stop on a slept, being-deleted Instant workspace does not return 409 forever
- [ ] Staging: start an Instant chat, let it sleep, delete it, and confirm the workspace becomes deleted
- [ ] Clean up the four staging workspaces above
