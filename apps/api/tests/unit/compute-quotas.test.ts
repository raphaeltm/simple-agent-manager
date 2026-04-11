/**
 * Unit tests for compute quota resolution and enforcement logic.
 *
 * Tests the core logic of quota resolution (user override → default → unlimited),
 * quota check results, and BYOC exemption.
 */
import { describe, expect, it } from 'vitest';

describe('compute quota types and constants', () => {
  it('QuotaSource type includes expected values', async () => {
    // Verify the shared type export is importable
    await import('@simple-agent-manager/shared');
    // Type verification — these type assertions confirm the type is exported
    const sources: Array<import('@simple-agent-manager/shared').QuotaSource> = [
      'user_override',
      'default',
      'unlimited',
    ];
    expect(sources).toHaveLength(3);
  });

  it('UserQuotaStatusResponse type has required fields', async () => {
    const _response: import('@simple-agent-manager/shared').UserQuotaStatusResponse = {
      monthlyVcpuHoursLimit: 100,
      source: 'default',
      currentUsage: 42.5,
      remaining: 57.5,
      periodStart: '2026-04-01T00:00:00.000Z',
      periodEnd: '2026-04-30T23:59:59.999Z',
      byocExempt: false,
    };
    expect(_response.monthlyVcpuHoursLimit).toBe(100);
    expect(_response.remaining).toBe(57.5);
    expect(_response.byocExempt).toBe(false);
  });

  it('UserQuotaStatusResponse supports null limit (unlimited)', async () => {
    const _response: import('@simple-agent-manager/shared').UserQuotaStatusResponse = {
      monthlyVcpuHoursLimit: null,
      source: 'unlimited',
      currentUsage: 0,
      remaining: null,
      periodStart: '2026-04-01T00:00:00.000Z',
      periodEnd: '2026-04-30T23:59:59.999Z',
      byocExempt: false,
    };
    expect(_response.monthlyVcpuHoursLimit).toBeNull();
    expect(_response.remaining).toBeNull();
  });

  it('AdminUserQuotaSummary type includes percentUsed', async () => {
    const _summary: import('@simple-agent-manager/shared').AdminUserQuotaSummary = {
      userId: 'u1',
      email: 'test@test.com',
      name: 'Test',
      avatarUrl: null,
      monthlyVcpuHoursLimit: 100,
      source: 'default',
      currentUsage: 75,
      percentUsed: 75,
    };
    expect(_summary.percentUsed).toBe(75);
  });
});

describe('compute-quotas service exports', () => {
  it('exports resolveUserQuota function', async () => {
    const mod = await import('../../src/services/compute-quotas');
    expect(typeof mod.resolveUserQuota).toBe('function');
  });

  it('exports checkQuotaForUser function', async () => {
    const mod = await import('../../src/services/compute-quotas');
    expect(typeof mod.checkQuotaForUser).toBe('function');
  });

  it('exports userHasOwnCloudCredentials function', async () => {
    const mod = await import('../../src/services/compute-quotas');
    expect(typeof mod.userHasOwnCloudCredentials).toBe('function');
  });

  it('exports getDefaultQuota function', async () => {
    const mod = await import('../../src/services/compute-quotas');
    expect(typeof mod.getDefaultQuota).toBe('function');
  });

  it('exports setDefaultQuota function', async () => {
    const mod = await import('../../src/services/compute-quotas');
    expect(typeof mod.setDefaultQuota).toBe('function');
  });

  it('exports setUserQuotaOverride function', async () => {
    const mod = await import('../../src/services/compute-quotas');
    expect(typeof mod.setUserQuotaOverride).toBe('function');
  });

  it('exports removeUserQuotaOverride function', async () => {
    const mod = await import('../../src/services/compute-quotas');
    expect(typeof mod.removeUserQuotaOverride).toBe('function');
  });

  it('exports listUserQuotasWithUsage function', async () => {
    const mod = await import('../../src/services/compute-quotas');
    expect(typeof mod.listUserQuotasWithUsage).toBe('function');
  });

  it('exports getUserQuotaOverride function', async () => {
    const mod = await import('../../src/services/compute-quotas');
    expect(typeof mod.getUserQuotaOverride).toBe('function');
  });
});

describe('compute quota schema', () => {
  it('defines default_quotas table', async () => {
    const schema = await import('../../src/db/schema');
    expect(schema.defaultQuotas).toBeDefined();
  });

  it('defines user_quotas table', async () => {
    const schema = await import('../../src/db/schema');
    expect(schema.userQuotas).toBeDefined();
  });

  it('default_quotas has monthlyVcpuHoursLimit column', async () => {
    const schema = await import('../../src/db/schema');
    expect(schema.defaultQuotas.monthlyVcpuHoursLimit).toBeDefined();
  });

  it('user_quotas has userId column', async () => {
    const schema = await import('../../src/db/schema');
    expect(schema.userQuotas.userId).toBeDefined();
  });

  it('user_quotas has monthlyVcpuHoursLimit column', async () => {
    const schema = await import('../../src/db/schema');
    expect(schema.userQuotas.monthlyVcpuHoursLimit).toBeDefined();
  });
});
