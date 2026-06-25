# Bash process group cleanup

## Problem Statement

The harness `Bash` tool starts `bash -c <command>` in a new process group, but it only attempts process-group cleanup after `cmd.Run()` returns and only when the context is cancelled. A successful shell command can still leave background children alive, for example `sleep 60 & echo done`. The agent loop calls tools synchronously through `registry.Dispatch`, so those leaked children are invisible to the transcript and to later lifecycle handling.

This fails the quality bar for an agent harness that executes LLM-provided commands. A tool invocation must own the process group it creates and clean it up after success, non-zero exit, timeout, and explicit cancellation.

## Spot-Check Scope

- Reviewed bounded harness tool slice: `packages/harness/tools/*`.
- Reviewed immediate call site: `packages/harness/agent/loop.go`.
- This is not a whole-package or single-file review.
- Recent completed-task history shows the last CTO spot check covered `packages/shared/src/composable-credentials`, with other recent review work focused on deployment, custom domains, terminal tabs, notifications, and `/do` workflow quality. This task intentionally avoids those scopes.

## Research Findings

- `packages/harness/tools/bash.go` sets `SysProcAttr{Setpgid: true}` and `WaitDelay`, but `cmd.Run()` is the lifecycle boundary. Cleanup is conditional on `ctx.Err() != nil`, so successful commands with background children are not cleaned up.
- `packages/harness/tools/builtin_test.go` covers normal Bash output, timeout, cancellation, non-zero exit, working directory, and truncation, but it does not cover successful commands that spawn background children.
- `packages/harness/tools/boundary.go` has the strict WorkDir validation pattern used by file/search tools: empty WorkDir is rejected, symlinks are resolved, and the root must exist and be a directory.
- `packages/harness/agent/loop.go` dispatches tool calls synchronously via `registry.Dispatch`; leaked background children do not appear in the agent loop result or transcript.
- Archived task `tasks/archive/2026-06-06-harden-harness-tool-boundaries.md` hardened harness tool filesystem boundaries and Bash output limits, but did not cover Bash process-group lifecycle cleanup.

## Implementation Checklist

- [ ] Add a deterministic regression test proving a successful Bash command with a background child does not leave that child alive after `Execute` returns.
- [ ] Ensure the regression test cleans up any spawned process if the assertion fails.
- [ ] Harden `Bash.Execute` so it always targets only the command's own process group for cleanup after success, non-zero exit, timeout, and cancellation.
- [ ] Preserve existing stdout/stderr capture, truncation markers, exit-code reporting, timeout errors, and cancellation errors.
- [ ] Treat already-exited process groups as non-noisy cleanup outcomes.
- [ ] Validate `Bash.WorkDir` with the existing workspace-boundary validation instead of silently cleaning an empty value to `.`.
- [ ] Add or adjust Bash WorkDir tests for empty and invalid WorkDir behavior.
- [ ] Run `gofmt` and focused Go tests from `packages/harness`.
- [ ] Run required specialist reviews: `$go-specialist`, `$security-auditor`, `$test-engineer`, and `$task-completion-validator`.

## Acceptance Criteria

- `go test ./tools` passes in `packages/harness`.
- `go test ./...` passes in `packages/harness` unless an unrelated pre-existing failure is verified and documented with exact output.
- The new regression test demonstrates background child cleanup and would have caught the original issue.
- Existing Bash behavior for normal output, non-zero exit, timeout, cancellation, and truncation remains covered and passing.
- The task file documents the spot-check scope, why this failed the quality bar, and why the fix is bounded.
- A PR is opened for the implementation branch and merged when green unless blocked by required checks or credentials.
- No staging deployment is performed for this Go harness-only change unless the repository workflow explicitly requires it.

## Post-Mortem

- **What broke:** A Bash tool call could return success while leaving a background child running in the command's process group.
- **Root cause:** Cleanup was tied to context cancellation after `cmd.Run()` returned, rather than unconditional ownership cleanup for the process group created by the command.
- **Timeline:** The harness Bash tool was introduced as part of the Go harness spike, later hardened for filesystem boundaries and output limits, but no lifecycle regression test covered background children after successful shell exit.
- **Why it was not caught:** Tests exercised foreground command timeout and cancellation but not the invariant that a completed tool call must leave no child processes behind.
- **Class of bug:** Runtime lifecycle boundary bug where success-path cleanup is missing for resources spawned outside Go's direct child process handle.
- **Process fix:** Add a focused regression test for successful background-child cleanup and include this lifecycle invariant in the task acceptance evidence for Bash tool changes.

## References

- `packages/harness/tools/bash.go`
- `packages/harness/tools/builtin_test.go`
- `packages/harness/tools/tool.go`
- `packages/harness/tools/boundary.go`
- `packages/harness/agent/loop.go`
- `.agents/skills/go-specialist/SKILL.md`
- `.agents/skills/security-auditor/SKILL.md`
- `.agents/skills/test-engineer/SKILL.md`
- `.agents/skills/task-completion-validator/SKILL.md`
