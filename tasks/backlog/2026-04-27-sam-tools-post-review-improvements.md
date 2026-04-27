# SAM Tools Post-Review Improvements

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
