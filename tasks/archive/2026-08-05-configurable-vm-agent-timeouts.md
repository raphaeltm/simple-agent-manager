# Configurable VM-agent provisioning and external-operation timeouts

## Problem

R3 finding 2 identified hardcoded provisioning, PTY/WebSocket, and external-operation timeout values in the Go VM agent. Operators need env/config overrides without changing default behavior, API payloads, public protocols, or successful timing.

## Scope

Implement only R3 finding 2 for `packages/vm-agent`. Keep the exact current timeout values as defaults. Preserve already-configurable PTY/WebSocket settings and add coverage proving compatibility.

## Research findings

- `packages/vm-agent/main.go` hardcodes:
  - graceful shutdown timeout: `30*time.Second`
  - workspace system provisioning timeout: `15*time.Minute`
  - Cloudflare IP fetch timeout string: `"10"`
- `packages/vm-agent/internal/bootlog/reporter.go` hardcodes a 10s HTTP client timeout for boot-log callbacks.
- `packages/vm-agent/internal/server/mcp_tools.go` hardcodes command contexts:
  - workspace-info and credential-status: 10s
  - diff-summary: 30s
- Existing env conventions:
  - parse errors fall back to defaults and log a warning via config helpers.
  - safety-critical semantic invalid values commonly fail `Config.Validate()`.
  - selected runtime helpers fall back when zero preserves older behavior.
- Already env-backed settings include `TERMINAL_WS_*`, `PTY_CLOSE_GRACE_PERIOD`, `GIT_*`, `FILE_*`, `LOG_*`, `DEBUG_PACKAGE_TIMEOUT`, `DEPLOY_*`, and ACP prompt/recovery settings.

## Checklist

- [x] Add named default constants and `Config` fields for remaining hardcoded VM-agent operational timeouts.
- [x] Load env overrides with exact current defaults.
- [x] Validate zero/negative values safely without allowing disabled safety budgets.
- [x] Thread config through provisioning, boot-log reporter, graceful shutdown, and MCP external command contexts.
- [x] Preserve public HTTP/WebSocket protocols and response payloads.
- [x] Add scenario tests for default compatibility, env overrides, invalid values, cancellation/timeout behavior, and secret-safe logs.
- [x] Update public docs/env references for new env vars.
- [x] Run Go tests and applicable repo checks.
- [x] Run local specialist reviews and address findings.
- [x] Staging/VM verification explicitly skipped by Raphaël; no staging deployment or mutation permitted.
- [x] Update existing PR #1746 for authorized merge after required CI is green.

## Acceptance criteria

- Defaults match current behavior exactly:
  - graceful shutdown 30s
  - provisioning 15m
  - Cloudflare IP fetch 10s
  - boot-log HTTP 10s
  - MCP short commands 10s
  - MCP diff summary 30s
  - ACP activity callback attempts 10s
  - workspace-ready retry requests 30s
  - existing PTY/WebSocket defaults unchanged
- Positive env overrides take effect.
- Parse errors fall back without exposing secret values.
- Zero/negative required timeout values fail validation or fall back consistently with existing conventions.
- Timeout/cancellation paths are covered by tests.
- Logs/tests prove secret-bearing values are not emitted.
