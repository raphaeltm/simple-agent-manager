# Split shared types.ts and constants.ts into domain-specific files

## Problem

`packages/shared/src/types.ts` (1,702 lines) and `packages/shared/src/constants.ts` (731 lines) both exceed the 500-line file size limit. They need to be split into domain-specific modules with barrel re-exports.

## Research Findings

- `types.ts` has clear section markers (`// === Section ===`) delineating domains
- `constants.ts` imports `VMSize` and `WorkspaceProfile` from `types.ts` — cross-references exist
- `index.ts` currently uses `export *` for all modules — the domain barrels (`types/index.ts`, `constants/index.ts`) will use named re-exports; the top-level `index.ts` keeps `export *` from barrels since the barrels themselves enforce named exports
- Some types in `types.ts` also export runtime values (const arrays like `TASK_EXECUTION_STEPS`, `ACP_SESSION_DEFAULTS`, `NOTIFICATION_TYPES`, etc.)
- `constants.ts` exports an interface (`ScalingParamMeta`, `ProviderHelpMeta`, `LocationMeta`) — these should stay co-located with their constants
- All downstream consumers import from `@simple-agent-manager/shared` (the barrel), so internal restructuring is transparent

## Implementation Checklist

### Types Split
- [x] Create `packages/shared/src/types/` directory
- [x] Create `types/user.ts` — User, AdminUser, UserRole, UserStatus, Credential types (~124 lines)
- [x] Create `types/project.ts` — Project, ProjectData, CreateProject, UpdateProject types (~142 lines)
- [x] Create `types/workspace.ts` — Workspace, Node, VM types, BootLog, Event, DetectedPort, BrowserSidecar, BootstrapToken types (~407 lines)
- [x] Create `types/task.ts` — Task, TaskStatus, TaskMode, TaskExecution, Attachments, Submit/Run/List types (~294 lines)
- [x] Create `types/session.ts` — ChatSession, AgentSession, AcpSession, Worktree, Terminal, WorkspaceTab types (~304 lines)
- [x] Create `types/notification.ts` — Notification types and WebSocket messages (~81 lines)
- [x] Create `types/provider.ts` — ProviderCatalog, LocationInfo, SizeInfo types (~47 lines)
- [x] Create `types/activity.ts` — ActivityEvent types (~25 lines)
- [x] Create `types/admin.ts` — Admin observability types (~103 lines)
- [x] Create `types/agent-settings.ts` — AgentSettings, AgentProfile, ResolvedAgentProfile types (~123 lines)
- [x] Create `types/github.ts` — GitHub Installation, Repository, Branch, Connection types (~65 lines)
- [x] Create `types/api-error.ts` — ApiError interface (~8 lines)
- [x] Create `types/index.ts` — barrel with named re-exports (~242 lines)
- [x] Delete original `types.ts`

### Constants Split
- [x] Create `packages/shared/src/constants/` directory
- [x] Create `constants/vm-sizes.ts` — VM_SIZE_LABELS, VM_SIZE_CONFIG
- [x] Create `constants/providers.ts` — PROVIDER_LABELS, PROVIDER_HELP, PROVIDER_LOCATIONS, location functions
- [x] Create `constants/status.ts` — STATUS_LABELS, STATUS_COLORS
- [x] Create `constants/defaults.ts` — DEFAULT_VM_SIZE, DEFAULT_VM_LOCATION, limits, workspace name
- [x] Create `constants/task-execution.ts` — Task runner, stuck task, step retries
- [x] Create `constants/node-pooling.ts` — Warm timeout, lifecycle, idle timeout constants
- [x] Create `constants/scaling.ts` — Scaling params, min/max values, ScalingParamMeta, resolveProjectScalingConfig
- [x] Create `constants/hetzner.ts` — Hetzner/Scaleway/GCP defaults
- [x] Create `constants/gcp-deployment.ts` — GCP deployment constants
- [x] Create `constants/ai-services.ts` — Task title, context summary, TTS constants
- [x] Create `constants/agent-settings.ts` — VALID_PERMISSION_MODES, labels, descriptions
- [x] Create `constants/notifications.ts` — Notification defaults, limits, categories
- [x] Create `constants/index.ts` — barrel with named re-exports
- [x] Delete original `constants.ts`

### Integration
- [x] Top-level `index.ts` keeps `export *` from `./types` and `./constants` (domain barrels enforce named exports)
- [x] Run `pnpm typecheck` — all 18 packages pass
- [x] Run `pnpm build` — all 11 packages pass
- [x] Run `pnpm test` — all 22 suites pass (3 source-contract tests updated for new paths)
- [x] Run `pnpm lint` — all 8 packages pass

## Acceptance Criteria

- [x] No file exceeds 500 lines (excluding test files) — largest: workspace.ts at 407 lines
- [x] All domain barrel files use named re-exports (not `export *`) — types/index.ts and constants/index.ts
- [x] All existing imports across the monorepo continue to work without changes
- [x] `pnpm typecheck && pnpm build && pnpm test && pnpm lint` all pass
- [x] Original `types.ts` and `constants.ts` are deleted

## Notes

- Fixed pre-existing test bug: `DEFAULT_TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS` test had `expectedValue: '15'` but actual value is `30 * 60 * 1000`. The substring `'15'` was coincidentally matching other content in the old monolithic file.
- Top-level `index.ts` keeps `export *` from barrels — this is the standard pattern when sub-barrels already enforce named exports. Changing it would require re-exporting ~200 symbols which adds maintenance burden with no benefit.

## References

- `.claude/rules/18-file-size-limits.md`
- `packages/shared/src/types.ts`
- `packages/shared/src/constants.ts`
- `packages/shared/src/index.ts`
