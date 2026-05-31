# Resource Override Audit Slice

## Problem

Implement the first audit-only slice for task/session/trigger-level resource requirements below agent profiles. The system should resolve and persist resource intent and provenance across task start paths without changing scheduler placement behavior or implementing reservation-aware node claiming.

Important constraint: this work must stop at a draft or clearly do-not-merge PR. Do not mark ready and do not merge to production without explicit Raphaël authorization.

## Research Findings

- Shared resource scaffolding already exists in `packages/shared/src/types/resource.ts` and `packages/shared/src/constants/resource-defaults.ts`, but it needs validation hardening and a clearer resolver contract for concrete scheduling reservations.
- D1 audit columns for `tasks` and `workspaces` already exist in migration `0056_resource_requirements_audit.sql`; further schema changes must be additive only.
- `apps/api/src/routes/tasks/submit.ts`, `apps/api/src/services/trigger-submit.ts`, `apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts`, `apps/api/src/durable-objects/sam-session/tools/retry-subtask.ts`, `apps/api/src/routes/mcp/dispatch-tool.ts`, and `apps/api/src/routes/mcp/orchestration-tools.ts` contain separate resolution code that can drift.
- `apps/api/src/routes/tasks/run.ts` still lacks resource audit resolution and task snapshot persistence.
- Agent profiles and projects currently have VM/provider/location/workspace defaults but no resource-requirements default JSON fields.
- Triggers currently support `vmSizeOverride` but no trigger-level resource requirements JSON.
- TaskRunner start input already accepts `resourceRequirements` and `resolvedReservation`; the DO types and workspace creation path need verification so audit snapshots reach workspaces.
- Relevant postmortems:
  - `docs/notes/2026-04-25-migration-cascade-data-loss-postmortem.md`: never recreate/drop FK parent tables; use additive migrations.
  - `docs/notes/2026-05-01-vm-size-minimum-selection-postmortem.md`: resource selection constraints need behavioral tests, and this PR must prove placement selection is unchanged.
  - `docs/notes/2026-05-12-task-callback-middleware-leak-postmortem.md`: route/middleware changes should avoid wildcard auth leakage.

## Checklist

- [x] Add/adjust shared resource types and validation helpers for concrete scheduling reservations.
- [x] Add additive D1 columns for project, profile, and trigger resource defaults/overrides as JSON snapshots.
- [x] Add a shared API resolver helper for resource requirements and VM/provider/location/workspace/task-mode audit snapshots.
- [x] Wire resolver consistently through task submit, trigger submit, SAM dispatch, MCP dispatch, retry/fork, and active task run paths.
- [x] Persist resolved task snapshots and pass resolved reservation snapshots into TaskRunner DO.
- [x] Verify workspace audit fields are populated by TaskRunner workspace creation without changing placement behavior.
- [x] Add tests for precedence, validation, persisted snapshots, MCP taskMode default, and no scheduler placement behavior change.
- [x] Run migration safety and relevant quality checks.
- [x] Run Cloudflare specialist and constitution validator review before finalizing.
- [x] Open draft/do-not-merge PR and stop.

## Acceptance Criteria

- Resource requirements precedence is explicit and tested: task/session/trigger override > agent profile default > project default > platform default.
- Invalid resource requirements fail validation before persistence.
- Existing behavior is preserved when no resource requirements are configured.
- Scheduler placement and node selection behavior are unchanged in this PR.
- Task and workspace audit state includes resolved resource intent/provenance and requested VM/provider/location/workspace/task-mode snapshots where currently missing.
- MCP dispatch continues to default omitted `taskMode` to `task`, including lightweight workspace submissions.
- All migrations are additive and pass migration safety checks.
- PR is draft or clearly do-not-merge, with validation notes, and is not merged.

## References

- Idea `01KRAHJ0R7Y9N0EVS27JKYT8PF`
- Idea `01KNKRCS8DSX8FREC02AJV23QH`
- Idea `01KS69DPZJV4EXVM6CRNJGCARN`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/35-vertical-slice-testing.md`
