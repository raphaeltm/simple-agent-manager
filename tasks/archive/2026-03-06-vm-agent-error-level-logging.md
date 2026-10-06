# VM Agent Logs Informational Events as Error Level

## Problem

The VM agent reports lifecycle events like "Agent ready", "ACP NewSession succeeded", "ACP Initialize succeeded", "ACP Prompt started", "ACP Prompt completed" at `error` log level. These are normal success events that should be `info` level.

This pollutes the Admin Errors view with false positives, making it harder to identify real errors.

## Context

- Discovered during staging testing on 2026-03-06 via Admin > Errors tab
- 48 "errors" in last 24h, majority are informational lifecycle events
- Only actual error was "ACP Prompt failed" (which was caused by wrong model config, now fixed)

## Acceptance Criteria

- [x] VM agent lifecycle events logged at appropriate levels:
  - `info`: Agent ready, ACP Initialize succeeded, ACP NewSession succeeded, Agent credential fetched, Agent selection started, Agent binary verified/installed
  - `info`: ACP Prompt started, ACP Prompt completed (success)
  - `warn`: ACP Prompt failed (non-fatal)
  - `error`: Only for actual failures that require attention
- [x] Admin Errors view shows mostly real errors after fix

## Implementation Notes

- Lifecycle events (Agent ready, ACP Initialize/NewSession/Prompt started/completed, etc.) were already logged at `slog.Info` level via `reportLifecycle()` calls. No changes needed for those.
- Changed `slog.Error("ACP Prompt failed")` to `slog.Warn` since prompt failures are non-fatal and recoverable.
- Changed non-critical persistence failures (ACP session ID, last prompt) from `slog.Error` to `slog.Warn` since they don't block agent operation.
- Changed agent settings fetch failures from `slog.Error` to `slog.Warn` since the function returns nil and the caller continues with defaults.
- Changed viewer write failure from `slog.Error` to `slog.Warn` since a single viewer disconnect is non-fatal.
- Kept `slog.Error` for actual failures: credential fetch failed, agent install failed, agent start failed, agent crash, agent restart failed, stdin write failed, parse failures, marshal failures for core operations.
