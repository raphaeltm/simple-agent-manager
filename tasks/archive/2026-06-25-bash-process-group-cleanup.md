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

- [x] Add a deterministic regression test proving a successful Bash command with a background child does not leave that child alive after `Execute` returns.
- [x] Ensure the regression test cleans up any spawned process if the assertion fails.
- [x] Harden `Bash.Execute` so it always targets only the command's own process group for cleanup after success, non-zero exit, timeout, and cancellation.
- [x] Preserve existing stdout/stderr capture, truncation markers, exit-code reporting, timeout errors, and cancellation errors.
- [x] Treat already-exited process groups as non-noisy cleanup outcomes.
- [x] Validate `Bash.WorkDir` with the existing workspace-boundary validation instead of silently cleaning an empty value to `.`.
- [x] Add or adjust Bash WorkDir tests for empty and invalid WorkDir behavior.
- [x] Add a narrow process-rule update requiring success-path child cleanup coverage for shell/process lifecycle bugs.
- [x] Run `gofmt` and focused Go tests from `packages/harness`.
- [x] Run required specialist reviews: `$go-specialist`, `$security-auditor`, `$test-engineer`, and `$task-completion-validator`.

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
- **Process fix:** Added a focused regression test for successful background-child cleanup and updated `.claude/rules/02-quality-gates.md` so future shell/process lifecycle bug fixes must cover the success path and prove children are not left alive after return.

## Validation Evidence

- `go test ./tools -count=1` passed in `packages/harness`.
- `go test ./... -count=1` passed in `packages/harness`.
- Regression proof: temporarily reversed only the `packages/harness/tools/bash.go` implementation change and ran `go test ./tools -run TestBash_CleansSuccessfulBackgroundChild -count=1`; it failed with `background child pid ... is still alive after Bash.Execute returned`.
- `go test -race ./tools -count=1` passed in `packages/harness`.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` passed at the repo root. `pnpm lint` emitted existing warnings only.
- PR CI initially failed the preflight-evidence job because the PR body was missing the required agent preflight marker block. The PR body was updated with bounded preflight evidence and this task record was amended to trigger a fresh pull request event for CI validation.

## Specialist Review Evidence

### Task Completion Validator

Verdict: PASS.

| Check | Status | Issues |
|-------|--------|--------|
| A: Research -> Checklist | PASS | 0 uncovered findings |
| B: Checklist -> Diff | PASS | 0 checked items without diff coverage |
| C: Criteria -> Tests | PASS | 0 uncovered acceptance criteria |
| D: UI -> Backend | N/A | No UI changes |
| E: Multi-Resource | N/A | No multi-resource selection |
| F: Vertical Slice | N/A | Single-package harness tool behavior |

Findings: none.

### Go Specialist

Verdict: PASS. `Bash.Execute` now validates WorkDir before execution (`packages/harness/tools/bash.go:50`), creates a process group (`packages/harness/tools/bash.go:65`), uses `cmd.Cancel` for cancellation cleanup (`packages/harness/tools/bash.go:67`), and always performs post-run process-group cleanup (`packages/harness/tools/bash.go:77`). `killProcessGroup` targets only the negative process ID for this command's process group and treats already-exited groups as clean (`packages/harness/tools/bash.go:116`). No Go correctness or resource-leak findings.

### Security Auditor

Verdict: PASS. The change does not add credential handling, auth, networking, or new external trust boundaries. It improves boundary safety by rejecting empty/invalid WorkDir (`packages/harness/tools/bash.go:50`, `packages/harness/tools/builtin_test.go:208`) and limits cleanup to the process group created for the command (`packages/harness/tools/bash.go:65`, `packages/harness/tools/bash.go:120`). Existing Bash arbitrary-command risk remains explicitly documented in the tool comment and is unchanged.

### Test Engineer

Verdict: PASS. The regression test uses a deterministic PID-file pattern and cleanup hook (`packages/harness/tools/builtin_test.go:234`) and was verified to fail against the old implementation. Existing behavior coverage for simple output, timeout, cancellation, non-zero exit, working directory, and truncation remains in place (`packages/harness/tools/builtin_test.go:128`, `packages/harness/tools/builtin_test.go:142`, `packages/harness/tools/builtin_test.go:156`, `packages/harness/tools/builtin_test.go:178`, `packages/harness/tools/builtin_test.go:192`, `packages/harness/tools/builtin_test.go:407`). Empty and invalid WorkDir tests cover the new validation (`packages/harness/tools/builtin_test.go:208`, `packages/harness/tools/builtin_test.go:221`).

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
