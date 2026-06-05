# Fix SAM CLI Contract Drift and Output Issues

## Problem

The SAM CLI has drifted from current API response contracts and renders some table output with raw multi-line text. The transcript described in `sam-cli-session.txt` shows multiple commands returning `INVALID_JSON` or incomplete tables after selecting the SAM project. These are user-facing CLI regressions.

Hard workflow constraint: this work must stop at a draft/open PR. The PR title or body must clearly include `DO NOT MERGE`, and the PR must not be marked ready or merged without a later explicit human instruction.

## Research Findings

- `packages/cli/internal/cli/types.go` still models several stale response shapes:
  - chat detail uses `MessageListResponse`, but `apps/api/src/routes/chat.ts` returns `{ session, messages, hasMore, state }` from `GET /api/projects/:projectId/sessions/:sessionId`.
  - library files use `sizeBytes`, `uploadSource`, `createdAt`, and directory fields per `packages/shared/src/types/library.ts`.
  - knowledge entities use `name`, `entityType`, `observationCount`, and numeric `createdAt`/`updatedAt` per `packages/shared/src/types/knowledge.ts`.
  - triggers use `cronExpression`, `cronHumanReadable`, and `nextFireAt` per `packages/shared/src/types/trigger.ts`.
  - profiles route returns `{ items: profiles }` in `apps/api/src/routes/agent-profiles.ts`.
  - activity route returns ProjectData activity events with `eventType`, `payload`, and numeric `createdAt`.
  - nodes route returns a raw `[]NodeResponse` using `cloudProvider`, `vmLocation`, and `ipAddress` per `packages/shared/src/types/workspace.ts` and `apps/api/src/routes/nodes.ts`.
- `packages/cli/internal/cli/client.go` currently hides JSON decode details behind a generic `INVALID_JSON` message. It should expose safe route/status/decode context without cookies or tokens.
- `packages/cli/internal/cli/table.go` pads raw cell strings, so notification/activity titles or summaries containing newlines break table rows.
- Existing CLI tests in `packages/cli/internal/cli/commands_test.go` cover command boundaries, but several fixtures use stale fake response shapes.
- Relevant process notes:
  - `docs/notes/2026-05-19-cli-sonar-quality-gap-postmortem.md` requires CLI command-boundary tests and Go coverage evidence.
  - `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md` reinforces using the canonical chat session detail route.
  - `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md` reinforces durable review tracking and no premature merge.
- `/uploads/sam-cli-session.txt` was not mounted in this workspace during research, so the transcript failures quoted in the task prompt are the current evidence source.

## Implementation Checklist

- [x] Update CLI response structs and client methods for current API contracts.
- [x] Change `sam chat <sessionId>` to request `GET /api/projects/:projectId/sessions/:sessionId` and render returned messages.
- [x] Update `sam library` to display `sizeBytes`, `uploadSource`, and `createdAt`; make root-only behavior explicit or add a clear all-files/recursive behavior.
- [x] Update `sam context` to display knowledge `name`, `entityType`, `observationCount`, and formatted numeric timestamps.
- [x] Sanitize table cells so multiline or long notification/activity text stays readable and single-line.
- [x] Update `sam triggers` to render current schedule and next-run fields.
- [x] Update `sam profiles` to read `{ items: [...] }`.
- [x] Update `sam activity` to render `eventType`, a useful payload summary, and timestamp.
- [x] Update `sam nodes` to decode a raw node array and render current provider/location/IP fields.
- [x] Improve JSON decode errors with safe actionable context and redaction.
- [x] Add/update command-boundary tests for fixed commands in text and JSON modes where practical, using current API shapes.
- [x] Add focused table-rendering tests for multiline notification/activity/title values.
- [x] Run `go test -race -coverprofile=coverage.out -covermode=atomic ./...` in `packages/cli`.
- [x] Inspect coverage with `go tool cover -func=coverage.out`.

## Acceptance Criteria

- [x] `sam status` succeeds and shows project detail plus recent active chats.
- [x] `sam chat` succeeds and lists chats.
- [x] `sam chat <sessionId>` fetches the correct session detail route and renders messages.
- [x] `sam ideas` remains working.
- [x] `sam library` displays correct file size/source/timestamp and has clear recursive/all-files behavior or an explicit non-misleading root-only default.
- [x] `sam context` succeeds and displays entity name/type/observation count/updated time.
- [x] `sam notifications` keeps table rows single-line/readable for multiline titles.
- [x] `sam triggers` displays useful schedule and next run from current API fields.
- [x] `sam profiles` reads `{ items: [...] }` and lists profiles.
- [x] `sam activity` succeeds and displays event type, useful payload summary, and timestamp.
- [x] `sam nodes` succeeds against raw array response and uses current node fields (`cloudProvider`, `vmLocation`, `ipAddress`).
- [x] Successful `--json` output is valid JSON for all fixed commands.
- [x] Decode errors include safe actionable context and do not leak cookies/tokens.

## References

- `packages/cli/internal/cli`
- `apps/api/src/routes/chat.ts`
- `apps/api/src/routes/library.ts`
- `apps/api/src/routes/knowledge.ts`
- `apps/api/src/routes/notifications.ts`
- `apps/api/src/routes/agent-profiles.ts`
- `apps/api/src/routes/activity.ts`
- `apps/api/src/routes/nodes.ts`
- `apps/api/src/routes/triggers/crud.ts`
- `packages/shared/src/types`
- `.claude/rules/36-cli-quality.md`
- `docs/notes/2026-05-19-cli-sonar-quality-gap-postmortem.md`
- `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md`
- `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md`
