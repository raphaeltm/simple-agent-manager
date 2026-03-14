# Lightweight Workspace Profile — Contract Gap + Test Coverage

## Problem

The lightweight workspace profile feature (`WorkspaceProfile = 'full' | 'lightweight'`) is fully wired end-to-end through the codebase (UI -> API -> TaskRunner DO -> node-agent service -> VM agent -> bootstrap), but has:

1. **Contract gap**: The shared `CreateWorkspaceAgentRequestSchema` (vm-agent-contract.ts:63) does not include the `lightweight` field, even though the API sends it and the VM agent accepts it.
2. **Zero test coverage**: No unit, integration, or contract tests verify the lightweight path at any layer.

## Research Findings

### Data Path (Verified — All Steps Wired)

| Step | Component | File | Status |
|------|-----------|------|--------|
| 1 | Type + constants | `packages/shared/src/types.ts:680`, `constants.ts:84-85` | Wired |
| 2 | DB schema | `apps/api/src/db/schema.ts:192`, migration 0024 | Wired |
| 3 | UI task form | `apps/web/src/components/task/TaskSubmitForm.tsx:193-200` | Wired |
| 4 | UI settings | `apps/web/src/components/project/SettingsDrawer.tsx:31-34,177-191` | Wired |
| 5 | API submit | `apps/api/src/routes/tasks/submit.ts:81-83,169-171,326` | Wired |
| 6 | API run | `apps/api/src/routes/tasks/run.ts:136-138,161-163,252` | Wired |
| 7 | Project PATCH | `apps/api/src/routes/projects/crud.ts:567-569,604` | Wired |
| 8 | TaskRunner DO | `apps/api/src/durable-objects/task-runner.ts:109-110,664` | Wired |
| 9 | Node-agent svc | `apps/api/src/services/node-agent.ts:194,201` | Wired |
| 10 | VM agent parse | `packages/vm-agent/internal/server/workspaces.go:244,270` | Wired |
| 11 | VM routing | `packages/vm-agent/internal/server/workspace_routing.go:26,154,226` | Wired |
| 12 | VM provisioning | `packages/vm-agent/internal/server/workspace_provisioning.go:109,174` | Wired |
| 13 | VM bootstrap | `packages/vm-agent/internal/bootstrap/bootstrap.go:84,256-267` | Wired |
| 14 | VM persistence | `packages/vm-agent/internal/persistence/store.go:35,189-192` | Wired |

### Gaps Found

1. **Contract schema gap**: `CreateWorkspaceAgentRequestSchema` at `packages/shared/src/vm-agent-contract.ts:63` is missing `lightweight: z.boolean().optional()`. The VM agent Go struct has it (`workspaces.go:244`), but the shared Zod schema does not.
2. **Zero tests**: No tests anywhere for `workspaceProfile`/`lightweight` at any layer.

## Implementation Checklist

- [ ] Add `lightweight` field to `CreateWorkspaceAgentRequestSchema` in `packages/shared/src/vm-agent-contract.ts`
- [ ] Add contract test: `CreateWorkspaceAgentRequestSchema` validates payload with `lightweight: true`
- [ ] Add contract test: `CreateWorkspaceAgentRequestSchema` validates payload without `lightweight` (backward compat)
- [ ] Add API unit test: task submit with `workspaceProfile: 'lightweight'` passes validation
- [ ] Add API unit test: task submit with invalid `workspaceProfile` returns 400
- [ ] Add API unit test: task submit falls back to project default workspace profile
- [ ] Add API unit test: task submit falls back to platform default (`full`) when no project default
- [ ] Add API unit test: project PATCH with `defaultWorkspaceProfile: 'lightweight'` succeeds
- [ ] Add API unit test: project PATCH with invalid workspace profile returns 400
- [ ] Add Go unit test: workspace creation with `lightweight: true` sets runtime flag
- [ ] Add Go unit test: workspace creation without `lightweight` defaults to false
- [ ] Add Go unit test: lightweight flag persists through persistence store round-trip
- [ ] Add Go unit test: lightweight runtime propagates to ProvisionState in provisioning

## Acceptance Criteria

- [ ] `CreateWorkspaceAgentRequestSchema` includes `lightweight` field
- [ ] Existing node-agent contract tests pass with the updated schema
- [ ] At least 4 TypeScript tests cover workspace profile validation and precedence
- [ ] At least 3 Go tests cover lightweight flag parsing, persistence, and provisioning
- [ ] All existing tests continue to pass (no regressions)
- [ ] `pnpm lint && pnpm typecheck && pnpm test && pnpm build` all green

## References

- Design doc: `docs/design/quick-chat-mode.md`
- Prior task: `tasks/backlog/2026-03-09-quick-chat-mode-design.md`
- VM agent contract: `packages/shared/src/vm-agent-contract.ts`
- Rule 10 (e2e verification): `.claude/rules/10-e2e-verification.md`
