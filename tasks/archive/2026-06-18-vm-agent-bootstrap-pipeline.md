# Refactor VM Agent Bootstrap Pipeline

## Problem

`packages/vm-agent/internal/bootstrap/bootstrap.go` currently concentrates workspace bootstrap orchestration in large procedural flows. The task is to refactor bootstrap into an explicit step/pipeline shape so ordering, fatal/non-fatal behavior, cleanup ownership, and reporter behavior are easier to audit and test.

## Human Constraints

- Do not merge the PR.
- Do not deploy to staging or production.
- Do not run `pnpm deploy:staging`, `wrangler deploy --env staging`, SAM deployment tools, or equivalents.
- Stop after local implementation, tests, and a draft/open PR clearly marked `DO NOT MERGE / DO NOT DEPLOY`.
- Preserve this constraint prominently in the PR title/body.

## Source Of Truth

- SAM idea: `01KVCX0TQTTCWFDTHDN1PN7KCS`
- Current SAM task: `01KVCZQEEE64DXRYF4M2AW6J7E`
- Output branch: `sam/task-vm-agent-bootstrap-01kvcz`
- Audit reports requested: `/engineering/code-elegance-audits/2026-06-18/`

## Research Findings

- SAM instructions and the source idea were loaded before implementation.
- The absolute audit path `/engineering/code-elegance-audits/2026-06-18/` was not mounted in this workspace. A repo-local search for `code-elegance-audits` did not find those reports.
- Existing unrelated `.codex` local changes are present on `main`; they must not be reverted.

## Implementation Checklist

- [x] Characterize existing bootstrap behavior and test seams in `packages/vm-agent/internal/bootstrap`.
- [x] Introduce a small bootstrap-local context, step result/status model, and cleanup stack.
- [x] Add a step runner with explicit ordering, fatal/non-fatal semantics, cleanup-on-failure behavior, and reporter phase handling.
- [x] Refactor `Run` and `PrepareWorkspace` to assemble explicit plans from shared steps while preserving behavior.
- [x] Decompose `ensureDevcontainerReady` into focused helpers where practical.
- [x] Add tests for step ordering and reporter event order.
- [x] Add tests for required step failure, optional step warning/continuation, and cleanup behavior.
- [x] Add tests for lightweight behavior, cache non-fatal behavior, named devcontainer config failure, and fallback behavior.
- [x] Run focused bootstrap tests from `packages/vm-agent`.
- [x] Run related/full VM agent package tests if the environment supports it.
- [x] Create a draft/open PR marked `DO NOT MERGE / DO NOT DEPLOY TO STAGING`.

## Acceptance Criteria

- Bootstrap top-level flow reads as an ordered plan with explicit phases.
- Fatal vs non-fatal behavior is visible in code and covered by tests.
- Cleanup behavior is centralized enough for credential/helper ownership to be easy to audit.
- `Run` bootstrap-token behavior and `PrepareWorkspace` behavior are preserved unless any change is explicitly justified and tested.
- Devcontainer helper flow is decomposed without broad lifecycle/shutdown refactors.
- PR summary lists tests run and confirms no staging deployment was performed.
