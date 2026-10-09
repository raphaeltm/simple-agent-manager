import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  getConnectorSettingsConfig,
  updateConnectorSettings,
} from '../../../src/services/connector-settings';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';
let sqlite: Database.Database;
let env: Env;
beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [schema.platformSettings]);
  env = { DATABASE: createSqliteD1(sqlite), CONNECTOR_WRITE_ENABLED: 'false' } as Env;
});
afterEach(() => sqlite.close());
describe('Connector settings overrides', () => {
  it('writes only supplied keys and keeps environment changes effective for untouched settings', async () => {
    await updateConnectorSettings(env, { enabled: false }, 'admin');
    expect(sqlite.prepare('SELECT key FROM platform_settings').all()).toEqual([
      { key: 'connector.enabled' },
    ]);
    env.CONNECTOR_WRITE_ENABLED = 'true';
    const config = await getConnectorSettingsConfig(env);
    expect(config.enabled).toMatchObject({ value: false, source: 'runtime', updatedBy: 'admin' });
    expect(config.writeEnabled).toMatchObject({
      value: true,
      source: 'environment',
      updatedBy: null,
    });
    expect(config.clientRegistration.source).toBe('default');
  });
  it('removes selected override and returns its environment fallback without touching other overrides', async () => {
    await updateConnectorSettings(env, { writeEnabled: true, enabled: false }, 'admin');
    const config = await updateConnectorSettings(env, { writeEnabled: null }, 'admin');
    expect(config.writeEnabled).toEqual({
      value: false,
      source: 'environment',
      updatedAt: null,
      updatedBy: null,
    });
    expect(config.enabled.value).toBe(false);
    expect(sqlite.prepare('SELECT key FROM platform_settings').all()).toEqual([
      { key: 'connector.enabled' },
    ]);
    env.CONNECTOR_WRITE_ENABLED = 'true';
    expect((await getConnectorSettingsConfig(env)).writeEnabled.value).toBe(true);
  });
  it('resets to built-in defaults and validates every key before any mutation', async () => {
    await updateConnectorSettings(env, { readRateLimitPerMinute: 7 }, 'admin');
    await expect(
      updateConnectorSettings(env, { readRateLimitPerMinute: null, nonexistent: null }, 'admin')
    ).rejects.toThrow('Invalid Connector setting');
    expect((await getConnectorSettingsConfig(env)).readRateLimitPerMinute.value).toBe(7);
    const config = await updateConnectorSettings(env, { readRateLimitPerMinute: null }, 'admin');
    expect(config.readRateLimitPerMinute).toEqual({
      value: 120,
      source: 'default',
      updatedAt: null,
      updatedBy: null,
    });
  });
});
