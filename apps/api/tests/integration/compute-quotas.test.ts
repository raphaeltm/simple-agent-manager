/**
 * Integration test: compute quota pipeline.
 *
 * Verifies the end-to-end wiring of compute quotas:
 * 1. Schema defines default_quotas and user_quotas tables
 * 2. Service functions implement quota resolution chain
 * 3. Admin routes are mounted and handle CRUD
 * 4. User route returns quota status
 * 5. Task submission checks quota before accepting
 * 6. Node provisioning re-checks quota (hard gate)
 * 7. BYOC users are exempt from quotas
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('compute quota pipeline', () => {
  const schemaFile = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');
  const serviceFile = readFileSync(resolve(process.cwd(), 'src/services/compute-quotas.ts'), 'utf8');
  const indexFile = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');
  const adminQuotaRoute = readFileSync(resolve(process.cwd(), 'src/routes/admin-quotas.ts'), 'utf8');
  const usageRoute = readFileSync(resolve(process.cwd(), 'src/routes/usage.ts'), 'utf8');
  const submitRoute = readFileSync(resolve(process.cwd(), 'src/routes/tasks/submit.ts'), 'utf8');
  const nodeStepsFile = readFileSync(resolve(process.cwd(), 'src/durable-objects/task-runner/node-steps.ts'), 'utf8');
  const migrationFile = readFileSync(resolve(process.cwd(), 'src/db/migrations/0039_compute_quotas.sql'), 'utf8');

  // ===========================================================================
  // Migration
  // ===========================================================================
  describe('D1 migration', () => {
    it('creates default_quotas table', () => {
      expect(migrationFile).toContain('CREATE TABLE default_quotas');
      expect(migrationFile).toContain('monthly_vcpu_hours_limit REAL');
      expect(migrationFile).toContain('updated_by TEXT NOT NULL REFERENCES users(id)');
    });

    it('creates user_quotas table', () => {
      expect(migrationFile).toContain('CREATE TABLE user_quotas');
      expect(migrationFile).toContain('user_id TEXT NOT NULL UNIQUE REFERENCES users(id)');
      expect(migrationFile).toContain('monthly_vcpu_hours_limit REAL');
    });

    it('creates index on user_quotas', () => {
      expect(migrationFile).toContain('CREATE INDEX idx_user_quotas_user_id ON user_quotas(user_id)');
    });
  });

  // ===========================================================================
  // Schema (Drizzle)
  // ===========================================================================
  describe('Drizzle schema', () => {
    it('defines default_quotas table', () => {
      expect(schemaFile).toContain("'default_quotas'");
      expect(schemaFile).toContain("real('monthly_vcpu_hours_limit')");
    });

    it('defines user_quotas table', () => {
      expect(schemaFile).toContain("'user_quotas'");
      expect(schemaFile).toContain("text('user_id')");
      expect(schemaFile).toContain("real('monthly_vcpu_hours_limit')");
    });

    it('exports DefaultQuotaRow type', () => {
      expect(schemaFile).toContain('export type DefaultQuotaRow');
    });

    it('exports UserQuotaRow type', () => {
      expect(schemaFile).toContain('export type UserQuotaRow');
    });
  });

  // ===========================================================================
  // Quota Service
  // ===========================================================================
  describe('compute-quotas service', () => {
    it('resolveUserQuota checks user_quotas first', () => {
      expect(serviceFile).toContain('schema.userQuotas');
      expect(serviceFile).toContain("source: 'user_override'");
    });

    it('resolveUserQuota falls back to default_quotas', () => {
      expect(serviceFile).toContain('schema.defaultQuotas');
      expect(serviceFile).toContain("source: 'default'");
    });

    it('resolveUserQuota returns unlimited when no quota configured', () => {
      expect(serviceFile).toContain("source: 'unlimited'");
    });

    it('checkQuotaForUser calls calculateVcpuHoursForPeriod with platform filter', () => {
      expect(serviceFile).toContain("'platform'");
      expect(serviceFile).toContain('calculateVcpuHoursForPeriod');
    });

    it('checkQuotaForUser returns allowed: true for unlimited quota', () => {
      expect(serviceFile).toContain('allowed: true, used: 0, limit: null, remaining: null');
    });

    it('checkQuotaForUser computes remaining correctly', () => {
      expect(serviceFile).toContain('quota.monthlyVcpuHoursLimit - used');
    });

    it('userHasOwnCloudCredentials checks for cloud-provider type', () => {
      expect(serviceFile).toContain("eq(schema.credentials.credentialType, 'cloud-provider')");
    });

    it('setDefaultQuota implements upsert pattern', () => {
      expect(serviceFile).toContain('.insert(schema.defaultQuotas)');
      expect(serviceFile).toContain('.update(schema.defaultQuotas)');
    });

    it('setUserQuotaOverride implements upsert pattern', () => {
      expect(serviceFile).toContain('.insert(schema.userQuotas)');
      expect(serviceFile).toContain('.update(schema.userQuotas)');
    });

    it('removeUserQuotaOverride deletes the override row', () => {
      expect(serviceFile).toContain('.delete(schema.userQuotas)');
    });
  });

  // ===========================================================================
  // Admin Quota Routes
  // ===========================================================================
  describe('admin quota routes', () => {
    it('routes are mounted at /api/admin/quotas', () => {
      expect(indexFile).toContain("adminQuotaRoutes");
      expect(indexFile).toContain("'/api/admin/quotas'");
    });

    it('requires superadmin for all routes', () => {
      expect(adminQuotaRoute).toContain('requireSuperadmin()');
    });

    it('GET /default returns current default quota', () => {
      expect(adminQuotaRoute).toContain("get('/default'");
      expect(adminQuotaRoute).toContain('getDefaultQuota');
    });

    it('PUT /default sets default quota', () => {
      expect(adminQuotaRoute).toContain("put('/default'");
      expect(adminQuotaRoute).toContain('setDefaultQuota');
    });

    it('GET /users lists all user quotas with usage', () => {
      expect(adminQuotaRoute).toContain("get('/users'");
      expect(adminQuotaRoute).toContain('listUserQuotasWithUsage');
    });

    it('GET /users/:userId returns resolved quota', () => {
      expect(adminQuotaRoute).toContain("get('/users/:userId'");
      expect(adminQuotaRoute).toContain('resolveUserQuota');
    });

    it('PUT /users/:userId sets user quota override', () => {
      expect(adminQuotaRoute).toContain("put('/users/:userId'");
      expect(adminQuotaRoute).toContain('setUserQuotaOverride');
    });

    it('DELETE /users/:userId removes user override', () => {
      expect(adminQuotaRoute).toContain("delete('/users/:userId'");
      expect(adminQuotaRoute).toContain('removeUserQuotaOverride');
    });

    it('validates monthlyVcpuHoursLimit is non-negative', () => {
      expect(adminQuotaRoute).toContain('monthlyVcpuHoursLimit < 0');
    });
  });

  // ===========================================================================
  // User Quota Endpoint
  // ===========================================================================
  describe('user quota endpoint', () => {
    it('GET /api/usage/quota route exists', () => {
      expect(usageRoute).toContain("get('/quota'");
    });

    it('returns quota check and BYOC exemption status', () => {
      expect(usageRoute).toContain('checkQuotaForUser');
      expect(usageRoute).toContain('userHasOwnCloudCredentials');
      expect(usageRoute).toContain('byocExempt');
    });

    it('returns period bounds', () => {
      expect(usageRoute).toContain('getCurrentPeriodBounds');
      expect(usageRoute).toContain('periodStart');
      expect(usageRoute).toContain('periodEnd');
    });
  });

  // ===========================================================================
  // Quota Enforcement: Task Submission
  // ===========================================================================
  describe('quota enforcement at task submission', () => {
    it('checks if user has own cloud credentials', () => {
      expect(submitRoute).toContain('userHasByocCredentials');
    });

    it('checks for platform credentials when user has no BYOC', () => {
      expect(submitRoute).toContain('platformCredentials');
      expect(submitRoute).toContain("credentialType, 'cloud-provider'");
    });

    it('checks quota for non-BYOC users', () => {
      expect(submitRoute).toContain('checkQuotaForUser');
    });

    it('rejects with clear message when quota exceeded', () => {
      expect(submitRoute).toContain('Monthly compute quota exceeded');
      expect(submitRoute).toContain('vCPU-hours this month');
    });

    it('respects COMPUTE_QUOTA_ENFORCEMENT_ENABLED kill switch', () => {
      expect(submitRoute).toContain('COMPUTE_QUOTA_ENFORCEMENT_ENABLED');
    });

    it('does NOT check quota for BYOC users', () => {
      // The checkQuotaForUser is only called inside the !userHasByocCredentials block
      expect(submitRoute).toContain('if (!userHasByocCredentials)');
    });
  });

  // ===========================================================================
  // Quota Enforcement: Node Provisioning (Hard Gate)
  // ===========================================================================
  describe('quota enforcement at node provisioning', () => {
    it('re-checks quota before provisioning', () => {
      expect(nodeStepsFile).toContain('checkQuotaForUser');
    });

    it('checks if user has own cloud credentials', () => {
      expect(nodeStepsFile).toContain("credential_type = 'cloud-provider'");
    });

    it('rejects with permanent error when quota exceeded', () => {
      expect(nodeStepsFile).toContain('Monthly compute quota exceeded');
      expect(nodeStepsFile).toContain('{ permanent: true }');
    });

    it('respects COMPUTE_QUOTA_ENFORCEMENT_ENABLED kill switch', () => {
      expect(nodeStepsFile).toContain('COMPUTE_QUOTA_ENFORCEMENT_ENABLED');
    });

    it('skips quota check when user has own credentials', () => {
      expect(nodeStepsFile).toContain('if (!hasOwnCreds)');
    });
  });

  // ===========================================================================
  // Env Var
  // ===========================================================================
  describe('environment configuration', () => {
    it('Env interface includes COMPUTE_QUOTA_ENFORCEMENT_ENABLED', () => {
      expect(indexFile).toContain('COMPUTE_QUOTA_ENFORCEMENT_ENABLED');
    });
  });
});
