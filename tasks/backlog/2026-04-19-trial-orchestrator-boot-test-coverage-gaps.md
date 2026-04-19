# Trial Orchestrator Boot — Fill Test Coverage Gaps

## Problem

Post-merge test-engineer review of PR #764 (`fix(trial): boot discovery agent on VM + detect real default branch`) identified six minor coverage gaps in `apps/api/tests/unit/durable-objects/trial-orchestrator-agent-boot.test.ts` and its sibling `trial-orchestrator-steps.test.ts`. None are correctness risks today — the happy-path flow implicitly exercises the affected code — but each reduces regression surface for future refactors.

All findings are MINOR / MISSING severity. No CRITICAL or HIGH. The review ran asynchronously and returned after merge.

## Context

- PR: https://github.com/raphaeltm/simple-agent-manager/pull/764 (merged `6452c9b1`)
- Review: test-engineer task `a9fe37c165e38c6a2`, completed 2026-04-19
- Files in scope:
  - `apps/api/tests/unit/durable-objects/trial-orchestrator-agent-boot.test.ts`
  - `apps/api/tests/unit/durable-objects/trial-orchestrator-steps.test.ts`
  - `apps/api/src/durable-objects/trial-orchestrator/steps.ts` (`handleDiscoveryAgentStart`, `fetchDefaultBranch`)

## Acceptance Criteria

### Partial-crash resume boundary tests (three missing)

- [ ] Test: crash after step 2, before step 3 — `agentSessionCreatedOnVm=true`, `mcpToken=null`. Assert steps 1–2 do not fire, steps 3–5 do fire, token is freshly minted and persisted.
- [ ] Test: crash after step 4, before step 5a — `agentStartedOnVm=true`, `acpAssignedOnVm=false`. Assert steps 1–4 do not fire, `transitionAcpSession` fires twice (assigned → running).
- [ ] Test: crash between ACP transitions — `acpAssignedOnVm=true`, `acpRunningOnVm=false`. Assert `transitionAcpSession` fires exactly once with `'running'`, and `acpRunningOnVm=true` afterward.

### Argument-propagation assertions (two minor)

- [ ] `startDiscoveryAgent` arguments pinned positionally (`projectId`, `workspaceId`, `sessionTopic` equals `${repoOwner}/${repoName}`).
- [ ] `acpSessionId` (return value from `startDiscoveryAgent`) pinned as `transitionAcpSessionMock.mock.calls[0][2]` and `[1][2]` — currently only call count and target state are asserted.

### `fetchDefaultBranch` edge cases (two minor)

- [ ] Test: AbortController fires — mock `fetch` to reject with an `AbortError`; assert `defaultBranch` falls back to `'main'` and `clearTimeout` is invoked (via `vi.useFakeTimers` or spy).
- [ ] Test: 200 response with empty `default_branch` field — assert fallback to `'main'` rather than persisting the empty string.

### Nice-to-have

- [ ] Add `userId` assertion to the existing `storeMcpToken` data-argument check (currently skipped).

### Design deviation — `handleWorkspaceCreation` silent fallback (from post-merge task-completion-validator review `a3dbf4bc16eefef2a`)

- [ ] Decide between:
  - **Option A** (matches original task plan): replace `const branch = state.defaultBranch ?? TRIAL_FALLBACK_BRANCH;` at `apps/api/src/durable-objects/trial-orchestrator/steps.ts:468` with a fail-loud guard — if `!state.defaultBranch`, throw `{ permanent: true }` with a diagnostic message. Add a test that exercises the guard.
  - **Option B** (ratify the current behavior): keep the silent fallback but document the rationale inline and in the task file — argue that defence-in-depth against a corrupted/out-of-order state is worth surfacing `'main'` rather than a terminal error that would orphan the workspace row.

Rationale for filing as backlog: current behavior is functionally safe (both staging repos verified end-to-end) and the fallback branch is the statistically common case. No runtime breakage today. But the implementation silently re-introduces the exact hardcoded-branch pattern this task was designed to eliminate, so future refactors should make a deliberate call.

## References

- Review output: `/tmp/claude-1000/-workspaces-simple-agent-manager/f0d339c6-df20-4346-9a46-56359d6580eb/tasks/a9fe37c165e38c6a2.output`
- `.claude/rules/25-review-merge-gate.md` (MINOR findings may be deferred to backlog; CRITICAL/HIGH cannot)
- `.claude/rules/10-e2e-verification.md` (capability-test requirements)
