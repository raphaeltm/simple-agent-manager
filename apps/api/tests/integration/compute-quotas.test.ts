/**
 * Integration test: compute quota pipeline.
 *
 * Verifies the end-to-end wiring of compute quotas:
 * 1. Schema defines default_quotas and user_quotas tables
 * 2. Service functions implement quota resolution chain
 * 3. Admin routes are mounted and handle CRUD
 * 4. User route returns quota status
 * 5. Task submission checks quota based on credential SOURCE (not existence)
 * 6. Node provisioning re-checks quota using resolveCredentialSource (hard gate)
 * 7. Manual node creation enforces quota for platform credentials
 * 8. BYOC users are exempt only when using their own credential for the target provider
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('compute quota pipeline', () => {
  const schemaFile = readFileSync(resolve(process.cwd(), 'src/db/schema.ts'), 'utf8');
  const serviceFile = readFileSync(resolve(process.cwd(), 'src/services/compute-quotas.ts'), 'utf8');
  const providerCredsFile = readFileSync(resolve(process.cwd(), 'src/services/provider-credentials.ts'), 'utf8');
  const indexFile = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');
  const envFile = readFileSync(resolve(process.cwd(), 'src/env.ts'), 'utf8');
  const adminQuotaRoute = readFileSync(resolve(process.cwd(), 'src/routes/admin-quotas.ts'), 'utf8');
  const usageRoute = readFileSync(resolve(process.cwd(), 'src/routes/usage.ts'), 'utf8');
  const submitRoute = readFileSync(resolve(process.cwd(), 'src/routes/tasks/submit.ts'), 'utf8');
  const nodeStepsFile = readFileSync(resolve(process.cwd(), 'src/durable-objects/task-runner/node-steps.ts'), 'utf8');
  const nodesRoute = readFileSync(resolve(process.cwd(), 'src/routes/nodes.ts'), 'utf8');
  const migrationFile = readFileSync(resolve(process.cwd(), 'src/db/migrations/0039_compute_quotas.sql'), 'utf8');
  const dispatchToolFile = readFileSync(resolve(process.cwd(), 'src/routes/mcp/dispatch-tool.ts'), 'utf8');

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

    it('userHasOwnCloudCredentials accepts optional targetProvider parameter', () => {
      expect(serviceFile).toContain('targetProvider?: CredentialProvider');
      expect(serviceFile).toContain('eq(schema.credentials.provider, targetProvider)');
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
  // resolveCredentialSource
  // ===========================================================================
  describe('resolveCredentialSource', () => {
    it('is exported from provider-credentials service', () => {
      expect(providerCredsFile).toContain('export async function resolveCredentialSource');
    });

    it('checks user credentials for the target provider first', () => {
      expect(providerCredsFile).toContain("eq(schema.credentials.credentialType, 'cloud-provider')");
      // When targetProvider is passed, it filters by provider
      expect(providerCredsFile).toContain('eq(schema.credentials.provider, targetProvider)');
    });

    it('falls back to platform credentials', () => {
      expect(providerCredsFile).toContain("eq(schema.platformCredentials.credentialType, 'cloud-provider')");
      expect(providerCredsFile).toContain('eq(schema.platformCredentials.isEnabled, true)');
    });

    it('returns credentialSource: user when user has own credential', () => {
      expect(providerCredsFile).toContain("credentialSource: 'user'");
    });

    it('returns credentialSource: platform when falling back', () => {
      expect(providerCredsFile).toContain("credentialSource: 'platform'");
    });

    it('returns null when no credential exists', () => {
      // Verify the function returns null when no credentials are found
      expect(providerCredsFile).toContain('return null;');
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

    it('byocExempt check intentionally omits targetProvider (any-provider display)', () => {
      // The informational byocExempt flag checks for ANY cloud credential (by design).
      // This is different from enforcement points which pass targetProvider.
      expect(usageRoute).toContain('userHasOwnCloudCredentials(db, userId)');
      // Does NOT pass a third argument — intentional asymmetry:
      expect(usageRoute).not.toMatch(/userHasOwnCloudCredentials\(db, userId, /);
    });
  });

  // ===========================================================================
  // Quota Enforcement: Task Submission (credential SOURCE, not existence)
  // ===========================================================================
  describe('quota enforcement at task submission', () => {
    it('uses resolveCredentialSource for credential resolution', () => {
      expect(submitRoute).toContain('resolveCredentialSource');
    });

    it('passes resolved provider to credential source check', () => {
      // The provider is resolved earlier in the function, then passed to resolveCredentialSource
      expect(submitRoute).toContain('resolveCredentialSource(db, userId, provider');
    });

    it('enforces quota only when credential source is platform', () => {
      expect(submitRoute).toContain("credResult.credentialSource === 'platform'");
    });

    it('checks quota for platform users', () => {
      expect(submitRoute).toContain('checkQuotaForUser');
    });

    it('rejects with clear message when quota exceeded', () => {
      expect(submitRoute).toContain('Monthly compute quota exceeded');
      expect(submitRoute).toContain('vCPU-hours this month');
    });

    it('respects COMPUTE_QUOTA_ENFORCEMENT_ENABLED kill switch', () => {
      expect(submitRoute).toContain('COMPUTE_QUOTA_ENFORCEMENT_ENABLED');
    });

    it('rejects when no credential exists at all', () => {
      expect(submitRoute).toContain('Cloud provider credentials required');
    });
  });

  // ===========================================================================
  // Quota Enforcement: Node Provisioning (Hard Gate)
  // ===========================================================================
  describe('quota enforcement at node provisioning', () => {
    it('uses resolveCredentialSource for credential resolution', () => {
      expect(nodeStepsFile).toContain('resolveCredentialSource');
    });

    it('passes cloud provider from config to credential source check', () => {
      expect(nodeStepsFile).toContain('state.config.cloudProvider');
    });

    it('enforces quota only when credential source is platform', () => {
      expect(nodeStepsFile).toContain("credResult.credentialSource === 'platform'");
    });

    it('re-checks quota before provisioning', () => {
      expect(nodeStepsFile).toContain('checkQuotaForUser');
    });

    it('rejects with permanent error when quota exceeded', () => {
      expect(nodeStepsFile).toContain('Monthly compute quota exceeded');
      expect(nodeStepsFile).toContain('{ permanent: true }');
    });

    it('respects COMPUTE_QUOTA_ENFORCEMENT_ENABLED kill switch', () => {
      expect(nodeStepsFile).toContain('COMPUTE_QUOTA_ENFORCEMENT_ENABLED');
    });
  });

  // ===========================================================================
  // Quota Enforcement: Manual Node Creation
  // ===========================================================================
  describe('quota enforcement at manual node creation', () => {
    it('uses resolveCredentialSource for credential resolution', () => {
      expect(nodesRoute).toContain('resolveCredentialSource');
    });

    it('enforces quota when credential source is platform', () => {
      expect(nodesRoute).toContain("credResult.credentialSource === 'platform'");
    });

    it('checks quota before creating node record', () => {
      // resolveCredentialSource and checkQuotaForUser appear before createNodeRecord
      const resolveIdx = nodesRoute.indexOf('resolveCredentialSource');
      const quotaIdx = nodesRoute.indexOf('checkQuotaForUser');
      const createIdx = nodesRoute.indexOf('createNodeRecord(c.env');
      expect(resolveIdx).toBeLessThan(createIdx);
      expect(quotaIdx).toBeLessThan(createIdx);
    });

    it('rejects when no credential exists', () => {
      expect(nodesRoute).toContain('Cloud provider credentials required');
    });

    it('respects COMPUTE_QUOTA_ENFORCEMENT_ENABLED kill switch', () => {
      expect(nodesRoute).toContain('COMPUTE_QUOTA_ENFORCEMENT_ENABLED');
    });
  });

  // ===========================================================================
  // Quota Enforcement: MCP Dispatch Task
  // ===========================================================================
  describe('quota enforcement at MCP dispatch', () => {
    it('uses resolveCredentialSource for credential resolution', () => {
      expect(dispatchToolFile).toContain('resolveCredentialSource');
    });

    it('passes resolvedProvider to credential source check', () => {
      expect(dispatchToolFile).toContain('resolveCredentialSource(db, tokenData.userId, resolvedProvider');
    });

    it('enforces quota when credential source is platform', () => {
      expect(dispatchToolFile).toContain("credResult.credentialSource === 'platform'");
    });

    it('checks quota before task INSERT', () => {
      const quotaIdx = dispatchToolFile.indexOf('resolveCredentialSource');
      const insertIdx = dispatchToolFile.indexOf('INSERT INTO tasks');
      expect(quotaIdx).toBeLessThan(insertIdx);
    });

    it('rejects when no credential exists', () => {
      expect(dispatchToolFile).toContain('Cloud provider credentials required');
    });

    it('respects COMPUTE_QUOTA_ENFORCEMENT_ENABLED kill switch', () => {
      expect(dispatchToolFile).toContain('COMPUTE_QUOTA_ENFORCEMENT_ENABLED');
    });
  });

  // ===========================================================================
  // Env Var
  // ===========================================================================
  describe('environment configuration', () => {
    it('Env interface includes COMPUTE_QUOTA_ENFORCEMENT_ENABLED', () => {
      expect(envFile).toContain('COMPUTE_QUOTA_ENFORCEMENT_ENABLED');
    });
  });

  // ===========================================================================
  // Regression: Credential source bypass prevention
  // ===========================================================================
  describe('credential source bypass prevention', () => {
    it('task submission does NOT use raw credential existence check', () => {
      // The old pattern checked for ANY cloud-provider credential
      // and set userHasByocCredentials. This is now replaced by resolveCredentialSource.
      expect(submitRoute).not.toContain('userHasByocCredentials');
    });

    it('node provisioning does NOT use raw SQL credential existence check', () => {
      // The old pattern used raw SQL: SELECT id FROM credentials WHERE ...
      expect(nodeStepsFile).not.toContain("credential_type = 'cloud-provider' LIMIT 1");
    });

    it('node provisioning does NOT use hasOwnCreds guard', () => {
      expect(nodeStepsFile).not.toContain('if (!hasOwnCreds)');
    });

    it('MCP dispatch does NOT use raw credential existence check in Promise.all', () => {
      expect(dispatchToolFile).not.toContain("eq(schema.credentials.credentialType, 'cloud-provider')");
    });

    it('all four enforcement points use resolveCredentialSource', () => {
      expect(submitRoute).toContain('resolveCredentialSource');
      expect(nodeStepsFile).toContain('resolveCredentialSource');
      expect(nodesRoute).toContain('resolveCredentialSource');
      expect(dispatchToolFile).toContain('resolveCredentialSource');
    });
  });
});
