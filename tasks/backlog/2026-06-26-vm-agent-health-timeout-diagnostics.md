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

- [ ] Add timeout-path diagnostics in `waitForHealth` that warn with every routed service's observed state and the unhealthy/missing service names.
- [ ] Warn-log one redacted raw `docker compose ps --format json` dump on health timeout.
- [ ] Surface the failing routed service list through the returned health timeout error and observed state without logging secrets.
- [ ] Preserve health-gate pass/fail semantics: all routed services must be running and health must be `""`, `"healthy"`, or `"none"`.
- [ ] Parse both short-form and long-form Compose volume entries in the mount guard.
- [ ] Add behavioral Go tests for timeout diagnostics and long-form mount guard enforcement.
- [ ] Add post-mortem with process fix before archiving.
- [ ] Run local VM-agent Go tests.
- [ ] Run required specialist reviews: `go-specialist`, `task-completion-validator`, and test coverage review.
- [ ] Deploy to staging only after deleting existing staging deployment nodes, then verify on a freshly provisioned node per rule 27.

## Acceptance Criteria

- A health timeout produces a Warn-level structured log naming each required routed service, its state/health, and the routed services that blocked the gate.
- A health timeout also emits one redacted raw Compose `ps --format json` dump at Warn level.
- The observed error message or services payload lets the control plane identify the routed service that blocked the gate.
- Long-form Compose volume entries such as `type/source/target` are parsed and still trigger the `/mnt/sam-env-*` mountpoint guard.
- Existing routed service health semantics remain unchanged.
