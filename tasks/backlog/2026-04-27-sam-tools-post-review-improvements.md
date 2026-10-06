# SAM Tools Post-Review Improvements

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** the dynamic import in `retry_subtask` is gone (static imports at
>   `apps/api/src/durable-objects/sam-session/tools/retry-subtask.ts:7-32`).
> - **Still open:** files are under `apps/api/src/durable-objects/sam-session/tools/`.
>   - Session lookup by recency, not canonical ID: `stop-subtask.ts:92-100`,
>     `send-message-to-subtask.ts:117-127`.
>   - No `projectId` check on the workspace query: `stop-subtask.ts:81-87`,
>     `send-message-to-subtask.ts:92-101`.
>   - `errorMessage.includes('409')`: `send-message-to-subtask.ts:173`.
>   - `newDescription` has no length limit: `retry-subtask.ts:139`.
>   - `list_ideas` still accepts `completed` and `cancelled`: `list-ideas.ts:53`.
>   - `get_ci_status`: overall status still scans every run (`get-ci-status.ts:117-123`), and the
>     `api_error` response still includes `repository` (`:99-101`).
>   - `find_related_ideas` searches drafts only and its description does not say so
>     (`find-related-ideas.ts:88`).
>   - The listed test gaps. `apps/api/tests/unit/durable-objects/sam-tools-phase-b.test.ts` has
>     only rejection tests plus stop-without-workspace; `sam-tools-phase-d.test.ts` has no success
>     tests for `list_ideas` or `find_related_ideas`. Phase B tool registration is checked, but
>     through `executeTool` (`sam-tools-phase-b.test.ts:571`), not a `SAM_TOOLS` array check.
>   - Not re-checked: the tighter ownership-rejection assertions.
> - **Moot/dropped:** the null-`installationId` guard. `projects.installation_id` is NOT NULL
>   (`apps/api/src/db/schema.ts:409-411`); Artifacts projects use a sentinel installation.

**Created**: 2026-04-27
**Source**: Late-arriving cloudflare-specialist, security-auditor, and test-engineer reviews on PR #832 (already merged)

## Context

Both specialist reviews arrived after PR #832 was merged. HIGH findings (batched D1 writes, sanitized error messages, DB-verified project.id) were already addressed before merge. These are the remaining MEDIUM/LOW improvements.

## Checklist

### MEDIUM Priority

- [ ] **Canonical session routing in stop_subtask and send_message_to_subtask**: Replace recency-based agent session lookup (`MAX(createdAt) WHERE status = 'running'`) with canonical `workspace.chatSessionId` lookup per `.claude/rules/06-technical-patterns.md`
- [ ] **Workspace ownership re-verification in stop_subtask**: Add `workspace.projectId = task.projectId` to the inner workspace query as defense-in-depth
- [ ] **Convert dynamic import in retry_subtask**: Change `await import('../../../services/provider-credentials')` to a static top-level import
- [ ] **Replace 409 string matching in send_message_to_subtask**: Replace `errorMessage.includes('409')` with typed/structured error check
- [ ] **Bound retry_subtask newDescription length**: Apply `SAM_DISPATCH_MAX_DESCRIPTION_LENGTH` (or dedicated var) to `newDescription` before storing — currently unbounded unlike `dispatch_task`
- [ ] **Restrict list_ideas status scope**: Limit to `draft` and `ready` only (not `completed`/`cancelled` which are historical execution records, not ideas)

### LOW Priority

- [ ] **Fix get_ci_status overallStatus logic**: Evaluate only the most recent run, not `runs.some(r => r.conclusion === 'failure')` across the window
- [ ] **Add status filter to find_related_ideas**: Either add a `status` parameter or update the description to clarify it only searches draft ideas
- [ ] **Guard for null installationId in retry_subtask**: Handle Artifacts-backed projects (no GitHub installation) before calling `startTaskRunnerDO`
- [ ] **Tighten test assertions**: Assert specific error messages on ownership rejection paths; add test with mismatched userId row (Rule 28 IDOR invariant)
- [ ] **Remove repository from get_ci_status api_error response**: Inconsistent with catch block; unnecessary in error path
- [ ] **Add workspace projectId defense-in-depth join**: Add `workspace.projectId = task.projectId` filter in stop_subtask and send_message_to_subtask workspace lookups

### Test Coverage Gaps (from test-engineer review)

- [ ] **retry_subtask happy path**: Full happy path test (credentials resolved, title generated, task inserted, session created, runner started) — most complex tool, near-zero happy-path coverage
- [ ] **stop_subtask workspace-present path**: Test the branch where task has a workspace, agent session found, `stopAgentSessionOnNode` called
- [ ] **stop_subtask session stop failure**: Test `stopAgentSessionOnNode` throws — best-effort catch should not propagate
- [ ] **send_message_to_subtask delivery happy path**: Test successful delivery returns `{ delivered: true }`
- [ ] **send_message_to_subtask 409/mailbox path**: Test agent-busy queues to mailbox, and no-chatSessionId variant
- [ ] **cancel/pause/resume orchestrator returns false**: Test error paths when orchestrator service returns false
- [ ] **list_ideas and find_related_ideas success paths**: Add basic happy-path tests returning results
- [ ] **Phase B SAM_TOOLS array check**: Add `expect(toolNames).toContain('stop_subtask')` style assertions matching Phase D pattern

## Acceptance Criteria

- [ ] All MEDIUM items addressed
- [ ] Test coverage gaps addressed (at minimum retry_subtask happy path and send_message delivery)
- [ ] No regressions in existing Phase B/C/D tests
