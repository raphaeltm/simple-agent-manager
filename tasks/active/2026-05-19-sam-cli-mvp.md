# SAM CLI MVP

## Problem

SAM needs a local command-line entry point so developers can start conversations and submit tasks from terminals, IDE shells, and automation without using the web UI for every interaction.

This first slice should be conservative: a thin authenticated API client around existing SAM routes, with local config/auth storage and clear documentation. It should avoid embedding the harness or introducing new API authentication architecture until the core terminal workflows are proven.

## Research Findings

- Idea `01KRX983Z34GSB2HBF9JF5SYJK` asks for a lightweight CLI named `sam` or `smallpath` that can start conversations, submit tasks, monitor progress, and eventually interact with MCP.
- Existing task submit API already provides the highest-value entry point: `POST /api/projects/:projectId/tasks/submit` in `apps/api/src/routes/tasks/submit.ts`.
- Existing task status API is `GET /api/projects/:projectId/tasks/:taskId` in `apps/api/src/routes/tasks/crud.ts`.
- Existing chat session detail API is `GET /api/projects/:projectId/sessions/:sessionId` in `apps/api/src/routes/chat.ts`.
- Existing follow-up prompt API is `POST /api/projects/:projectId/sessions/:sessionId/prompt` in `apps/api/src/routes/chat.ts`.
- Current user-facing API auth is BetterAuth session-cookie based through `requireAuth()` in `apps/api/src/middleware/auth.ts`; there is no general personal access token API yet.
- Relevant auth lesson: `docs/notes/2026-03-08-mcp-token-revocation-postmortem.md` warns against credential lifecycle mismatches. The CLI should document session-cookie auth as an MVP bridge, not pretend it is a durable PAT design.
- Workspace package pattern supports a new package under `packages/*` via `pnpm-workspace.yaml`.

## Implementation Checklist

- [ ] Add a new `@simple-agent-manager/cli` workspace package with a `sam` bin entrypoint.
- [ ] Implement config loading/saving with explicit file permissions and env overrides for API URL and auth cookie.
- [ ] Implement HTTP client helpers that send the stored cookie, parse JSON errors, and avoid logging secrets.
- [ ] Implement `sam auth login --api-url <url> --session-cookie <cookie>` and `sam auth status`.
- [ ] Implement `sam task submit <projectId> <message>` with options for conversation/task mode and common task submit fields.
- [ ] Implement `sam task status <projectId> <taskId>`.
- [ ] Implement `sam chat <projectId> <message>` as a conversation-mode submit plus optional follow-up support via `--session <sessionId>`.
- [ ] Add focused unit tests for command parsing, config safety, request construction, and response formatting.
- [ ] Document the CLI MVP, auth limitations, and example commands.
- [ ] Run package and repo quality checks.
- [ ] Run specialist reviews required by `/do`: task completion, security, docs sync, constitution, and test engineering.
- [ ] Create/update PR, monitor CI/checks, and stop before merge.

## Acceptance Criteria

- A developer can configure the CLI with an API URL and session cookie without the cookie being printed back in normal output.
- `sam task submit` calls the existing task submit API and prints the returned task/session/branch identifiers.
- `sam task status` fetches and displays current task status, execution step, output branch, PR URL, and errors when present.
- `sam chat` submits a conversation-mode task, and can send a follow-up prompt to an existing session when `--session` is provided.
- Tests cover config storage, auth redaction, command routing, and request payloads.
- Documentation explains this is an MVP session-cookie bridge and does not claim PAT/device-flow support exists yet.
- PR is opened and checks are monitored, but it is not merged.
