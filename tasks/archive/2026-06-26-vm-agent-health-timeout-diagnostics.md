# VM-agent health timeout diagnostics and mount guard tolerance

## Problem

Deployment health timeouts on app deployment nodes are currently undiagnosable after failure. `waitForHealth` times out with only `health check timed out after 5m0s`, while per-service Docker state is logged at Debug and the failure cleanup removes containers before a debug package can capture the blocker. The control-plane observed state also loses service state on failed-initial cleanup.

The mount guard also silently skips valid Compose files that use long-form map `volumes:` entries because it unmarshals volumes as `[]string`.

## Research Findings

- `packages/vm-agent/internal/deploy/compose.go` gates only routed services using `routeServiceSet(routes)` and considers a service passing when `Status == "running"` and `Health` is `""`, `"healthy"`, or `"none"`.
- `inspectServices` already shells out to `docker compose ps --format json` with the deployment interpolation env and uses `newEnvRedactor`.
- `packages/vm-agent/internal/deploy/engine.go` wraps health gate failures in `health check: ...` and calls `handleApplyFailure`; failed-initial observed state currently sets no `Services`.
- `packages/vm-agent/internal/deploy/mount_guard.go` parses only short-form volumes and currently skips the check when valid long-form volume YAML causes unmarshal failure.
- Relevant rules: `.claude/rules/02-quality-gates.md`, `.claude/rules/25-review-merge-gate.md`, `.claude/rules/27-vm-agent-staging-refresh.md`, `.claude/rules/39-debug-before-redesign.md`.

## Implementation Checklist

- [x] Add timeout-path diagnostics in `waitForHealth` that warn with every routed service's observed state and the unhealthy/missing service names.
- [x] Warn-log one redacted raw `docker compose ps --format json` dump on health timeout.
- [x] Surface the failing routed service list through the returned health timeout error and observed state without logging secrets.
- [x] Preserve health-gate pass/fail semantics: all routed services must be running and health must be `""`, `"healthy"`, or `"none"`.
- [x] Parse both short-form and long-form Compose volume entries in the mount guard.
- [x] Add behavioral Go tests for timeout diagnostics and long-form mount guard enforcement.
- [x] Add post-mortem with process fix before archiving.
- [x] Run local VM-agent Go tests.
- [x] Run required specialist reviews: `go-specialist`, `task-completion-validator`, and test coverage review.
- [x] Deploy to staging only after deleting existing staging deployment nodes, then verify on a freshly provisioned node per rule 27.

## Acceptance Criteria

- When final Docker inspection succeeds, a health timeout produces a Warn-level structured log naming each required routed service, its state/health, and the routed services that blocked the gate.
- When final Docker inspection succeeds, a health timeout also emits one redacted raw Compose `ps --format json` dump at Warn level. If the final inspection fails, the timeout path logs the required routed services plus the inspection error instead.
- The observed error message or services payload lets the control plane identify the routed service that blocked the gate.
- Long-form Compose volume entries such as `type/source/target` are parsed and still trigger the `/mnt/sam-env-*` mountpoint guard.
- Existing routed service health semantics remain unchanged.

## Verification

- `go test ./internal/deploy` in `packages/vm-agent`
- `go test ./...` in `packages/vm-agent`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- Staging workflow `28211432012` passed, including VM-agent build/upload, staging health check, and smoke tests.
- Rule 27 fresh-node verification: deleted user-visible staging nodes before deploy, created fresh node `01KW0SGZGJ44BG0TRF5DKSN2ZG` after staging VM-agent upload, observed `status=running`, `healthStatus=healthy`, and `lastHeartbeatAt=2026-06-26T01:45:19.554Z`, then deleted the node successfully.
- Staging note: a stale non-user-visible `system_anonymous_trials` D1 row from May 2026 remained inaccessible through the primary user's node API; the primary staging API returned `[]` before and after the fresh-node verification cleanup.

## Reviews

- `go-specialist`: PASS after redaction hardening for service-state fields on the timeout path.
- `test-engineer`: PASS; behavioral tests cover health timeout diagnostics, engine observed state, and long-form mount guard enforcement.
- `task-completion-validator`: PASS; checklist and acceptance criteria covered by diff and validation commands.

## Post-Mortem

### What broke

The deployment health gate timed out after Compose had started containers, but the node reported only `health check timed out after 5m0s`. The relevant per-service Docker state existed only behind Debug logs and was lost when failure cleanup tore down the failed release.

The mount guard also parsed service volumes as `[]string`, so valid long-form Compose volume maps caused YAML unmarshal failure and the guard skipped its `/mnt/sam-env-*` mountpoint check.

### Root cause

The health gate treated timeout as a scalar error instead of preserving the system-boundary state that made the decision. The mount guard used an overly narrow Compose schema for a field whose official syntax has multiple forms.

### Timeline

The defect was discovered while diagnosing the wedged `dexxy` production deployment on June 26, 2026. Production D1 showed `failed-initial` with a bare timeout message and no `observed_services_json`, while node debug evidence showed containers had stayed running for the full timeout window.

### Why it wasn't caught

Existing tests covered the health gate's pass/fail semantics but not the timeout observability contract after failure cleanup. The mount guard tests covered short-form volume strings but not the valid long-form map syntax Docker Compose accepts.

### Class of bug

Health gate / system boundary is a black box on failure: failure state logged at Debug, never surfaced. A related parser-tolerance bug allowed a valid input shape to bypass a safety guard.

### Process fix

For future deployment-node gates that make pass/fail decisions from an external system snapshot, the failure path must include a Warn-or-higher structured diagnostic with the evaluated resources and the specific blockers, plus a behavioral test that proves the diagnostic survives the cleanup/revert path. Compose parsers used for safety checks must include valid short-form and long-form syntax fixtures before shipping.

Concrete rule update: `.claude/rules/02-quality-gates.md` now requires external-system gate diagnostics to preserve evaluated resources and exact blockers before cleanup, redact raw external output, surface blockers after cleanup, and include behavioral timeout/failure tests.
