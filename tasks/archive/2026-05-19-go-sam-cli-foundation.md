# Go SAM CLI Foundation

## Problem

The current `@simple-agent-manager/cli` package is a thin TypeScript API client. That was useful for proving terminal access to SAM, but it is the wrong foundation for where the product CLI is heading.

The CLI should eventually let a user do most actions reachable from the app's nav menus, scoped to a selected project when appropriate. It should also leave room for future native harness execution and local runner lifecycle management. Go is a better fit for that long-term shape because SAM already has Go runtime components (`packages/vm-agent/` and `packages/harness/`), runner installation needs host/OS checks, and a single binary is easier to distribute than a Node-based CLI.

This task is the first production-safe slice: replace the TypeScript CLI implementation with a Go CLI foundation that preserves the existing MVP behavior, introduces the future command vocabulary, and adds a non-mutating runner preflight command. It must not pretend that full runner registration or local harness execution exists before the API/security contracts are implemented.

## Detailed Idea

The CLI should be organized around product surfaces rather than implementation details:

```bash
sam auth login --api-url https://api.example.com --session-cookie-stdin
sam auth status

sam --project=01PROJECT tasks dispatch \
  --agent=sam \
  --mode=task \
  --workspace=lightweight \
  --prompt="manage the development of idea 123DSFD8902"

sam --project=01PROJECT task submit "legacy-compatible prompt"
sam --project=01PROJECT task status 01TASK
sam --project=01PROJECT chat "quick conversation prompt"
sam --project=01PROJECT chat --session 01SESSION "follow up"

sam runner doctor
sam runner install      # future mutating command
sam runner register     # future API-backed command

sam harness run ...     # future local native harness command
```

The near-term command model should keep the remote control plane path explicit. `tasks dispatch` should call the existing `POST /api/projects/:projectId/tasks/submit` API and map options to the current request body. `task submit` can remain as a compatibility alias for the merged CLI MVP, but docs should point users toward `tasks dispatch` as the durable vocabulary.

The `--model` flag from the longer-term command sketch should be reserved, but not sent in this slice: the current task submit schema does not accept a per-dispatch model override. Until that API contract exists, model choice should flow through `--agent-profile`.

Runner support should start with `sam runner doctor`, a read-only preflight that checks host requirements for a machine that might become a SAM runner. It should detect Docker availability, operating system, architecture, systemd availability, and whether `vm-agent` is already present. `runner install` and `runner register` should be documented as planned commands, not implemented as no-op success paths. Registration needs a real API design for node credentials and callback-token lifecycle before it can be safe.

Harness support should be reserved under `sam harness`, but deferred from this first slice. The CLI should be written in Go so it can later import or compose with `packages/harness` without TypeScript process wrapping, but local harness execution should not be blended into remote `task dispatch` semantics.

## Research Findings

- Current CLI package lives in `packages/cli/` and exposes a `sam` bin through `package.json`.
- Existing CLI commands are `auth login`, `auth status`, `task submit`, `task status`, and `chat`.
- Existing CLI docs explicitly say the current slice does not include local harness execution, MCP client behavior, PAT auth, or device flow.
- Existing task submission route is `POST /api/projects/:projectId/tasks/submit` in `apps/api/src/routes/tasks/submit.ts`.
- Existing task status route is `GET /api/projects/:projectId/tasks/:taskId` in `apps/api/src/routes/tasks/crud.ts`.
- Existing session prompt route is `POST /api/projects/:projectId/sessions/:sessionId/prompt` in `apps/api/src/routes/chat.ts`.
- Existing session detail route is `GET /api/projects/:projectId/sessions/:sessionId` in `apps/api/src/routes/chat.ts`.
- API reference lists nav-relevant surfaces for projects, tasks, sessions, nodes, workspaces, credentials, GitHub, and agent settings.
- Node management routes currently support creating/listing/stopping/deleting hosted nodes, but there is no explicit user-owned local runner registration endpoint yet.
- `packages/vm-agent/` and `packages/harness/` are separate Go modules, not a shared Go workspace today.
- The current devcontainer declares a Go feature, but this workspace instance does not have `go` on PATH. Go validation must be run in CI or a corrected devcontainer unless the local toolchain is installed during the task.
- `docs/notes/2026-03-08-mcp-token-revocation-postmortem.md` warns against credential lifecycle mismatches. This matters for future runner registration tokens and CLI auth.
- `docs/notes/2026-03-06-heartbeat-token-expiry-postmortem.md` warns that node callback tokens need renewal, not one-time finite credentials. This matters for user-registered runners.
- `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md` warns VM-agent callback routes need separate auth routing and combined-route tests.
- `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md` warns against documenting aspirational agent execution as implemented. This task must clearly separate implemented CLI behavior from future harness/runner commands.

## Implementation Checklist

- [x] Replace the TypeScript CLI implementation in `packages/cli` with a Go module and `cmd/sam` entrypoint while keeping the package path stable.
- [x] Preserve existing auth config behavior: `SAM_API_URL`, `SAM_SESSION_COOKIE`, `SAM_CONFIG_DIR`, `XDG_CONFIG_HOME`, `~/.config/sam/config.json`, session cookie stdin, restrictive config file permissions, and redacted status output.
- [x] Preserve existing API client behavior for task submit/status, chat submit, and session prompt follow-up.
- [x] Add global `--project` support so project-scoped commands can accept the project once instead of repeating it positionally.
- [x] Add `tasks dispatch` as the forward-looking task submission command with flags for `--agent`, `--agent-profile`, `--mode`, `--workspace`, `--vm-size`, `--vm-location`, `--provider`, `--node`, `--parent-task`, `--context-summary`, `--devcontainer-config`, and `--prompt`; reserve `--model` with a clear error until the server accepts a per-dispatch model field.
- [x] Keep `task submit`, `task status`, and `chat` compatibility commands so existing users do not lose the MVP workflow.
- [x] Add `runner doctor` as a non-mutating host preflight command that reports OS, architecture, Docker CLI availability, Docker daemon availability, systemd availability, and installed `vm-agent` presence.
- [x] Make `runner install`, `runner register`, and `harness` commands fail clearly with planned-command messaging instead of silently succeeding.
- [x] Provide machine-readable `--json` output for commands that currently expose structured data and for `runner doctor`.
- [x] Port focused tests from the TypeScript CLI to Go tests, covering config, redaction, argument routing, request payload construction, error formatting, and runner doctor dependency injection.
- [x] Update `docs/cli.md` to describe the Go CLI, command model, compatibility aliases, runner roadmap, and harness roadmap without claiming unimplemented behavior.
- [x] Update CI/workflow configuration if needed so Go CLI tests run when `packages/cli/**` changes.
- [x] Remove TypeScript CLI build/test/lint artifacts that no longer apply and update lock/workspace metadata accordingly.
- [x] Run relevant validation: Go tests for CLI, repo lint/typecheck/test/build where applicable, and targeted documentation checks.
- [x] Run required specialist reviews before PR: task-completion-validator, go-specialist, security-auditor, doc-sync-validator, constitution-validator, and test-engineer.

## Acceptance Criteria

- `sam auth login`, `sam auth status`, `sam task submit`, `sam task status`, and `sam chat` still work with equivalent behavior to the merged CLI MVP.
- `sam --project=<id> tasks dispatch --prompt=<message>` calls the existing task submit API with the expected JSON body.
- Dispatch flags map to current task-submit fields without inventing unsupported API behavior.
- `sam runner doctor` produces useful terminal and JSON output without mutating the host.
- `sam runner install`, `sam runner register`, and `sam harness ...` do not claim success; they clearly explain that the command is planned and what contract is missing.
- Documentation gives users a clear mental model: remote SAM control-plane commands now, local runner/harness commands later.
- Tests cover the command parser, config/auth handling, API request construction, error formatting, and runner doctor checks.
- No session cookies, callback tokens, or auth headers are printed in normal or error output.
- The implementation does not add production runner registration or local harness execution without the corresponding API and security lifecycle design.

## References

- `docs/cli.md`
- `packages/cli/`
- `packages/harness/README.md`
- `packages/vm-agent/AGENTS.md`
- `apps/api/src/routes/tasks/submit.ts`
- `apps/api/src/routes/tasks/crud.ts`
- `apps/api/src/routes/chat.ts`
- `apps/api/src/routes/nodes.ts`
- `.claude/skills/api-reference/SKILL.md`
- `.claude/rules/06-api-patterns.md`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/23-cross-boundary-contract-tests.md`
- `.claude/rules/34-vm-agent-callback-auth.md`
- `docs/notes/2026-03-08-mcp-token-revocation-postmortem.md`
- `docs/notes/2026-03-06-heartbeat-token-expiry-postmortem.md`
- `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md`
- `docs/notes/2026-02-28-missing-initial-prompt-postmortem.md`

## Validation

- `packages/cli`: `go test ./...` passed.
- `packages/cli`: `go build -o /tmp/sam-cli-test ./cmd/sam` passed.
- Repository: `pnpm lint` passed with existing warnings only.
- Repository: `pnpm typecheck` passed.
- Repository: `pnpm test` passed.
- Repository: `pnpm build` passed when rerun sequentially. An earlier concurrent `pnpm build` plus `pnpm test` run failed in `apps/www/dist/noop-entrypoint.mjs`, consistent with both commands building the same `apps/www/dist` output at once.
- Repository: `git diff --check` passed.

## Local Specialist Review Results

The user requested that `/do` not dispatch work, so the required reviews were applied locally using the skill checklists.

### Task Completion Validator

Verdict: PASS.

| Check | Status | Notes |
| --- | --- | --- |
| A: Research to checklist | PASS | Research findings are reflected in checklist items or explicit deferrals. |
| B: Checklist to diff | PASS | Checked items map to substantive changes in `packages/cli`, `docs/cli.md`, `.github/workflows/ci.yml`, and `pnpm-lock.yaml`. |
| C: Criteria to tests | PASS | CLI command parsing, config/auth redaction, API request payloads, planned command failures, and runner doctor behavior have Go tests; full repo validation passed. |
| D: UI to backend | N/A | No UI inputs were added. |
| E: Multi-resource selection | N/A | No provider/resource selector lookup was added. |
| F: Vertical slice coverage | PASS | CLI-to-HTTP boundary is tested with injected `HTTPDoer` and captured request paths, headers, and payloads. |

### Go Specialist

Verdict: PASS. The Go code is scoped to `packages/cli`, not the VM agent PTY/WebSocket/JWT code paths. Review focused on Go idioms, context propagation, resource handling, command execution, and error handling. No blocking findings. HTTP responses are closed, host checks use injected dependencies, command execution uses `exec.CommandContext`, and library code returns errors instead of panicking.

### Security Auditor

Verdict: PASS. The CLI continues to treat the BetterAuth session cookie as a bearer secret. Auth status and login output redact cookies, API errors are parsed without echoing request headers, config files are written with `0600` permissions after a `0700` config directory, and runner/harness mutating commands fail instead of fabricating credentials or registration.

### Documentation Sync Validator

Verdict: PASS. `docs/cli.md` matches the implemented Go CLI behavior and explicitly separates implemented remote SAM commands from deferred PAT/device-flow auth, runner install/register, and local harness execution. It now also documents that `--model` is reserved until the submit API accepts a per-dispatch model field.

### Constitution Validator

Verdict: PASS. No internal hardcoded service URLs, timeouts, limits, or deployment-specific identifiers were added. API origins come from `--api-url`, `SAM_API_URL`, or saved config. Hardcoded `/api/...` path segments are protocol routes for the API client, not deployment origins. Example `https://api.example.com` values appear only in docs/tests.

### Test Engineer

Verdict: PASS. Go tests cover parser routing, auth config and redaction, API request construction/error handling, planned-command failures, and runner doctor dependency injection. This slice does not modify the app UI or server task-submit route, so no new Worker/UI vertical slice test was required.
