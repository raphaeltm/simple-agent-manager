# Improve Test Infrastructure and Patterns

**Status:** backlog
**Priority:** medium
**Estimated Effort:** 4 days
**Created:** 2026-03-03

## Problem Statement

The test infrastructure (186 test files, ~2,375 test cases) has structural issues that reduce test reliability and create false confidence:

- **Source-contract tests dominate the API layer**: Many API tests use `readFileSync` + `toContain()` patterns that prove code is *present* but not that it *works*. This is the exact anti-pattern cited in the TDF post-mortem (`docs/notes/2026-02-28-missing-initial-prompt-postmortem.md`).
- **No coverage thresholds enforced**: No vitest config sets minimum coverage — regression goes undetected
- **Heavy mock proliferation**: Page tests mock 20+ API functions via `vi.hoisted()`, hiding API contract mismatches. Mock schemas don't validate against real API types.
- **Miniflare underutilized**: Only 2-3 test files in `tests/workers/` despite full Miniflare capability for D1, KV, R2, and DO testing. No TaskRunner DO integration test.
- **Duplicate test utilities**: `createNode()`, `createWorkspace()` helper factories reimplemented in each test file instead of shared
- **Inconsistent mock cleanup**: Only 6 `afterEach` cleanup patterns across 57 web test files
- **No Go race detector in CI**: `go test -race` not enabled, missing concurrent viewer tests
- **Large monolithic test files**: `workspace.test.tsx` (889 lines), `GlobalCommandPalette.test.tsx` (634 lines), `NodeCard.test.tsx` (583 lines)
- **WebSocket hooks untested**: `useChatWebSocket.ts`, `useAdminLogStream.ts`, `useTabOrder.ts` lack behavioral tests
- **Miniflare test env hardcoded**: `vitest.workers.config.ts` has hardcoded test values that may diverge from production defaults

## Acceptance Criteria

- [ ] Create shared test utilities:
  - `apps/web/tests/test-utils.ts` — reusable mock factories (`createMockWorkspace`, `createMockNode`, `createMockProject`, `createMockTask`)
  - `apps/api/tests/test-helpers.ts` — shared API test setup
  - Ensure mock factories return types that match shared type definitions
- [ ] Add coverage thresholds to all vitest configs:
  - `{ lines: 70, functions: 70, branches: 60, statements: 70 }`
  - Run `pnpm test:coverage` to establish baseline
- [ ] Audit and flag source-contract tests:
  - Add `// @structural-test` comments to tests that use `readFileSync` + `toContain()`
  - Write behavioral replacement tests for the 5 most critical business logic paths
  - Create backlog item for migrating remaining source-contract tests
- [ ] Add TaskRunner DO integration test using Miniflare:
  - Test: create task → alarm fires → state transitions through execution steps
  - Uses real D1 + DO bindings, not mocks
- [ ] Add NodeLifecycle DO integration test using Miniflare:
  - Test: markIdle → alarm fires → state transitions to destroying
- [ ] Standardize mock cleanup:
  - Add `afterEach(() => { vi.clearAllMocks(); })` to all test files with mocks
  - Document cleanup requirements in test conventions
- [ ] Add `-race` flag to Go test CI command
- [ ] Break large test files into focused suites:
  - `workspace.test.tsx` → `WorkspaceLayout.test.tsx`, `WorkspaceTabs.test.tsx`, `WorkspaceActions.test.tsx`
- [ ] Extract Miniflare test env bindings to shared constants — reference from `packages/shared/src/constants.ts`

## Key Files

- `apps/api/vitest.config.ts`
- `apps/api/vitest.workers.config.ts`
- `apps/web/vitest.config.ts`
- `apps/web/tests/setup.ts` (minimal)
- `apps/api/tests/unit/` (source-contract test directory)
- `apps/api/tests/workers/` (only 2-3 files)
- `.github/workflows/ci.yml` (Go test flags)

## Approach

1. Create shared test utilities first — enables all other improvements
2. Add coverage thresholds — establishes baseline
3. Write DO integration tests — fills most critical gap
4. Audit source-contract tests — reduces false confidence
5. Cleanup and standardization — improves reliability
