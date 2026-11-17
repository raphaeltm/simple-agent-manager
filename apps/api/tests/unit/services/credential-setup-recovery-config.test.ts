import { afterEach, describe, expect, it } from 'vitest';

import { updateAdminSettings } from '../../../src/services/admin-settings';
import { getSetupSessionCleanupRecoveryStepTimeoutMs } from '../../../src/services/credential-setup-config';
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
