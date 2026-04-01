# Split shared types.ts and constants.ts into domain-specific files

## Problem

`packages/shared/src/types.ts` (1,702 lines) and `packages/shared/src/constants.ts` (731 lines) both exceed the 500-line file size limit. They need to be split into domain-specific modules with barrel re-exports.

## Research Findings

- `types.ts` has clear section markers (`// === Section ===`) delineating domains
- `constants.ts` imports `VMSize` and `WorkspaceProfile` from `types.ts` — cross-references exist
- `index.ts` currently uses `export *` for all modules — needs to switch to named re-exports
- Some types in `types.ts` also export runtime values (const arrays like `TASK_EXECUTION_STEPS`, `ACP_SESSION_DEFAULTS`, `NOTIFICATION_TYPES`, etc.)
- `constants.ts` exports an interface (`ScalingParamMeta`, `ProviderHelpMeta`, `LocationMeta`) — these should stay co-located with their constants
- All downstream consumers import from `@simple-agent-manager/shared` (the barrel), so internal restructuring is transparent

## Implementation Checklist

### Types Split
- [ ] Create `packages/shared/src/types/` directory
- [ ] Create `types/user.ts` — User, AdminUser, UserRole, UserStatus, Credential types (~95 lines)
- [ ] Create `types/project.ts` — Project, ProjectData, CreateProject, UpdateProject, RuntimeEnv/File types (~230 lines)
- [ ] Create `types/workspace.ts` — Workspace, Node, VM types, BootLog, Event, DetectedPort, BrowserSidecar, BootstrapToken types (~375 lines)
- [ ] Create `types/task.ts` — Task, TaskStatus, TaskMode, TaskExecution, Attachments, Submit/Run/List types (~310 lines)
- [ ] Create `types/session.ts` — ChatSession, AgentSession, AcpSession, Worktree, Terminal, WorkspaceTab types (~280 lines)
- [ ] Create `types/notification.ts` — Notification types and WebSocket messages (~80 lines)
- [ ] Create `types/provider.ts` — ProviderCatalog, GCP OIDC, LocationInfo, SizeInfo types (~90 lines)
- [ ] Create `types/activity.ts` — ActivityEvent types (~25 lines)
- [ ] Create `types/admin.ts` — Admin observability types (PlatformError, HealthSummary, LogQuery, etc.) (~100 lines)
- [ ] Create `types/agent-settings.ts` — AgentSettings, AgentProfile, ResolvedAgentProfile types (~125 lines)
- [ ] Create `types/github.ts` — GitHub Installation, Repository, Branch, Connection types (~65 lines)
- [ ] Create `types/api-error.ts` — ApiError interface (~5 lines)
- [ ] Create `types/index.ts` — barrel with named re-exports
- [ ] Delete original `types.ts`

### Constants Split
- [ ] Create `packages/shared/src/constants/` directory
- [ ] Create `constants/vm-sizes.ts` — VM_SIZE_LABELS, VM_SIZE_CONFIG (~25 lines)
- [ ] Create `constants/providers.ts` — PROVIDER_LABELS, PROVIDER_HELP, PROVIDER_LOCATIONS, location functions (~130 lines)
- [ ] Create `constants/status.ts` — STATUS_LABELS, STATUS_COLORS (~20 lines)
- [ ] Create `constants/defaults.ts` — DEFAULT_VM_SIZE, DEFAULT_VM_LOCATION, limits, workspace name (~50 lines)
- [ ] Create `constants/task-execution.ts` — Task runner, stuck task, step retries (~60 lines)
- [ ] Create `constants/node-pooling.ts` — Warm timeout, lifecycle, idle timeout constants (~40 lines)
- [ ] Create `constants/scaling.ts` — Scaling params, min/max values, ScalingParamMeta, resolveProjectScalingConfig (~100 lines)
- [ ] Create `constants/hetzner.ts` — Hetzner/Scaleway/GCP defaults (~65 lines)
- [ ] Create `constants/gcp-deployment.ts` — GCP deployment constants (~30 lines)
- [ ] Create `constants/ai-services.ts` — Task title, context summary, TTS constants (~100 lines)
- [ ] Create `constants/agent-settings.ts` — VALID_PERMISSION_MODES, labels, descriptions (~25 lines)
- [ ] Create `constants/notifications.ts` — Notification defaults, limits, categories (~70 lines)
- [ ] Create `constants/index.ts` — barrel with named re-exports
- [ ] Delete original `constants.ts`

### Integration
- [ ] Update `packages/shared/src/index.ts` to re-export from `./types/index` and `./constants/index`
- [ ] Run `pnpm typecheck` to verify all downstream consumers compile
- [ ] Run `pnpm build` to verify build succeeds
- [ ] Run `pnpm test` to verify tests pass
- [ ] Run `pnpm lint` to verify no lint errors

## Acceptance Criteria

- [ ] No file exceeds 500 lines (excluding test files)
- [ ] All barrel files use named re-exports (not `export *`)
- [ ] All existing imports across the monorepo continue to work without changes
- [ ] `pnpm typecheck && pnpm build && pnpm test && pnpm lint` all pass
- [ ] Original `types.ts` and `constants.ts` are deleted

## References

- `.claude/rules/18-file-size-limits.md`
- `packages/shared/src/types.ts`
- `packages/shared/src/constants.ts`
- `packages/shared/src/index.ts`
