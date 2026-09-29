# Resource History Attribution

## Problem

VM resource-history uploads currently persist blank profile, skill, and agent-type attribution because the VM agent sends empty values and the API trusts those values except for a workspace profile hint. Future cross-session sizing and grouping needs server-authoritative attribution on every resource summary.

## Research Findings

- `storeWorkspaceResourceChunk()` resolves the workspace once, then currently reads `agentProfileId`, `skillId`, and `agentType` from the upload body. Those client fields must no longer be authoritative.
- `agent_sessions` stores the runtime's `agent_profile_id`, `skill_id`, and `agent_type`; task-backed sessions also persist `tasks.agent_profile_hint`, `tasks.skill_id`, `tasks.chat_session_id`, `tasks.project_id`, and `tasks.workspace_id`.
- The VM upload's `sessionId` is the ProjectData chat-session ID, while `agent_sessions.id` is a separate runtime-session ID. The current workspace and newest matching agent-session row provide the runtime link.
- Resource summary reads already serialize the three attribution columns through `publicSummary()`, and both HTTP routes and `get_resource_history` return that summary. Regression assertions are needed so these fields cannot silently disappear.
- The upload path is a mutation with a 12-round-trip budget. Attribution can be folded into the existing workspace lookup as one SQL query, keeping lookup cost at one round trip per upload.
- Existing summary rows can be repaired with a WHERE-scoped migration using correlated, project/workspace-scoped server records. The migration must update only null/blank fields and must never accept a cross-project task row.
- Real-SQL coverage belongs in the existing SQLite-backed service slice using `createSqliteD1` and `createSchemaTables`; migration behavior needs a real migration execution test as well.
- No VM-agent change is needed or allowed for this task.

## Implementation Checklist

- [x] Replace upload-body attribution with one server-side lookup that resolves the workspace, current agent session, and matching task within the requested project/workspace.
- [x] Prefer exact task attribution for task-backed history, use the current agent session as fallback, and derive agent type from validated profile/skill records when necessary.
- [x] Reject a client-supplied task ID that is not bound to the same project, workspace, and session.
- [x] Add a safe WHERE-scoped D1 migration that backfills only blank summary attribution from scoped server records.
- [x] Preserve and prove profile, skill, and agent type in HTTP resource-history responses and native/MCP `get_resource_history` output.
- [x] Add real-SQL multi-variant coverage for two same-project sessions with different attribution and a foreign-project row that cannot contribute attribution.
- [x] Add migration regression coverage and run migration-safety checks.
- [ ] Run focused and full validation, local specialist reviews, staging verification, PR/CodeRabbit review, merge, and production deploy monitoring.

## Acceptance Criteria

- Upload attribution comes only from authoritative server rows scoped to the same project and workspace; client-supplied attribution cannot override it.
- Attribution is resolved once per upload and the callback remains within the mutation I/O budget.
- Existing null or empty attribution is backfilled without an unscoped update and without cross-project leakage.
- HTTP resource-history reads and `get_resource_history` include `agentProfileId`, `skillId`, and `agentType`.
- A real SQLite/D1 test distinguishes two sessions' profiles and skills in one project and proves a foreign-project record does not leak.
- The VM agent is unchanged.

## References

- `apps/api/src/services/workspace-resource-history.ts`
- `apps/api/src/routes/projects/workspace-resource-history-callback.ts`
- `apps/api/src/durable-objects/sam-session/tools/get-resource-history.ts`
- `apps/api/src/db/migrations/0169_workspace_resource_history.sql`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/60-request-io-and-bundle-budgets.md`
- `tasks/archive/2026-09-20-workspace-resource-history.md`
