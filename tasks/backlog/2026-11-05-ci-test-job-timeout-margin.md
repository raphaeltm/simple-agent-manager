# CI `Test` job runs within minutes of its 20-minute timeout

## Problem

The CI `Test` job (`.github/workflows/ci.yml`, `timeout-minutes: 20`) took 16 to 19.5 minutes on `main` on 2026-11-05: runs ending 15:50, 16:09 and 17:10 UTC. On PR #2539 it was cancelled at 20:00 by the timeout once (run 42081932084, job 127437975709), then passed on rerun in 15m25s. The `apps/web` coverage run alone took about 12 minutes of it. A slower runner, or a modest suite growth, will turn this into routine false failures.

## Context

Found while shepherding PR #2539 (reliable workspace shutdown). The timed-out run was still executing `@simple-agent-manager/api:test:coverage` when it was cancelled. Turbo prints a package's output only when that package finishes, so the log shows nothing from it.

## Acceptance Criteria

- [ ] Measure per-package durations in the `Test` job over recent `main` runs.
- [ ] Either shard the job (as the Durable Object Workers job already is), or raise the timeout with a stated margin and an owner to revisit it.
- [ ] Recent `main` runs show at least 25% headroom under the timeout.
