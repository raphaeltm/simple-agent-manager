# Refactor handleFileList to Avoid Shell String Interpolation

## Problem

In `packages/vm-agent/internal/server/files.go`, `handleFileList` constructs a `find` command as a shell string using `fmt.Sprintf` with `%q` quoting and passes it to `sh -c`. While `sanitizeFilePath` rejects most injection attempts, `%q` does not escape all shell metacharacters (e.g., `$()`, backticks). Other git handlers in the same file pass arguments directly to `execInContainer` without shell interpolation, which is the safer pattern.

## Context

Discovered during security audit of PR implementing file browsing & diff views in project chat (2026-03-28). The file listing handler is the only handler that builds a shell command string — all git handlers pass paths as separate arguments.

## Acceptance Criteria

- [ ] `handleFileList` passes `find` as a direct command with path as a separate argument to `execInContainer`
- [ ] `| head -n` limit is handled in Go by truncating the output slice, not via shell piping
- [ ] OR: `sanitizeFilePath` is enhanced to reject `$`, backtick, `!`, and `(` characters
- [ ] Existing file listing tests continue to pass
