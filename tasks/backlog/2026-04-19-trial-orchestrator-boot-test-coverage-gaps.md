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

### Security follow-ups — from post-merge security-auditor review `aaa5e7c8e74b36d90`

Two HIGH-severity findings arrived post-merge. Per `.claude/rules/25-review-merge-gate.md`, HIGH findings normally block merge. Because PR #764 was already merged when the review completed, these are filed here as **fast-follow** items and should be fixed in a focused follow-up PR against `sam/trial-onboarding-mvp` before production cut.

#### HIGH-1: Revoke trial MCP token on orchestrator terminal state (credential lifecycle)

- [ ] Add `revokeMcpToken(env.KV, state.mcpToken)` call in `TrialOrchestrator.failTrial()` and in the terminal branch of `handleRunning()` at `apps/api/src/durable-objects/trial-orchestrator/index.ts` (mirror the TaskRunner cleanup pattern in `apps/api/src/durable-objects/task-runner/state-machine.ts:265-275`).
- [ ] Also revoke in `scheduled/trial-expire.ts` when the cron sweep transitions a row to `expired` — requires reading the DO's state via the orchestrator stub rather than bypassing the DO.
- [ ] Test: fail a trial mid-flight, then attempt to use the token against a knowledge-tool endpoint and assert 401.

**Why:** MCP token is minted with the default 4-hour KV TTL (`DEFAULT_MCP_TOKEN_TTL_SECONDS`) but the trial workspace TTL is 20 minutes. The token currently remains valid for up to 4 hours after trial expiry because nothing calls `revokeMcpToken()`. Any party that learns the token (VM process that didn't cleanly exit, logging bug) retains full MCP-tool access to the trial project for that window.

#### HIGH-2: Document or narrow sentinel `userId` scope in trial MCP tokens

- [ ] Decide between:
  - **Option A** (preferred): mint a per-trial synthetic `userId` (e.g., `trial:{trialId}`) when calling `storeMcpToken()` from `handleDiscoveryAgentStart`. D1 `created_by` values then become trial-unique and future admin queries keyed on `userId` cannot aggregate across trials.
  - **Option B**: keep the sentinel `TRIAL_ANONYMOUS_USER_ID` but add an explicit comment in `McpTokenData` and each MCP route handler documenting that `userId === TRIAL_ANONYMOUS_USER_ID` must never be used as a cross-project authorization discriminator.
- [ ] Add a test that the sentinel userId alone cannot authorize access to a different trial's projectId (confirms `projectId` is the isolation boundary, not `userId`).

**Why:** Every concurrent trial currently shares the same `userId = 'system_anonymous_trials'` in the MCP token. The auditor flagged no active privilege-escalation vector (projectId scoping is enforced in all current handlers), but this is a data-integrity tripwire: any future query or admin tool that lists "all drafts for a user" would aggregate across every concurrent trial.

#### MEDIUM findings (deferrable, fix opportunistically)

- [ ] **M-1**: Validate `body.default_branch` return value in `fetchDefaultBranch()` against `^[A-Za-z0-9/_.-]{1,250}$` with rejection of leading hyphens before persisting, so a crafted GitHub API response can't surface strings like `--upload-pack=...` that would be interpreted as git flags in `bootstrap.go:728`.
- [ ] **M-2**: Null out `state.mcpToken` in DO storage after `state.agentStartedOnVm = true` so the token only lives in KV where it's operationally needed. `getStatus()` redacts correctly today, but defence-in-depth against future admin endpoints that might expose raw DO state.
- [ ] **M-3**: Rename ACP transition `reason` strings to accurately describe orchestrator-driven assertion vs. VM-agent confirmation — e.g., `trial_orchestrator.subprocess_launch_called_unconfirmed` instead of `agent_subprocess_started` — so audit logs don't imply VM confirmation that never happened. Or: poll VM agent session-status before transitioning to `running` so `trial.ready` only fires after real liveness.

#### LOW findings (nice-to-have)

- [ ] **L-1**: In `nodeAgentRequest()`, redact `token`/`secret`/`authorization` fields from VM-agent error response bodies before including them in thrown error messages (they can otherwise leak into `trial_orchestrator_do.step_error` log events).
- [ ] **L-2**: Audit the frontend `trial.knowledge` renderer to confirm it treats `observation` strings as plain text (GitHub description/README content is emitted raw from the knowledge fast-path and not sanitized server-side).
- [ ] **L-3**: No action needed — `fetchDefaultBranch()` `owner`/`repo` log values are already safe due to upstream `parseGithubRepoUrl()` validation. Documented for closure.

## References

- test-engineer review: `/tmp/claude-1000/-workspaces-simple-agent-manager/f0d339c6-df20-4346-9a46-56359d6580eb/tasks/a9fe37c165e38c6a2.output`
- task-completion-validator re-review: `/tmp/claude-1000/-workspaces-simple-agent-manager/f0d339c6-df20-4346-9a46-56359d6580eb/tasks/a3dbf4bc16eefef2a.output`
- security-auditor review: `/tmp/claude-1000/-workspaces-simple-agent-manager/f0d339c6-df20-4346-9a46-56359d6580eb/tasks/aaa5e7c8e74b36d90.output`
- `.claude/rules/25-review-merge-gate.md` (MINOR findings may be deferred to backlog; CRITICAL/HIGH cannot)
- `.claude/rules/10-e2e-verification.md` (capability-test requirements)
