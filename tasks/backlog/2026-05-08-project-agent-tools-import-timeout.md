# Project Agent Tool Definitions test can time out in root test run

## Problem

`pnpm test` from the repository root timed out in
`apps/api/tests/unit/durable-objects/project-agent.test.ts` while importing
`../../../src/durable-objects/project-agent/tools` for the test named
`exports tool definitions with projectId stripped`.

The failure occurred during provider adapter hardening validation on
2026-05-08T03:05:56Z. The provider package tests passed independently, and this
test is outside `packages/providers`.

## Context

- Command: `pnpm test`
- Failure: `Error: Test timed out in 5000ms`
- File: `apps/api/tests/unit/durable-objects/project-agent.test.ts`
- Test: `Project Agent Tool Definitions > exports tool definitions with projectId stripped`
- Root test result: 1 failed, 4444 passed

## Resolution Notes

During provider hardening validation, the timeout reproduced in full root test
runs while the single-file test passed in isolation. The existing test imported
the project-agent tool registry close to Vitest's default 5000ms per-test
timeout under full-suite parallel load.

This was addressed in the provider hardening branch as a targeted quality-gate
repair by adding a named per-test timeout constant to the project-agent tool
import tests.

## Acceptance Criteria

- [x] Determine whether the timeout is deterministic or workload-sensitive.
- [x] If deterministic, fix the import path or heavy module initialization.
- [x] If workload-sensitive, reduce import-time work or isolate expensive setup.
- [x] Add or update a behavioral regression test without relying on source-contract assertions.
- [x] Re-run `pnpm --filter @simple-agent-manager/api test` and `pnpm test`.
