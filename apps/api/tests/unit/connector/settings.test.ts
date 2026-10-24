import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleAppError } from '../../../src/middleware/app-error-handler';
import { connectorAdminRoutes } from '../../../src/routes/connector-settings';
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (c: any, next: any) => {
    c.set('auth', {
      user: {
        id: 'admin',
        role: c.req.header('x-test-role') ?? 'superadmin',
        status: c.req.header('x-test-status') ?? 'active',
      },
    });
    await next();
  },
  requireApproved: () => async (_c: any, next: any) => next(),
  requireSuperadmin: () => async (_c: any, next: any) => next(),
}));

import type { Env } from '../../../src/env';
import {
  getConnectorSettingsConfig,
  updateConnectorSettings,
} from '../../../src/services/connector-settings';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
let sqlite: Database.Database;
let env: Env;
beforeEach(() => {
  ({ sqlite, env } = createAdminSettingsEnv({ CONNECTOR_WRITE_ENABLED: 'false' }));
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

for (const status of ['pending', 'suspended']) {
  it(`prevents ${status} superadmins bypassing settings authorization through legacy Connector routes`, async () => {
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route('/admin/connector', connectorAdminRoutes);
    const response = await app.request(
      '/admin/connector/settings',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-test-status': status },
        body: JSON.stringify({ enabled: false }),
      },
      env
    );
    expect(response.status).toBe(403);
    expect(sqlite.prepare('SELECT revision FROM admin_settings_revision').get()).toEqual({
      revision: 0,
    });
  });
}
