# Increase Workspace Ready Timeout to 30 Minutes

## Problem

The default workspace readiness timeout is 15 minutes, which is too short for projects with long build times (e.g., large devcontainer builds on new nodes). Users report builds taking 15-20 minutes, so a 30-minute default is needed to avoid false timeout failures.

## Research Findings

- **Primary constant**: `DEFAULT_TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS` in `packages/shared/src/constants.ts:188` (15 min)
- **Dependent timeouts** (must maintain ordering constraints):
  - `DEFAULT_PROVISIONING_TIMEOUT_MS` in `apps/api/src/services/timeout.ts:20` (must be >= workspace ready)
  - `DEFAULT_TASK_STUCK_DELEGATED_TIMEOUT_MS` in `packages/shared/src/constants.ts:166` (must be > workspace ready)
- **Documentation**: `apps/api/.env.example` documents default values
- All timeouts are individually overridable via env vars (constitution Principle XI compliant)

## Implementation Checklist

- [ ] Update `DEFAULT_TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS` from 15 min to 30 min
- [ ] Update `DEFAULT_PROVISIONING_TIMEOUT_MS` from 15 min to 30 min
- [ ] Update `DEFAULT_TASK_STUCK_DELEGATED_TIMEOUT_MS` from 16 min to 31 min
- [ ] Update `.env.example` documented defaults
- [ ] Update comments referencing old timeout values
- [ ] Verify build passes
- [ ] Verify no tests hardcode old values

## Acceptance Criteria

- [ ] Workspace ready timeout defaults to 30 minutes
- [ ] Provisioning timeout defaults to 30 minutes (>= workspace ready)
- [ ] Stuck delegated timeout defaults to 31 minutes (> workspace ready)
- [ ] All comments and docs reflect new values
- [ ] Build and typecheck pass
