# Fix task-runner Env type to eliminate `as any` casts

## Problem

`apps/api/src/durable-objects/task-runner.ts` has 15 `as any` type assertions, all caused by the Durable Object's `TaskRunnerEnv` type (line 55) not matching the full `Env` interface that imported service functions expect. Rather than fixing the type, the original code cast `this.env as any` everywhere.

## Research Findings

### Current State
- `TaskRunner` uses `TaskRunnerEnv` (partial type, ~36 fields) but service functions expect the full `Env` (~350+ fields)
- Every service call uses `this.env as any` to bypass the type mismatch
- Other DO files are clean:
  - `notification.ts` — uses local scoped `Env`, no `as any` casts
  - `node-lifecycle.ts` — uses `NodeLifecycleEnv`, no `as any` casts
  - `project-data/` — uses local scoped `Env` in `types.ts`, no `as any` casts

### Solution
The established pattern in the codebase is to import `Env` from `../../index` (used by all routes, middleware, services, scheduled tasks). Since Cloudflare DOs receive the full Worker env at runtime, changing `TaskRunner` to use the full `Env` type is both type-correct and runtime-correct.

**Approach:** Replace `TaskRunnerEnv` with `Env` imported from `../../index`. Remove the local `TaskRunnerEnv` type. Remove all `as any` casts.

### Key Files
- `apps/api/src/durable-objects/task-runner.ts` — the target file
- `apps/api/src/index.ts` — defines `Env` interface (line 61)

## Implementation Checklist

- [ ] Import `Env` from `../../index` in task-runner.ts
- [ ] Change `DurableObject<TaskRunnerEnv>` to `DurableObject<Env>`
- [ ] Remove the `TaskRunnerEnv` type definition
- [ ] Remove all 15 `as any` casts (replace `this.env as any` with `this.env`)
- [ ] Run `pnpm typecheck` to verify no type errors
- [ ] Run `pnpm test` to verify no test failures
- [ ] Verify zero `as any` remaining in task-runner.ts
- [ ] Sweep other DO files to confirm no new issues

## Acceptance Criteria

- [ ] Zero `as any` in task-runner.ts
- [ ] Zero `as any` in all other DO files (unless explicitly justified with a comment)
- [ ] `pnpm typecheck` passes
- [ ] All existing tests pass
- [ ] No behavioral changes — pure type-safety refactor

## References
- Idea: `01KN2PNPFV8NKY8A8YED4KNRHF`
- Task: `01KN2Q8XBH5J7Q2FWPPQ1XBKP9`
