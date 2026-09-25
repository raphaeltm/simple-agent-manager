# Structured logs carry raw error text past the logger's Error redaction

## Problem

`apps/api/src/lib/logger.ts` fully redacts an `Error` instance (`serializeError()` replaces the
message with `[REDACTED_ERROR_MESSAGE]`), but a plain string under a key such as `error` only passes
through the narrow secret-shape filter (`SENSITIVE_VALUE_RE`). Hundreds of call sites pre-extract
`err instanceof Error ? err.message : String(err)` before logging, so any downstream error whose
message interpolates row content (a JSON.parse snippet, a constraint value, message text) reaches
Workers Observability and `platform_errors` unredacted. Those logs are platform-wide, not scoped per
tenant.

## Context

Raised as a MEDIUM by the security review of the ProjectData overload fix
(`tasks/archive/2026-09-25-projectdata-root-overload.md`, branch `sam/find-fix-makes-sam-pxsnvt`):
the new `project_data.alarm.<section>_failed` / `completed` logs
(`apps/api/src/durable-objects/project-data/alarm-sections.ts`) and the retry logs
(`apps/api/src/services/project-data-rpc-retry.ts`) continue the existing pattern. The stable
`errorClass` field those logs also carry is message-free. Deferred because the pattern is
codebase-wide and pre-existing; fixing only the new call sites would leave the class open.

## Acceptance Criteria

- [ ] Decide the policy: pass `Error` objects to the logger, or give `error`/`message` string keys a
      default-redact posture with an explicit allowlist for known platform strings.
- [ ] Apply it to the ProjectData alarm and retry logs first, then sweep the remaining call sites (or
      enforce with a lint rule so new ones cannot reappear).
- [ ] Keep operator diagnosability: stable classification fields (`errorClass`, section, operation)
      stay in the log.
- [ ] Tests assert a message containing row content does not reach the emitted log line.
