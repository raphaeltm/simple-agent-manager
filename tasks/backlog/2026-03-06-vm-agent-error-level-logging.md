# VM Agent Logs Informational Events as Error Level

## Problem

The VM agent reports lifecycle events like "Agent ready", "ACP NewSession succeeded", "ACP Initialize succeeded", "ACP Prompt started", "ACP Prompt completed" at `error` log level. These are normal success events that should be `info` level.

This pollutes the Admin Errors view with false positives, making it harder to identify real errors.

## Context

- Discovered during staging testing on 2026-03-06 via Admin > Errors tab
- 48 "errors" in last 24h, majority are informational lifecycle events
- Only actual error was "ACP Prompt failed" (which was caused by wrong model config, now fixed)

## Acceptance Criteria

- [ ] VM agent lifecycle events logged at appropriate levels:
  - `info`: Agent ready, ACP Initialize succeeded, ACP NewSession succeeded, Agent credential fetched, Agent selection started, Agent binary verified/installed
  - `info`: ACP Prompt started, ACP Prompt completed (success)
  - `warn`: ACP Prompt failed (non-fatal)
  - `error`: Only for actual failures that require attention
- [ ] Admin Errors view shows mostly real errors after fix
