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

- [x] Allow VM agent API ingestion to preserve `info` level entries instead of defaulting them to `error`.
- [x] Make VM agent `reportLifecycle()` preserve explicit `error` events.
- [x] Document the intentional classification policy near the ingestion and lifecycle mapping code.
- [x] Add API route tests for representative VM agent lifecycle success (`info`), warning (`warn`), and failure (`error`) persistence/logging.
- [x] Add VM agent test coverage for lifecycle `info`, `warn`, and `error` reporter mapping.
- [x] Run relevant local API and VM agent tests/typecheck.
- [x] Deploy to staging through `deploy-staging.yml`.
- [x] Verify staging observability D1 grouped by source/level/message no longer shows success/lifecycle messages at error level.
- [x] Provision a real staging VM, verify heartbeat/workspace access, and clean it up.
- [ ] Open a PR with verification evidence.

## Acceptance Criteria

- [x] Successful VM agent lifecycle events persist as `info`, not `error`.
- [x] Actual VM agent failures remain `error`.
- [x] Non-critical failed operations such as unsupported session mode are classified intentionally as `warn` or `error` with a documented reason.
- [x] Tests cover representative lifecycle success, warning, and failure events.
- [x] Local tests/typecheck relevant to VM agent/API changes pass.
- [x] Staging deployment and observability verification pass.
- [ ] PR is opened with verification evidence.

## Verification Evidence

- Local validation:
  - `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/vm-agent-errors.test.ts`
  - `pnpm --filter @simple-agent-manager/api test -- tests/integration/observability-ingestion.test.ts`
  - `pnpm --filter @simple-agent-manager/api typecheck`
  - `pnpm --filter @simple-agent-manager/api lint` (existing warnings only)
  - `go test ./internal/acp -run TestSessionHostReportLifecycleSeverityMapping`
  - `go test ./...` from `packages/vm-agent`
  - `pnpm lint` (existing warnings only)
  - `pnpm typecheck`
  - `pnpm build` (existing web chunk-size warnings and Turbo API output warning)
  - `pnpm test`
- Review:
  - `$task-completion-validator`: local implementation covered; failed only on then-pending staging/PR items.
  - `$constitution-validator`: no Principle XI blockers.
  - `$go-specialist` and `$cloudflare-specialist`: no blockers found, but both returned partial reviews after interruption; local code-level pass found no blocker in the changed Go/API lines.
  - `$test-engineer`: stale integration assertion finding was resolved; focused integration and full `pnpm test` passed after the fix.
- Staging:
  - GitHub Actions `deploy-staging.yml` run `25306057453` passed, including API/Web deploy, VM agent build/upload, health check, and smoke tests.
  - Live staging API health returned `200` from `https://api.sammy.party/health`.
  - Playwright staging regression logged in with `SAM_PLAYWRIGHT_PRIMARY_USER`; dashboard, projects, and settings pages loaded with `console_errors []`.
  - Created staging workspace `01KQRXZZJ4CTQXWCF0B1TPXCZP` on node `01KQRXZZ48AKXR6SZ63ECDAA4C`; VM agent heartbeat reached healthy at `2026-05-04T07:27:01.664Z`.
  - Created agent session `01KQRYD0Z6MMB0T8DSS795T157`, connected to `wss://ws-01KQRXZZJ4CTQXWCF0B1TPXCZP.sammy.party/agent/ws`, sent an ACP prompt, received agent response and `session_prompt_done`.
  - Staging observability D1 query with cutoff `2026-05-04T07:24:39.311Z` showed the representative lifecycle messages persisted with `level='info'`: `Agent selection started`, `Agent credential fetched`, `Agent binary verified/installed`, `ACP Initialize started/succeeded`, `ACP NewSession started/succeeded`, `Agent ready`, `ACP Prompt started`, and `ACP Prompt completed`.
  - Cleanup confirmed: `/api/nodes` and `/api/workspaces` returned empty lists for the smoke user; the created node/workspace returned `404`.
