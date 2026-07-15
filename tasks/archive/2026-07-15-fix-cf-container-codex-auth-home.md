# Fix cf-container Codex auth-file home resolution

## Problem Statement

Instant Cloudflare container (`cf-container`) sessions can start `openai-codex`
with a valid SAM/Codex credential but fail ACP `NewSession` with:

`ACP new session failed: {"code":-32000,"message":"Authentication required"}`

The failed user session was `7b7cb07b-61a5-4835-8565-0bbac5c1bb34`.
Local Codex auth is known to work, so the likely failure is specific to the
standalone Cloudflare container runtime path.

## Research Findings

- The parent session `145fb199-ef2b-4a4f-b260-cf8301b71ce2` ended with PR
  #1565 merged and verified for a real `cf-container` smoke session, but that
  smoke used the generic instant path and did not prove Codex auth-file home
  placement.
- The failed session contains a system message:
  `Agent startup failed: ACP new session failed: {"code":-32000,"message":"Authentication required"}`.
- `packages/vm-agent/internal/acp/gateway.go` correctly treats
  `authFilePath` as relative to `$CODEX_HOME` or the container user's `$HOME`
  for the Docker/devcontainer path via `resolveAuthFileTargetPath()`.
- `packages/vm-agent/internal/acp/session_host_startup.go` bypasses that helper
  when `containerID == ""` (standalone/cf-container mode) and writes
  `.codex/auth.json` under `ContainerWorkDir`. Codex expects
  `~/.codex/auth.json` or `$CODEX_HOME/auth.json`, so ACP can launch without
  seeing the injected credential.
- `apps/api/Dockerfile.vm-agent-container` runs as `USER node` with workdir
  `/workspaces`; it does not set `CODEX_HOME`, so the default target should be
  the runtime user's home directory, not the workspace.
- Relevant prior lessons:
  - `tasks/archive/2026-04-02-fix-codex-acp-home-directory-resolution.md`
  - `tasks/archive/2026-07-11-unified-agent-installation.md`
  - `tasks/archive/2026-07-10-unify-sam-aware-acp-bootstrap.md`

## Implementation Checklist

- [x] Add standalone/local auth-file target path resolution that mirrors the
      container behavior: validate relative paths, honor `$CODEX_HOME` for
      `.codex/...`, otherwise resolve under `os.UserHomeDir()`/`$HOME`.
- [x] Update local auth-file injection to write Codex OAuth credentials to the
      resolved home/CODEX_HOME path instead of `ContainerWorkDir`.
- [x] Preserve `0600` file permissions and `0700` parent directory permissions.
- [x] Add focused Go regression coverage proving standalone Codex OAuth writes
      to home/CODEX_HOME and does not create workspace-local `.codex/auth.json`.
      Direct resolver tests also cover non-Codex auth-file paths and invalid path rejection.
- [x] Run focused VM-agent ACP tests.
- [x] Run repository validation required by `/do`.

## Validation Evidence

- `pnpm lint` — passed with existing warnings only.
- `pnpm typecheck` — passed.
- `pnpm test` — passed: 19 task targets; API 422 files / 6062 tests; web
  219 files / 2685 tests.
- `pnpm build` — passed.
- `git diff --check` — passed.
- `/tmp/go1.25.0/bin/go test ./internal/acp -run TestPrepareAgentStartupStandaloneCodexOAuth -count=1` — passed.
- `/tmp/go1.25.0/bin/go test ./internal/acp -count=1` — passed.
- `/tmp/go1.25.0/bin/go vet ./internal/acp` — passed.
- `/tmp/go1.25.0/bin/go test -race ./internal/acp -run TestPrepareAgentStartupStandaloneCodexOAuth -count=1` — passed.
- `/tmp/go1.25.0/bin/go test ./internal/acp -run 'TestPrepareAgentStartupStandaloneCodexOAuth|TestResolveLocalAuthFileTargetPath' -count=1` — passed.
- `/tmp/go1.25.0/bin/go test ./...` from `packages/vm-agent` — attempted;
  packages unrelated to this change failed because this environment does not have
  Docker or Docker Compose (`internal/pty` tests require `docker`;
  `internal/server` tests require Docker Compose). The touched package passed.

## Remaining Workflow Gates

These are tracked in `.do-state.md` after implementation validation and are not
part of the archived implementation checklist:

- Run local specialist reviews: task-completion-validator,
  cloudflare-specialist, go-specialist, security-auditor, constitution-validator,
  and test-engineer.
- Deploy to staging and verify a real instant `cf-container` `openai-codex`
  session starts and responds.
- Open PR, wait for CI, merge when green, monitor production deployment.

## Acceptance Criteria

- Standalone/cf-container Codex OAuth auth-file injection writes to the same
  effective location Codex reads from (`$CODEX_HOME/auth.json` or
  `~/.codex/auth.json`).
- The workspace directory is not used as the fallback home for Codex auth files.
- Existing Docker/devcontainer auth-file injection behavior is preserved.
- A regression test fails on the previous workspace-relative behavior.
- A real staging `cf-container` Codex session no longer fails `NewSession` with
  `Authentication required` (manual Phase 6 gate tracked in `.do-state.md`).

## References

- Previous session: `145fb199-ef2b-4a4f-b260-cf8301b71ce2`
- Failed session: `7b7cb07b-61a5-4835-8565-0bbac5c1bb34`
- Parent task: `01KXKAYK081845MBHC6TFXPT3Q`
- PR #1565: unified agent installation and startup failure reconciliation
- `.claude/rules/14-do-workflow-persistence.md`
- `.claude/rules/32-cf-api-debugging.md`
- `.claude/rules/35-vertical-slice-testing.md`
