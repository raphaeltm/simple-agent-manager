# Reconciliation Prompt-In-Flight Handling

**Status:** archived
**Priority:** high
**Created:** 2026-06-20

## Problem Statement

Task-mode reconciliation currently treats message silence as enough evidence to send a SAM orchestrator check-in. If the VM agent is still processing an in-flight prompt, the check-in prompt is persisted and an expiry marker is created, but VM prompt injection can fail with `409 Agent is already processing a prompt`. That can make a working agent look unresponsive and fail the task shortly after the check-in deadline.

The fix must distinguish an idle/ready agent from an agent that is still prompting. Prompt-in-flight should be treated as active work until it exceeds a configurable hard-stall threshold. The user explicitly requested no staging deployment for this implementation.

## Research Findings

- `apps/api/src/durable-objects/project-data/reconciliation.ts` selects idle task sessions from `chat_sessions`, `idle_cleanup_schedule`, `workspace_activity`, and `acp_sessions`, but does not inspect `session_state.activity` or `prompt_started_at`.
- `apps/api/src/durable-objects/project-data/session-state.ts` already persists VM activity state and `promptStartedAt` when the VM reports `activity = 'prompting'`.
- `packages/vm-agent/internal/server/workspaces.go` rejects follow-up prompts with HTTP 409 when `SessionHost` is `HostPrompting`.
- `packages/vm-agent/internal/server/workspaces.go` exposes `/cancel`, and `apps/api/src/services/node-agent.ts` exposes `cancelAgentSessionOnNode`.
- Existing integration tests in `apps/api/tests/integration/agent-lifecycle-orchestration.test.ts` cover reconciliation check-in creation and expiry.
- Existing unit tests in `apps/api/tests/unit/durable-objects/reconciliation.test.ts` cover reconciliation candidate selection and alarm scheduling.

## Implementation Checklist

- [x] Add configurable prompt-in-flight reconciliation thresholds with shared defaults, Worker env typing, wrangler defaults, and `.env.example` documentation.
- [x] Extend reconciliation candidate selection to read `session_state.activity`, `activity_at`, and `prompt_started_at`.
- [x] Skip visible check-ins while a prompt is in flight below the hard threshold, and schedule the next reconciliation alarm at the relevant prompt threshold.
- [x] On hard prompt stall, call the VM cancel endpoint before any visible check-in is created, record a reconciliation activity event, and let a later reconciliation pass send the check-in once the agent is ready/idle.
- [x] Preserve existing check-in behavior for idle/ready task sessions.
- [x] Add regression tests proving busy agents are not sent check-ins prematurely and hard-stalled prompting agents receive a runtime cancel before a check-in marker is created.
- [x] Add/update configuration and environment validation coverage.
- [x] Run relevant lint, typecheck, and tests locally.

## Validation Notes

- `pnpm --filter @simple-agent-manager/api exec vitest run tests/unit/durable-objects/reconciliation.test.ts tests/unit/durable-objects/session-state-reconciliation.test.ts` passed.
- `pnpm --filter @simple-agent-manager/api exec vitest run tests/integration/agent-lifecycle-orchestration.test.ts` passed.
- `pnpm lint` passed with existing warnings only.
- `pnpm typecheck` passed.
- `pnpm test` passed.
- `pnpm build` passed.
- `pnpm --filter @simple-agent-manager/www build` passed after updating the public configuration reference.
- After adding `TASK_RECONCILIATION_MIN_ALARM_DELAY_MS`, `pnpm --filter @simple-agent-manager/shared build` completed so focused API tests used the latest shared constant export.
- Final focused reconciliation/session-state unit tests passed after the minimum alarm delay change.
- Final `pnpm typecheck` passed.
- Final `pnpm lint` passed with existing warnings only.
- Final `pnpm test` passed.
- Final `pnpm build` passed with existing build warnings only.

## Acceptance Criteria

- Prompt-in-flight task sessions below the hard-stall threshold do not get a visible SAM check-in message or `reconciliation_checkin` marker.
- Hard-stalled prompt-in-flight task sessions trigger `cancelAgentSessionOnNode` before any follow-up check-in is attempted.
- Idle/ready task sessions still receive the existing visible check-in and deadline marker.
- Thresholds are configurable and documented with sensible defaults.
- Tests cover the regression and the runtime-boundary cancel side effect.
- No staging deployment is performed.

## Post-Mortem

### What Broke

SAM could mark a task as unresponsive after creating a reconciliation check-in even though the child agent still had an in-flight prompt.

### Root Cause

Reconciliation used durable message/terminal activity as the only liveness signal and ignored the VM-reported session activity mirror. It created a deadline marker before confirming that the VM agent could accept the injected check-in prompt.

### Why It Wasn't Caught

Existing tests covered idle-session check-ins and expiry, but not the `HostPrompting`/HTTP 409 path at the runtime boundary.

### Class of Bug

Runtime state classification across control-plane and VM-agent boundaries.

### Process Fix

The regression tests for this task must assert the runtime cancel side effect before accepting any hard-stall behavior, matching `.claude/rules/02-quality-gates.md` lifecycle-control guidance.
