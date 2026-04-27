# SAM Tools Post-Review Improvements

**Created**: 2026-04-27
**Source**: Late-arriving cloudflare-specialist review on PR #832 (already merged)

## Context

The cloudflare-specialist review arrived after PR #832 was merged. HIGH findings (batched D1 writes) were already addressed before merge. These are the remaining MEDIUM/LOW improvements.

## Checklist

### MEDIUM Priority

- [ ] **Canonical session routing in stop_subtask and send_message_to_subtask**: Replace recency-based agent session lookup (`MAX(createdAt) WHERE status = 'running'`) with canonical `workspace.chatSessionId` lookup per `.claude/rules/06-technical-patterns.md`
- [ ] **Workspace ownership re-verification in stop_subtask**: Add `workspace.projectId = task.projectId` to the inner workspace query as defense-in-depth
- [ ] **Convert dynamic import in retry_subtask**: Change `await import('../../../services/provider-credentials')` to a static top-level import
- [ ] **Replace 409 string matching in send_message_to_subtask**: Replace `errorMessage.includes('409')` with typed/structured error check

### LOW Priority

- [ ] **Fix get_ci_status overallStatus logic**: Evaluate only the most recent run, not `runs.some(r => r.conclusion === 'failure')` across the window
- [ ] **Add status filter to find_related_ideas**: Either add a `status` parameter or update the description to clarify it only searches draft ideas
- [ ] **Guard for null installationId in retry_subtask**: Handle Artifacts-backed projects (no GitHub installation) before calling `startTaskRunnerDO`
- [ ] **Tighten test assertions**: Assert specific error messages on ownership rejection paths; add test with mismatched userId row

## Acceptance Criteria

- [ ] All MEDIUM items addressed
- [ ] Tests updated for any behavioral changes
- [ ] No regressions in existing 24 Phase B tests
