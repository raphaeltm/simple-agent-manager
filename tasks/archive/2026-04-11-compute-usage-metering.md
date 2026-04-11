# Compute Usage Metering (Phase 2)

## Problem

SAM needs vCPU-hour tracking per user per workspace so admins can see who's consuming compute resources. This is the foundation for Phase 3 (Compute Quotas) which will add enforcement. Phase 1 (platform credentials + credential_source tracking) is complete on `sam/phase-1-admin-level-01knxw`.

## Research Findings

### Database
- Latest migration: 0037 (`platform_credentials.sql`). Next is 0038.
- `nodes` table has `vmSize` (small/medium/large), `cloudProvider`, and `credentialSource` (user/platform).
- `workspaces` table has `vmSize`, `nodeId`, `userId`, `status`.
- No existing compute metering tables or patterns.
- ID generation uses `ulid()` from `apps/api/src/lib/ulid.ts`.

### Server Type → vCPU Mapping
The DB stores `vmSize` (small/medium/large), not provider-specific server types. vCPU counts vary by provider:
- **Hetzner**: small=cx23 (2 vCPU), medium=cx33 (4 vCPU), large=cx43 (8 vCPU)
- **Scaleway**: small=DEV1-M (3 vCPU), medium=DEV1-XL (4 vCPU), large=GP1-S (8 vCPU)
- **GCP**: small=e2-medium (1 vCPU), medium=e2-standard-2 (2 vCPU), large=e2-standard-4 (4 vCPU)

Decision: Store `server_type` as vmSize value. Derive `vcpu_count` from vmSize using the provider's `SizeConfig.vcpu` at recording time. Fallback: use Hetzner vCPU counts as default (2/4/8).

### Workspace Creation Paths
1. **User-initiated**: `apps/api/src/routes/workspaces/crud.ts` lines 112-240
2. **Task-runner**: `apps/api/src/durable-objects/task-runner/workspace-steps.ts` lines 16-161

### Workspace Status Transitions
- Stop: `apps/api/src/routes/workspaces/lifecycle.ts` (sets status to 'stopping' then 'stopped')
- Delete: `apps/api/src/routes/workspaces/lifecycle.ts` (sets status to 'deleted')
- Task failure: `apps/api/src/durable-objects/task-runner/state-machine.ts` (sets to 'stopped')
- Node cleanup sweep: `apps/api/src/scheduled/node-cleanup.ts` (orphaned workspace cleanup)

### Cron/Scheduled Handler
- Entry point: `apps/api/src/index.ts` lines 838-890
- Existing jobs: node cleanup, stuck tasks, observability purge, analytics forward, cron triggers
- Pattern: individual functions in `apps/api/src/scheduled/`

### Admin Routes Pattern
- Middleware: `requireAuth(), requireApproved(), requireSuperadmin()`
- Separate route files mounted in index.ts
- Examples: `admin.ts`, `admin-analytics.ts`, `admin-platform-credentials.ts`

### Admin UI Pattern
- Tab-based admin page: `apps/web/src/pages/Admin.tsx` with `ADMIN_TABS` array
- Sub-pages as separate files: `AdminUsers.tsx`, `AdminPlatformCredentials.tsx`, etc.
- Routes in `App.tsx` under `/admin` path
- API client functions in `apps/web/src/lib/api/admin.ts`

### Settings UI Pattern
- Tab-based: `apps/web/src/pages/Settings.tsx` with `BASE_TABS`
- Settings sub-routes with `SettingsContext` for shared state
- Routes in `App.tsx` under `/settings` path

## Implementation Checklist

### 1. Shared Constants
- [x] Add `VM_SIZE_VCPUS` mapping and `getVcpuCount()` to `packages/shared/src/constants/vm-sizes.ts`
- [x] Add compute usage types to `packages/shared/src/types/`
- [x] Export new types and constants from shared package index

### 2. D1 Migration (0038)
- [x] Create `apps/api/src/db/migrations/0038_compute_usage.sql` with `compute_usage` table
- [x] Add indexes: `idx_compute_usage_user_period`, `idx_compute_usage_workspace`

### 3. Drizzle Schema
- [x] Add `computeUsage` table definition to `apps/api/src/db/schema.ts`

### 4. Compute Usage Service
- [x] Create `apps/api/src/services/compute-usage.ts`
- [x] Implement `startComputeTracking(db, params)` — insert compute_usage row
- [x] Implement `stopComputeTracking(db, workspaceId)` — set ended_at
- [x] Implement `calculateVcpuHoursForPeriod(db, userId, start, end, credentialSource?)` — aggregate usage
- [x] Implement `getUserUsageSummary(db, userId)` — current period summary
- [x] Implement `getAllUsersUsageSummary(db)` — admin overview
- [x] Implement `getUserDetailedUsage(db, userId)` — admin per-user detail
- [x] Implement `closeOrphanedComputeUsage(db)` — crash safety cleanup

### 5. Metering Hooks
- [x] Hook `startComputeTracking` into workspace creation in `crud.ts` (user-initiated)
- [x] Hook `startComputeTracking` into workspace creation in `workspace-steps.ts` (task-runner)
- [x] Hook `stopComputeTracking` into workspace stop in `lifecycle.ts`
- [x] Hook `stopComputeTracking` into workspace delete in `crud.ts`
- [x] Hook `stopComputeTracking` into task-runner workspace cleanup (state-machine.ts)

### 6. Orphan Cleanup Cron
- [x] Create `apps/api/src/scheduled/compute-usage-cleanup.ts`
- [x] Register in cron handler in `index.ts` (run with existing sweep)

### 7. API Routes
- [x] Create `apps/api/src/routes/usage.ts` with user endpoint: `GET /api/usage/compute`
- [x] Add admin endpoints to existing admin routes or new file: `GET /api/admin/usage/compute`, `GET /api/admin/usage/compute/:userId`
- [x] Mount routes in `index.ts`

### 8. Admin UI
- [x] Add 'usage' tab to `ADMIN_TABS` in `Admin.tsx`
- [x] Create `apps/web/src/pages/AdminComputeUsage.tsx` — usage overview table
- [x] Add API client functions in `apps/web/src/lib/api/admin.ts`
- [x] Add route in `App.tsx`

### 9. User Settings UI
- [x] Add 'usage' tab to Settings tabs
- [x] Create `apps/web/src/pages/SettingsComputeUsage.tsx` — usage card
- [x] Add API client function for user usage
- [x] Add route in `App.tsx`

### 10. Tests
- [x] Unit tests for `getVcpuCount()` mapping
- [x] Unit tests for `calculateVcpuHoursForPeriod()` (completed, running, cross-period, credential filter)
- [x] Integration tests for metering hooks (start/stop tracking)
- [x] Integration tests for API endpoints (user + admin)
- [x] Unit test for orphan cleanup logic

## Acceptance Criteria

- [x] Workspace creation inserts a compute_usage row with correct vcpu_count and credential_source
- [x] Workspace stop/delete sets ended_at on the compute_usage row
- [x] Orphan cleanup cron closes compute_usage rows for stopped/deleted/missing workspaces
- [x] `GET /api/usage/compute` returns current period summary for authenticated user
- [x] `GET /api/admin/usage/compute` returns all users' summary (superadmin only)
- [x] `GET /api/admin/usage/compute/:userId` returns detailed usage (superadmin only)
- [x] Admin dashboard shows compute usage table sorted by usage
- [x] User settings shows compute usage card with period breakdown
- [x] All configurable values use env vars with defaults (Constitution Principle XI)

## References

- Idea: 01KNXVV6RPTZHK0CGD0D1BNH3E
- Phase 1 branch: `sam/phase-1-admin-level-01knxw`
- `apps/api/src/db/schema.ts`
- `packages/shared/src/constants/vm-sizes.ts`
- `packages/providers/src/hetzner.ts`, `scaleway.ts`, `gcp.ts`
- `apps/api/src/routes/admin.ts`
- `apps/api/src/scheduled/node-cleanup.ts`
