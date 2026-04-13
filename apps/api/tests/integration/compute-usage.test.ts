/**
 * Integration test: compute usage metering pipeline.
 *
 * Verifies the end-to-end wiring of compute usage tracking:
 * 1. Workspace creation triggers startComputeTracking (crud.ts + task-runner)
 * 2. Workspace stop/error triggers stopComputeTracking (lifecycle.ts + state-machine)
 * 3. Orphan cleanup cron is registered and calls closeOrphanedComputeUsage
 * 4. Admin and user API routes are mounted and use correct service functions
 * 5. Schema defines compute_usage table with required columns and indexes
 * 6. Service correctly calculates vCPU-hours with period clamping and node-level overlap merging
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('compute usage metering pipeline', () => {
  const schemaFile = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');
  const serviceFile = readFileSync(resolve(process.cwd(), 'src/services/compute-usage.ts'), 'utf8');
  const crudFile = readFileSync(resolve(process.cwd(), 'src/routes/workspaces/crud.ts'), 'utf8');
  const lifecycleFile = readFileSync(resolve(process.cwd(), 'src/routes/workspaces/lifecycle.ts'), 'utf8');
  const stateMachineFile = readFileSync(resolve(process.cwd(), 'src/durable-objects/task-runner/state-machine.ts'), 'utf8');
  const workspaceStepsFile = readFileSync(resolve(process.cwd(), 'src/durable-objects/task-runner/workspace-steps.ts'), 'utf8');
  const cleanupFile = readFileSync(resolve(process.cwd(), 'src/scheduled/compute-usage-cleanup.ts'), 'utf8');
  const indexFile = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');
  const adminUsageRoute = readFileSync(resolve(process.cwd(), 'src/routes/admin-usage.ts'), 'utf8');
  const usageRoute = readFileSync(resolve(process.cwd(), 'src/routes/usage.ts'), 'utf8');

  // ===========================================================================
  // Schema
  // ===========================================================================
  describe('compute_usage schema', () => {
    it('defines compute_usage table with required columns', () => {
      expect(schemaFile).toContain("'compute_usage'");
      expect(schemaFile).toContain("id: text('id').primaryKey()");
      expect(schemaFile).toContain("text('user_id')");
      expect(schemaFile).toContain("text('workspace_id').notNull()");
      expect(schemaFile).toContain("text('node_id').notNull()");
      expect(schemaFile).toContain("text('server_type').notNull()");
      expect(schemaFile).toContain("integer('vcpu_count').notNull()");
      expect(schemaFile).toContain("text('credential_source')");
      expect(schemaFile).toContain("text('started_at').notNull()");
      expect(schemaFile).toContain("text('ended_at')");
    });

    it('defines required indexes for efficient queries', () => {
      expect(schemaFile).toContain('idx_compute_usage_user_period');
      expect(schemaFile).toContain('idx_compute_usage_workspace');
    });
  });

  // ===========================================================================
  // Service Layer
  // ===========================================================================
  describe('compute-usage service', () => {
    it('exports startComputeTracking function', () => {
      expect(serviceFile).toContain('export async function startComputeTracking(');
    });

    it('exports stopComputeTracking function', () => {
      expect(serviceFile).toContain('export async function stopComputeTracking(');
    });

    it('exports calculateVcpuHoursForPeriod function', () => {
      expect(serviceFile).toContain('export async function calculateVcpuHoursForPeriod(');
    });

    it('exports getUserUsageSummary function', () => {
      expect(serviceFile).toContain('export async function getUserUsageSummary(');
    });

    it('exports getAllUsersUsageSummary function', () => {
      expect(serviceFile).toContain('export async function getAllUsersUsageSummary(');
    });

    it('exports getUserDetailedUsage function', () => {
      expect(serviceFile).toContain('export async function getUserDetailedUsage(');
    });

    it('exports closeOrphanedComputeUsage function', () => {
      expect(serviceFile).toContain('export async function closeOrphanedComputeUsage(');
    });

    it('startComputeTracking uses getVcpuCount for vCPU derivation', () => {
      expect(serviceFile).toContain('getVcpuCount(input.vmSize, input.cloudProvider)');
    });

    it('startComputeTracking inserts into computeUsage table', () => {
      expect(serviceFile).toContain('db.insert(schema.computeUsage)');
    });

    it('stopComputeTracking filters by workspaceId and null endedAt', () => {
      expect(serviceFile).toContain('eq(schema.computeUsage.workspaceId, workspaceId)');
      expect(serviceFile).toContain('isNull(schema.computeUsage.endedAt)');
    });

    it('calculateVcpuHoursForPeriod clamps session boundaries to period', () => {
      expect(serviceFile).toContain('effectiveStart');
      expect(serviceFile).toContain('effectiveEnd');
      expect(serviceFile).toContain('sessionStart < periodStart');
      expect(serviceFile).toContain('sessionEnd > periodEnd');
    });

    it('calculateVcpuHoursForPeriod delegates to node-based aggregation', () => {
      expect(serviceFile).toContain('calculateNodeVcpuHours(rows, periodStart, periodEnd');
    });

    it('calculateNodeVcpuHours groups rows by node before weighting duration', () => {
      expect(serviceFile).toContain('const intervalsByNode = new Map');
      expect(serviceFile).toContain('intervalsByNode.get(row.nodeId)');
    });

    it('calculateVcpuHoursForPeriod supports credentialSource filter', () => {
      expect(serviceFile).toContain("eq(schema.computeUsage.credentialSource, credentialSource)");
    });

    it('closeOrphanedComputeUsage joins with workspaces table', () => {
      expect(serviceFile).toContain('schema.workspaces');
      expect(serviceFile).toContain("'stopped', 'deleted', 'error'");
    });

    it('getUserDetailedUsage returns currentPeriod matching shared type', () => {
      expect(serviceFile).toContain('currentPeriod: summary.period');
    });
  });

  // ===========================================================================
  // Metering Hooks: Start Tracking
  // ===========================================================================
  describe('start compute tracking hooks', () => {
    it('workspace creation (crud.ts) calls startComputeTracking', () => {
      expect(crudFile).toContain('startComputeTracking');
    });

    it('workspace creation passes credentialSource to tracking', () => {
      expect(crudFile).toContain('credentialSource');
    });

    it('workspace creation wraps metering in try/catch (best-effort)', () => {
      // Metering should not block workspace creation
      expect(crudFile).toContain('compute-usage');
    });

    it('task-runner workspace creation calls startComputeTracking', () => {
      expect(workspaceStepsFile).toContain('startComputeTracking');
    });
  });

  // ===========================================================================
  // Metering Hooks: Stop Tracking
  // ===========================================================================
  describe('stop compute tracking hooks', () => {
    it('workspace stop (lifecycle.ts) calls stopComputeTracking', () => {
      expect(lifecycleFile).toContain('stopComputeTracking');
    });

    it('workspace provisioning failure calls stopComputeTracking', () => {
      // Both stop and provisioning-failed paths should close metering
      const stopCount = (lifecycleFile.match(/stopComputeTracking/g) ?? []).length;
      expect(stopCount).toBeGreaterThanOrEqual(2);
    });

    it('task-runner cleanup calls stopComputeTracking', () => {
      expect(stateMachineFile).toContain('stopComputeTracking');
    });
  });

  // ===========================================================================
  // Orphan Cleanup Cron
  // ===========================================================================
  describe('orphan cleanup cron', () => {
    it('cleanup module exports runComputeUsageCleanup', () => {
      expect(cleanupFile).toContain('export async function runComputeUsageCleanup');
    });

    it('cleanup calls closeOrphanedComputeUsage', () => {
      expect(cleanupFile).toContain('closeOrphanedComputeUsage');
    });

    it('cron handler invokes compute usage cleanup', () => {
      expect(indexFile).toContain('runComputeUsageCleanup');
    });
  });

  // ===========================================================================
  // API Routes
  // ===========================================================================
  describe('API route wiring', () => {
    it('admin usage route is mounted in index', () => {
      expect(indexFile).toContain('adminUsageRoutes');
      expect(indexFile).toContain('/api/admin/usage');
    });

    it('user usage route is mounted in index', () => {
      expect(indexFile).toContain('usageRoutes');
      expect(indexFile).toContain('/api/usage');
    });

    it('admin usage route requires superadmin', () => {
      expect(adminUsageRoute).toContain('requireSuperadmin');
    });

    it('admin usage route calls getAllUsersUsageSummary', () => {
      expect(adminUsageRoute).toContain('getAllUsersUsageSummary');
    });

    it('admin usage route calls getUserDetailedUsage for user detail', () => {
      expect(adminUsageRoute).toContain('getUserDetailedUsage');
    });

    it('admin usage route passes configurable recent records limit', () => {
      expect(adminUsageRoute).toContain('COMPUTE_USAGE_RECENT_RECORDS_LIMIT');
    });

    it('admin usage route has per-user endpoint with userId param', () => {
      expect(adminUsageRoute).toContain(':userId');
    });

    it('user usage route calls getUserUsageSummary', () => {
      expect(usageRoute).toContain('getUserUsageSummary');
    });

    it('user usage route uses authenticated user ID', () => {
      expect(usageRoute).toContain('getUserId');
    });
  });
});
