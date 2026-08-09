# Increase ACP task prompt timeout default to 8h

## Problem

Long productive task prompts can exceed the current vm-agent task prompt timeout default of `6h`. When the timeout fires, task sessions can end in a dead-end host error state. This task is the immediate bounded mitigation only: increase the default `ACP_TASK_PROMPT_TIMEOUT` for task-driven vm-agent sessions from `6h` to `8h` while preserving environment override configurability.

Do not implement checkpointing, liveness redesign, prompt rollover, or recovery in this PR.

## Research findings

- `packages/vm-agent/internal/config/config.go` defines `ACPTaskPromptTimeout` and currently reads `ACP_TASK_PROMPT_TIMEOUT` with a `6*time.Hour` default.
- `packages/vm-agent/internal/server/server.go` documents `effectivePromptTimeout()` as using `ACPTaskPromptTimeout` for task-driven workspaces and `ACPPromptTimeout` for direct workspace sessions.
- `packages/vm-agent/internal/server/prompt_timeout_test.go` covers session-type selection but constructs explicit task timeout values rather than testing the env-backed default.
- `packages/vm-agent/internal/e2e/boot_log_streaming_test.go` has a representative config fixture with `ACPTaskPromptTimeout: 6 * time.Hour`.
- `.claude/skills/env-reference/SKILL.md` is an authoritative environment reference and initially documented `ACP_TASK_PROMPT_TIMEOUT` as default `6h`.
- `apps/www/src/content/docs/docs/reference/configuration.md` is the public docs configuration reference and initially documented default `6h`.
- Retained task archive `tasks/archive/2026-03-05-fix-prompt-timeout-by-session-type.md` records the historical 6h behavior; leave historical archive content intact unless it is an authoritative current reference.
- Retained task archive `tasks/archive/2026-02-20-prompt-timeout-graceful-handling.md` explains that deeper recovery/liveness behavior is separate from this bounded mitigation.

## Implementation checklist

- [x] Change `ACP_TASK_PROMPT_TIMEOUT` default from `6*time.Hour` to `8*time.Hour` in vm-agent config loading.
- [x] Update current code comments that describe the task prompt timeout default.
- [x] Update authoritative environment references to document default `8h`.
- [x] Update relevant vm-agent tests/fixtures so expected defaults are consistent.
- [x] Add or update a vm-agent config test proving the env default is `8h` and env override remains configurable.
- [x] Keep historical archive notes unchanged unless needed for current docs consistency.
- [x] Run applicable Go/package and repo-level quality gates.
- [ ] Run specialist review for Go, env docs, documentation sync, constitution compliance, task completion, and tests.
- [ ] Deploy/verify according to repository rules, open PR, merge once green, and monitor production deployment.

## Acceptance criteria

- [x] Task-driven vm-agent sessions default to an `8h` ACP prompt timeout.
- [x] Direct workspace sessions remain governed by `ACP_PROMPT_TIMEOUT` and default to no prompt timeout.
- [x] `ACP_TASK_PROMPT_TIMEOUT` remains configurable via environment variable override.
- [x] Current authoritative docs and environment references consistently say `8h`.
- [x] Relevant tests pass and include coverage for the default and override.
- [x] PR scope contains only this bounded timeout-default mitigation.
