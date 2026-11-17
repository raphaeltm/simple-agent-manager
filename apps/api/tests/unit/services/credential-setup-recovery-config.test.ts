import { afterEach, describe, expect, it, vi } from 'vitest';

import { updateAdminSettings } from '../../../src/services/admin-settings';
import {
  getSetupSessionCleanupRecoveryConfig,
  getSetupSessionCleanupRecoveryStepTimeoutMs,
} from '../../../src/services/credential-setup-config';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

const fixtures: ReturnType<typeof createAdminSettingsEnv>[] = [];
afterEach(() => {
  for (const { sqlite } of fixtures.splice(0)) sqlite.close();
});

function fixture() {
  const result = createAdminSettingsEnv();
  fixtures.push(result);
  return result;
}

describe('guided-login cleanup recovery timeout settings', () => {
  it('uses the short default and picks up a persisted admin override through the real resolver', async () => {
    const { env } = fixture();
    expect(await getSetupSessionCleanupRecoveryStepTimeoutMs(env)).toBe(5_000);
    await updateAdminSettings(env, {
      changes: [{ name: 'credentialSetup.cleanupRecoveryStepTimeoutMs', value: 750 }],
      actorUserId: 'admin',
    });
    expect(await getSetupSessionCleanupRecoveryStepTimeoutMs(env)).toBe(750);
  });

  it.each([0, 10_001])('rejects an out-of-range recovery budget %s', async (value) => {
    const { env } = fixture();
    await expect(
      updateAdminSettings(env, {
        changes: [{ name: 'credentialSetup.cleanupRecoveryStepTimeoutMs', value }],
        actorUserId: 'admin',
      })
    ).rejects.toThrow();
    expect(await getSetupSessionCleanupRecoveryStepTimeoutMs(env)).toBe(5_000);
  });
});

describe('guided-login cleanup recovery attempt settings', () => {
  it('resolves both defaults and persisted attempt/budget overrides through the real resolver', async () => {
    const { env } = fixture();
    expect(await getSetupSessionCleanupRecoveryConfig(env)).toEqual({
      stepTimeoutMs: 5_000,
      maxAttempts: 3,
    });
    await updateAdminSettings(env, {
      changes: [
        { name: 'credentialSetup.cleanupRecoveryStepTimeoutMs', value: 750 },
        { name: 'credentialSetup.cleanupRecoveryMaxAttempts', value: 7 },
      ],
      actorUserId: 'admin',
    });
    expect(await getSetupSessionCleanupRecoveryConfig(env)).toEqual({
      stepTimeoutMs: 750,
      maxAttempts: 7,
    });
  });

  it('shares one override read when resolving both recovery settings', async () => {
    const { env } = fixture();
    const prepare = vi.spyOn(env.DATABASE, 'prepare');
    try {
      expect(await getSetupSessionCleanupRecoveryConfig(env)).toEqual({
        stepTimeoutMs: 5_000,
        maxAttempts: 3,
      });
      expect(
        prepare.mock.calls.filter(([sql]) => sql.includes('FROM platform_settings'))
      ).toHaveLength(1);
    } finally {
      prepare.mockRestore();
    }
  });

  it.each([1, 10])('accepts the finite recovery attempt boundary %s', async (value) => {
    const { env } = fixture();
    await updateAdminSettings(env, {
      changes: [{ name: 'credentialSetup.cleanupRecoveryMaxAttempts', value }],
      actorUserId: 'admin',
    });
    expect((await getSetupSessionCleanupRecoveryConfig(env)).maxAttempts).toBe(value);
  });

  it.each([0, 11, 1.5])('rejects an invalid recovery attempt cap %s', async (value) => {
    const { env } = fixture();
    await expect(
      updateAdminSettings(env, {
        changes: [{ name: 'credentialSetup.cleanupRecoveryMaxAttempts', value }],
        actorUserId: 'admin',
      })
    ).rejects.toThrow();
    expect((await getSetupSessionCleanupRecoveryConfig(env)).maxAttempts).toBe(3);
  });
});
