import { afterEach, expect, it } from 'vitest';

import {
  ADMIN_SETTINGS_REGISTRY,
  adminSettingsRegistry,
  findAdminSetting,
  resetInstalledAdminSettingDefinitionsForTests,
} from '../../../src/services/admin-settings-registry';
import { resolveAdminSetting } from '../../../src/services/admin-settings-resolution';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

afterEach(() => resetInstalledAdminSettingDefinitionsForTests());

it('resolves account-link freshness from the frozen base registry without self-host extensions', async () => {
  resetInstalledAdminSettingDefinitionsForTests();
  const name = 'security.accountLinkProofTtlSeconds';
  const definition = findAdminSetting(name);
  expect(definition).toMatchObject({ name, defaultValue: 300, range: { min: 60, max: 900 } });
  expect(adminSettingsRegistry()).toBe(ADMIN_SETTINGS_REGISTRY);
  expect(adminSettingsRegistry()).toContain(definition);
  expect(Object.isFrozen(definition)).toBe(true);
  expect(Object.isFrozen(definition?.range)).toBe(true);
  const { sqlite, env } = createAdminSettingsEnv();
  try {
    expect(await resolveAdminSetting(env, name)).toBe(300);
  } finally {
    sqlite.close();
  }
});
