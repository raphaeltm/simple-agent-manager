# Wave 2A placement resolver migration

## Problem

Wave 1B introduced `apps/api/src/services/placement-resolver.ts` and migrated the chat submit path. The remaining task-start entry points still duplicate provider, location, VM size, runtime, credential attribution, and resource-reservation decisions locally. That duplication is a correctness risk for compute/node-pool rollout because V1 must resolve one effective compute placement consistently across all task entry points.

## Research findings

- `apps/api/src/services/placement-resolver.ts` centralizes VM size/source, provider/location validation, workspace profile/devcontainer, task mode, agent type, runtime decision normalization, resource reservation, credential lookup, and inherited credential attribution.
- `apps/api/src/routes/tasks/submit.ts` is the reference migrated path. It resolves placement before credential lookup, then calls `resolvePlacementCredentialAttribution()` after `resolveCredentialSource()`.
- Remaining duplicated paths:
  - `apps/api/src/routes/mcp/dispatch-tool.ts:handleDispatchTask`
  - `apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts:dispatchTask`
  - `apps/api/src/services/trigger-submit.ts:submitTriggeredTask`
  - `apps/api/src/durable-objects/sam-session/tools/retry-subtask.ts:retrySubtask`
  - `apps/api/src/routes/tasks/run.ts` route handler for `POST /:taskId/run`
  - `apps/api/src/routes/mcp/orchestration-tools.ts:handleRetrySubtask`
- Existing Wave 0 migration guard is in `apps/api/tests/integration/node-selection.test.ts`; it currently tracks only three duplicated paths and should be expanded/updated as paths migrate.
- Existing behavioral parity coverage for the resolver is in `apps/api/tests/unit/services/placement-resolver.test.ts`, including submit, MCP dispatch runtime, zero-config runtime policy, retry skill VM-size source, SAM-session dispatch defaults, and trigger reservation source IDs.
- Credential fallback behavior is safety-sensitive. `.claude/rules/28-credential-resolution-fallback-tests.md` requires behavioral branch coverage for credential resolution and rejects source-contract tests as proof for credential boundaries.

## Checklist

- [x] Migrate `routes/mcp/dispatch-tool.ts` to `resolveTaskStartPlacement()` without changing runtime validation, quota enforcement, inherited attribution, or Instant dispatch behavior.
- [x] Migrate `durable-objects/sam-session/tools/dispatch-task.ts` to the shared resolver without changing parent attribution or delegated task-mode defaults.
- [x] Migrate `services/trigger-submit.ts` to the shared resolver without changing trigger VM-size source, project credential lookup, branch behavior, or task/session failure handling.
- [x] Migrate `durable-objects/sam-session/tools/retry-subtask.ts` to the shared resolver while preserving retry `skill` VM-size attribution.
- [x] Migrate `routes/tasks/run.ts` to the shared resolver while preserving ready-task run semantics, explicit branch behavior, session creation, and caller credential attribution.
- [x] Migrate `routes/mcp/orchestration-tools.ts:handleRetrySubtask` to the shared resolver or document precise rationale if unsafe in this PR.
- [x] Extend resolver parity tests for all migrated entry-point policies, including inherited credential lookup/attribution, zero-config runtime policy, provider/location validation, and retry `skill` VM-size source.
- [x] Update Wave 0 source-contract assertions to enforce migrated paths importing/calling the shared resolver.
- [x] Run local targeted tests and broader API validation.
- [x] Run specialist review before PR.
- [ ] Open child PR against `sam/compute-pools-integration`.

## Acceptance criteria

- Migrated paths no longer carry local duplicated placement decision logic.
- Behavior remains compatible for source/credential/runtime cases covered by tests.
- Any path not safely migrated is listed below and in the PR summary with file/function/rationale.
- No public docs or strategy docs are added.
- No staging deployment, staging mutation, or staging validation is performed.
- PR targets `sam/compute-pools-integration`, not `main`.

## Remaining unmigrated paths

None. All six requested entry points were migrated in this PR.

## Local validation

- `pnpm --filter @simple-agent-manager/api typecheck` — passed
- `pnpm --filter @simple-agent-manager/api lint` — passed
- `pnpm --filter @simple-agent-manager/api test` — passed, 621 files / 8,466 tests
- Targeted parity/source-contract batches:
  - `tests/unit/services/placement-resolver.test.ts`
  - `tests/integration/node-selection.test.ts`
  - `tests/unit/durable-objects/sam-dispatch-task-mode-visibility.test.ts`
  - `tests/unit/services/trigger-submit.test.ts`
  - `tests/unit/routes/spawn-repo-access-gate.test.ts`
  - `tests/unit/durable-objects/sam-tools-phase-b.test.ts`
  - `tests/unit/routes/mcp-orchestration-tools.test.ts`
  - `tests/unit/routes/shared-project-task-authorization.test.ts`
  - `tests/unit/routes/shared-project-task-lifecycle-positive.test.ts`
  - `tests/unit/durable-objects/sam-dispatch-lineage.test.ts`
  - `tests/unit/routes/mcp-dispatch-instant.test.ts`
  - `tests/unit/routes/mcp.test.ts`
  - `tests/unit/project-default-provider.test.ts`
  - `tests/unit/skill-submit-paths.test.ts`
  - `tests/integration/compute-quotas.test.ts`
  - `tests/unit/resolve-credential-source.test.ts`

No staging deployment, staging mutation, or staging validation was performed.

## Specialist review

- `security-auditor` — PASS. Reviewed credential attribution/source changes, quota checks, raw SQL calls, and logging. No credential/token exposure, non-parameterized SQL, or authorization bypass found in the changed paths.
- `cloudflare-specialist` — PASS. Reviewed Worker/D1 patterns. Raw D1 writes continue to use `.bind()` or Drizzle values, and no Wrangler, migration, KV, R2, staging, or deployment configuration changes were made.
- `constitution-validator` — PASS. No new Principle XI hardcoded-value violations found. Branch prefix/length and dispatch description length remain configurable through existing env/project/default mechanisms.
- `test-engineer` — PASS. Added resolver parity coverage for task-run/orchestration retry policies, extended source-contract coverage across the seven resolver-backed start paths, and ran full API tests.
- `task-completion-validator` — PASS. Research findings, checklist items, acceptance criteria, and actual diff/test evidence align. UI-to-backend audit is N/A because no UI/shared request contract files changed.
