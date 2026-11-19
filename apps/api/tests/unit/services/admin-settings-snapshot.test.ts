import { afterEach, describe, expect, it, vi } from 'vitest';

import { readAdminSettings, updateAdminSettings } from '../../../src/services/admin-settings';
import {
  ADMIN_SETTINGS_REGISTRY,
  publicAdminSettingDefinition,
} from '../../../src/services/admin-settings-registry';
import { cache, credentialRows, resolved } from '../../../src/services/admin-settings-resolution';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

const fixture = createAdminSettingsEnv({
  GITHUB_CLIENT_ID: 'environment-client',
  GITHUB_CLIENT_SECRET: 'environment-secret',
  CRON_SWEEPS_ENABLED: 'true',
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('atomic admin snapshot parity against real SQLite D1', () => {
  it('matches the former sequential view including credentials, environment fallbacks, KV veto and history', async () => {
    const { env, sqlite } = fixture;
    try {
      await env.KV.put('control-loops:cron-enabled', 'false');
      await updateAdminSettings(env, {
        actorUserId: 'admin',
        changes: [
          { name: 'connector.enabled', value: true },
          { name: 'integration.github.clientId', value: 'database-client' },
          { name: 'integration.github.clientSecret', value: 'database-secret' },
        ],
      });
      // The old reader's three data sources, independently executed against SQLite.
      const revision = await env.DATABASE.prepare(
        'SELECT revision FROM admin_settings_revision WHERE singleton=1'
      ).first<{ revision: number }>();
      const rows = await cache.read(env.DATABASE, true);
      const credentials = await credentialRows(env, true);
      const settings = await Promise.all(
        ADMIN_SETTINGS_REGISTRY.map(async (definition) => ({
          ...publicAdminSettingDefinition(definition),
          ...(await resolved(env, definition, rows, false, credentials, true)),
        }))
      );
      const history = await env.DATABASE.prepare(
        'SELECT name,action,actor_user_id AS actorUserId,created_at AS createdAt,revision FROM admin_settings_audit ORDER BY revision DESC,name LIMIT 100'
      ).all();
      const batch = vi.spyOn(env.DATABASE, 'batch');
      const actual = await readAdminSettings(env, { fresh: true });
      expect(actual).toEqual({ revision: revision!.revision, settings, history: history.results });
      expect(batch).toHaveBeenCalledTimes(1);
      expect(batch.mock.calls[0]?.[0]).toHaveLength(4);
      expect(JSON.stringify(actual)).not.toContain('database-secret');
      expect(
        actual.settings.find((setting) => setting.name === 'operations.cronSweepsEnabled')?.value
      ).toBe(false);
    } finally {
      sqlite.close();
    }
  });
});
