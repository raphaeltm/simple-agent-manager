# Correct VM Agent Observability Severity Classification

## Problem

Production persisted observability D1 for 2026-05-04 05:50:35Z-06:20:35Z stored normal VM agent lifecycle messages as `level='error'`, including `ACP Initialize succeeded`, `ACP NewSession succeeded`, `Agent binary verified/installed`, `Agent credential fetched`, `Agent ready`, `ACP Prompt started`, and `ACP Prompt completed`.

This pollutes the admin error view and makes real VM agent failures harder to trust.

## Research Findings

- `packages/vm-agent/internal/acp/session_host.go` already emits representative lifecycle success events through `reportLifecycle("info", ...)`.
- `apps/api/src/routes/node-lifecycle.ts` currently validates VM agent report levels with `VALID_VM_ERROR_LEVELS = new Set(['error', 'warn'])`, so incoming `info` reports are intentionally reclassified to `error` before structured logging and `persistErrorBatch()`.
- `apps/api/src/services/observability.ts` already accepts persisted levels `error`, `warn`, and `info`; the classification drift happens before persistence.
- `packages/vm-agent/internal/acp/session_host.go:reportLifecycle()` currently handles `warn` and defaults everything else to `ReportInfo()`, which means explicit lifecycle `error` events such as `ACP prompt force-stopped` are not reported as `error`.
- Existing API tests for the VM agent error route live in `apps/api/tests/unit/routes/vm-agent-errors.test.ts`.
- Existing VM agent reporter tests live in `packages/vm-agent/internal/errorreport/reporter_test.go`; SessionHost tests can cover `reportLifecycle()` behavior directly because tests are in package `acp`.
- Relevant post-mortems:
  - `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md`: callback routes need behavioral route tests through the actual mounted route.
  - `docs/notes/2026-03-12-tls-yaml-indentation-postmortem.md`: VM agent changes require real staging VM provisioning and heartbeat verification.

## Implementation Checklist

- [ ] Allow VM agent API ingestion to preserve `info` level entries instead of defaulting them to `error`.
- [ ] Make VM agent `reportLifecycle()` preserve explicit `error` events.
- [ ] Document the intentional classification policy near the ingestion and lifecycle mapping code.
- [ ] Add API route tests for representative VM agent lifecycle success (`info`), warning (`warn`), and failure (`error`) persistence/logging.
- [ ] Add VM agent test coverage for lifecycle `info`, `warn`, and `error` reporter mapping.
- [ ] Run relevant local API and VM agent tests/typecheck.
- [ ] Deploy to staging through `deploy-staging.yml`.
- [ ] Verify staging observability D1 grouped by source/level/message no longer shows success/lifecycle messages at error level.
- [ ] Provision a real staging VM, verify heartbeat/workspace access, and clean it up.
- [ ] Open a PR with verification evidence.

## Acceptance Criteria

- [ ] Successful VM agent lifecycle events persist as `info`, not `error`.
- [ ] Actual VM agent failures remain `error`.
- [ ] Non-critical failed operations such as unsupported session mode are classified intentionally as `warn` or `error` with a documented reason.
- [ ] Tests cover representative lifecycle success, warning, and failure events.
- [ ] Local tests/typecheck relevant to VM agent/API changes pass.
- [ ] Staging deployment and observability verification pass.
- [ ] PR is opened with verification evidence.
