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

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import { log } from '../../src/lib/logger';
import { startComputeTrackingForNode } from '../../src/routes/workspaces/workspace-create-helpers';
import {
  calculateVcpuHoursForPeriod,
  startComputeTracking,
} from '../../src/services/compute-usage';
import { createSchemaTables, createSqliteD1 } from '../helpers/sqlite-d1';

describe('compute usage metering pipeline', () => {
  const schemaFile = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');
  const serviceFile = readFileSync(resolve(process.cwd(), 'src/services/compute-usage.ts'), 'utf8');
  const nodeUsageServiceFile = readFileSync(
    resolve(process.cwd(), 'src/services/node-usage.ts'),
    'utf8'
  );
  const workspaceCreateFile = readFileSync(
    resolve(process.cwd(), 'src/routes/workspaces/workspace-create.ts'),
    'utf8'
  );
  const lifecycleFile = readFileSync(
    resolve(process.cwd(), 'src/routes/workspaces/lifecycle.ts'),
    'utf8'
  );
  const stateMachineFile = readFileSync(
    resolve(process.cwd(), 'src/durable-objects/task-runner/state-machine.ts'),
    'utf8'
  );
  const finalizerFile = readFileSync(
    resolve(process.cwd(), 'src/services/workspace-lifecycle-finalizer.ts'),
    'utf8'
  );
  const workspaceStepsFile = readFileSync(
    resolve(process.cwd(), 'src/durable-objects/task-runner/workspace-steps.ts'),
    'utf8'
  );
  const cleanupFile = readFileSync(
    resolve(process.cwd(), 'src/scheduled/compute-usage-cleanup.ts'),
    'utf8'
  );
  const scheduledFile = readFileSync(resolve(process.cwd(), 'src/scheduled/handler.ts'), 'utf8');
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

    it('aggregates overlapping workspaces once using the CPU count booked from observed hardware', async () => {
      const sqlite = new Database(':memory:');
      try {
        createSchemaTables(sqlite, [schema.computeUsage]);
        const db = drizzle(createSqliteD1(sqlite), { schema });
        for (const workspaceId of ['workspace-1', 'workspace-2']) {
          await startComputeTracking(db, {
            userId: 'user-1',
            workspaceId,
            nodeId: 'node-1',
            vmSize: 'small',
            providerInstanceVcpuCount: 4,
            observedProviderInstanceVcpuCount: 8,
          });
        }
        // Later plan/observation changes cannot rewrite already-booked usage.
        sqlite.exec(`UPDATE compute_usage SET
          started_at = '2026-09-01T00:00:00.000Z', ended_at = '2026-09-01T01:00:00.000Z',
          provider_instance_vcpu_count = 16, observed_provider_instance_vcpu_count = 32`);
        expect(
          await calculateVcpuHoursForPeriod(
            db,
            'user-1',
            new Date('2026-09-01T00:00:00Z'),
            new Date('2026-09-01T01:00:00Z')
          )
        ).toBe(8);
      } finally {
        sqlite.close();
      }
    });

    it('calculateNodeVcpuHours groups rows by node before weighting duration', () => {
      expect(serviceFile).toContain('const intervalsByNode = new Map');
      expect(serviceFile).toContain('intervalsByNode.get(row.nodeId)');
    });

    it('calculateVcpuHoursForPeriod supports credentialSource filter', () => {
      expect(serviceFile).toContain('eq(schema.computeUsage.credentialSource, credentialSource)');
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
    it('workspace creation handler calls startComputeTracking', () => {
      expect(workspaceCreateFile).toContain('startComputeTracking');
    });

    it('workspace creation passes credentialSource to tracking', () => {
      expect(workspaceCreateFile).toContain('credentialSource');
    });

    it('durable fresh-node continuation meters after provider metadata and attachment, before readiness', () => {
      const durableOwner = readFileSync(resolve(process.cwd(), 'src/durable-objects/node-lifecycle-provisioning.ts'), 'utf8');
      const continuation = readFileSync(resolve(process.cwd(), 'src/services/direct-workspace-creation.ts'), 'utf8');
      expect(workspaceCreateFile).toContain('await scheduleDirectProvisioning(');
      const provisionCall = durableOwner.indexOf('await provisionNode(');
      expect(provisionCall).toBeGreaterThanOrEqual(0);
      expect(durableOwner.indexOf('await continueDirectWorkspaceCreation(')).toBeGreaterThan(provisionCall);

      const runningCheck = continuation.indexOf("provisionedNode.status !== 'running'");
      const attachCall = continuation.indexOf('await attachPrecreatedWorkspacePlacement(');
      const trackingCall = continuation.indexOf('await startComputeTrackingForNode(innerDb, {');
      const readinessCall = continuation.indexOf('await waitForNodeAgentReady(');
      expect(runningCheck).toBeGreaterThanOrEqual(0);
      expect(attachCall).toBeGreaterThan(runningCheck);
      expect(trackingCall).toBeGreaterThan(attachCall);
      expect(readinessCall).toBeGreaterThan(trackingCall);
    });

    it('workspace creation can continue when metering persistence fails', async () => {
      const sqlite = new Database(':memory:');
      const errorLog = vi.spyOn(log, 'error').mockImplementation(() => undefined);
      try {
        createSchemaTables(sqlite, [schema.nodes, schema.computeUsage]);
        sqlite.exec(`INSERT INTO nodes (id, provider_instance_vcpu_count) VALUES ('node-1', 8);
          CREATE TRIGGER reject_metering BEFORE INSERT ON compute_usage
          BEGIN SELECT RAISE(ABORT, 'metering write unavailable'); END;`);
        const db = drizzle(createSqliteD1(sqlite), { schema });
        await expect(
          startComputeTrackingForNode(db, {
            userId: 'user-1',
            workspaceId: 'workspace-1',
            nodeId: 'node-1',
            vmSize: 'small',
          })
        ).resolves.toBeUndefined();
        expect(errorLog).toHaveBeenCalledWith(
          'workspace.compute_tracking_start_failed',
          expect.objectContaining({
            workspaceId: 'workspace-1',
            error: expect.any(String),
          })
        );
        expect(sqlite.prepare('SELECT COUNT(*) AS count FROM compute_usage').get()).toEqual({
          count: 0,
        });
      } finally {
        errorLog.mockRestore();
        sqlite.close();
      }
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

    it('task-runner cleanup closes compute usage through the lifecycle finalizer', () => {
      expect(stateMachineFile).toContain('finalizeWorkspaceLifecycleClosure');
      expect(finalizerFile).toContain('UPDATE compute_usage');
      expect(finalizerFile).toContain('ended_at IS NULL');
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
      expect(scheduledFile).toContain('runComputeUsageCleanup');
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

    it('admin usage route calls getAllUsersNodeUsageSummary', () => {
      expect(adminUsageRoute).toContain('getAllUsersNodeUsageSummary');
    });

    it('admin usage route calls getUserNodeDetailedUsage for user detail', () => {
      expect(adminUsageRoute).toContain('getUserNodeDetailedUsage');
    });

    it('admin usage route passes configurable recent records limit', () => {
      expect(adminUsageRoute).toContain('COMPUTE_USAGE_RECENT_RECORDS_LIMIT');
    });

    it('admin usage route has per-user endpoint with userId param', () => {
      expect(adminUsageRoute).toContain(':userId');
    });

    it('user usage route calls getUserNodeUsageSummary', () => {
      expect(usageRoute).toContain('getUserNodeUsageSummary');
    });

    it('node usage service calculates billing from node lifetime', () => {
      expect(nodeUsageServiceFile).toContain('schema.nodes.createdAt');
      expect(nodeUsageServiceFile).toContain('calculateNodeVcpuHoursForPeriod');
      expect(nodeUsageServiceFile).toContain('schema.nodes.credentialSource');
      expect(nodeUsageServiceFile).toContain('opts.credentialSource');
    });

    it('user usage route uses authenticated user ID', () => {
      expect(usageRoute).toContain('getUserId');
    });
  });
});
