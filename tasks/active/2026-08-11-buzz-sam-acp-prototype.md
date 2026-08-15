# Buzz ↔ SAM ACP Prototype

## Problem

Raphaël wants a deliberately throwaway proof of concept showing that Buzz can
spawn a local ACP agent process whose conversation actually runs remotely in a
specified SAM project/profile. This is not the production `sam acp` design and
must stay outside `packages/cli` and production build surfaces.

Full design/research context is in SAM idea `01KZPTT49W10FC1P9G9RQEK8M1`.

## Current Research Findings

- `experiments/` is the repository's explicit home for self-contained,
  deletable prototypes and is excluded from the production build
  (`experiments/README.md`).
- Current CLI auth is stored as JSON with `apiUrl`, `sessionCookie`, and
  optional active-project fields. Resolution uses `SAM_CONFIG_DIR`, then
  `XDG_CONFIG_HOME/sam`, then `~/.config/sam/config.json`
  (`packages/cli/internal/cli/config.go`, `types.go`). The prototype can reuse
  the cookie written by `sam auth login` without changing the Go CLI.
- The current submit contract is `POST
/api/projects/:projectId/tasks/submit` with `{message, taskMode:
"conversation", agentProfileId}` and a `202` response containing `taskId`,
  `sessionId`, `branchName`, and `status` (`apps/api/src/schemas/tasks.ts`,
  `apps/api/src/routes/tasks/submit.ts`,
  `packages/shared/src/types/task.ts`).
- Current follow-up and cancellation routes are `POST
/sessions/:sessionId/prompt` with `{content}` and `POST
/sessions/:sessionId/cancel`. Persisted state and messages are available at
  `GET /state` and `GET /messages` (`apps/api/src/routes/chat.ts`,
  `chat-state.ts`). State exposes `idle`, `prompting`, `recovering`, `error`, or
  `stopped`; messages are token/delta rows and can be filtered to assistant
  roles (`packages/shared/src/types/session.ts`).
- Buzz `main` still loads custom camelCase `HarnessDefinition` JSON files and
  spawns arbitrary commands. Its ACP client currently requests protocol version
  2 and requires `initialize`, `session/new`, blocking `session/prompt`, and a
  notification-only `session/cancel`. Agent text notifications use
  `session/update` with an `agent_message_chunk` update, and prompt completion
  must return a recognized `stopReason`.
- Polling cannot give production-grade turn boundaries. This spike will combine
  persisted `prompting/recovering → idle` state with a bounded message quiet
  period, document the ambiguity prominently, and fail on terminal/error states
  or timeout. A real implementation must not reuse this heuristic.
- The parent-session decision explicitly excludes channel/session persistence,
  automatic resume/rebind/fork, WebSockets, terminal JWTs, and the production
  CLI quality bar. Those are constraints, not future work for this PR.

## Implementation Checklist

- [x] Add a dependency-free executable Node script under
      `experiments/buzz-sam-acp/`.
- [x] Implement stdio NDJSON JSON-RPC handling for `initialize`, `session/new`,
      `session/prompt`, and `session/cancel`.
- [x] Bind one process to `SAM_PROJECT_ID` and `SAM_AGENT_PROFILE_ID`; reuse the
      current SAM CLI cookie config with documented env overrides.
- [x] Lazily submit the first prompt as a conversation-mode task, use session
      HTTP endpoints for later prompt/cancel, and poll persisted state/messages for
      assistant deltas and turn completion.
- [x] Fail visibly on invalid input, API errors, terminal SAM state, missing
      output, and timeout. Never transparently create or fork a replacement.
- [x] Add prominent shortcut warnings in code and README covering robust turn
      boundaries, durable channel/session binding, runtime-neutral dormant resume
      with harness files + git WIP restoration, and fork only as a
      degradation/branching fallback.
- [x] Add a Buzz custom `HarnessDefinition` JSON template and concise setup/run
      demo instructions.
- [x] Add a local fake-server/transcript smoke test covering first prompt,
      follow-up prompt, assistant notifications, cancellation, and request shapes.
- [x] Keep the executable below the source-file review threshold by separating
      configuration, SAM API, and Buzz CLI process concerns into small local modules.
- [x] Allowlist the Buzz child environment, enforce HTTPS except for loopback
      tests, and bound/clean up the Buzz CLI process on timeout.
- [x] Run proportional syntax/smoke validation, targeted reviewers, and local PR
      evidence checks. Do not deploy to staging.
- [x] Push the assigned branch and open draft PR #1805. Do not merge.

## Acceptance Criteria

- `node --check` succeeds for the prototype and smoke test.
- The transcript smoke test proves Buzz-shaped requests produce valid ACP
  responses while the expected SAM control-plane requests hit a fake server.
- No production package imports the experiment, no WebSocket/terminal-token
  path is used, and no dependency is added.
- README and comments name every intentional lifecycle/turn-boundary shortcut
  and reference SAM idea `01KZPTT49W10FC1P9G9RQEK8M1`.
- The branch is pushed and an unmerged draft PR exists for inspection; staging
  is explicitly recorded as skipped by user instruction.

## References

- `experiments/README.md`
- `packages/cli/internal/cli/config.go`
- `packages/cli/internal/cli/types.go`
- `apps/api/src/schemas/tasks.ts`
- `apps/api/src/routes/tasks/submit.ts`
- `apps/api/src/routes/chat.ts`
- `apps/api/src/routes/chat-state.ts`
- `packages/shared/src/types/session.ts`
- SAM idea `01KZPTT49W10FC1P9G9RQEK8M1`
