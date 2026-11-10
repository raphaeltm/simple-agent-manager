import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { readAdminSettings, updateAdminSettings } from '../../../src/services/admin-settings';
import { NODE_TUNNEL_SETTINGS } from '../../../src/services/admin-settings-node-tunnel-definitions';
import { listTunnelsByExactName } from '../../../src/services/cloudflare-tunnel-api';
import { nodeTunnelCleanupBackoffMs } from '../../../src/services/node-tunnel-cleanup';
import {
  resolveNodeTunnelApiConfig,
  resolveNodeTunnelCleanupConfig,
} from '../../../src/services/node-tunnel-config';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

let sqlite: Database.Database;
let env: Env;
beforeEach(() => {
  ({ sqlite, env } = createAdminSettingsEnv({
    CF_ACCOUNT_ID: 'test-account',
    CF_API_TOKEN: 'test-key',
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  sqlite.close();
});

describe('managed VM tunnel admin settings', () => {
  it('exposes typed non-secret runtime controls through existing admin settings', async () => {
    const view = await readAdminSettings(env, { fresh: true });
    const controls = view.settings.filter((setting) => setting.name.startsWith('vmTunnels.'));
    expect(controls).toHaveLength(8);
    expect(
      controls.every((setting) => setting.type === 'integer' && setting.secret === false)
    ).toBe(true);
    expect(await resolveNodeTunnelApiConfig(env)).toEqual({ attempts: 3, retryDelayMs: 250 });
    expect(await resolveNodeTunnelCleanupConfig(env)).toEqual({
      requestTimeoutMs: 10000,
      batchSize: 10,
      sweepBudgetMs: 30000,
      backoffBaseMs: 60000,
      backoffMaxMs: 3600000,
      stuckAttempts: 6,
    });
  });

  it('updates every consumer without redeploy and resetting restores code defaults', async () => {
    // Warm the cache first; the real admin mutation must invalidate it.
    await resolveNodeTunnelApiConfig(env);
    await resolveNodeTunnelCleanupConfig(env);
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: [
        { name: 'vmTunnels.apiAttempts', value: 2 },
        { name: 'vmTunnels.apiRetryDelayMs', value: 7 },
        { name: 'vmTunnels.cleanupRequestTimeoutMs', value: 900 },
        { name: 'vmTunnels.cleanupBatchSize', value: 4 },
        { name: 'vmTunnels.cleanupSweepBudgetMs', value: 5000 },
        { name: 'vmTunnels.cleanupBackoffBaseMs', value: 17 },
        { name: 'vmTunnels.cleanupBackoffMaxMs', value: 50 },
        { name: 'vmTunnels.cleanupStuckAttempts', value: 2 },
      ],
    });
    expect(await resolveNodeTunnelApiConfig(env)).toEqual({ attempts: 2, retryDelayMs: 7 });
    expect(await resolveNodeTunnelCleanupConfig(env)).toEqual({
      requestTimeoutMs: 900,
      batchSize: 4,
      sweepBudgetMs: 5000,
      backoffBaseMs: 17,
      backoffMaxMs: 50,
      stuckAttempts: 2,
    });
    expect(await nodeTunnelCleanupBackoffMs(env, 1)).toBe(17);
    expect(await nodeTunnelCleanupBackoffMs(env, 3)).toBe(50);
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: NODE_TUNNEL_SETTINGS.map(({ name }) => ({ name, value: null })),
    });
    expect(await resolveNodeTunnelApiConfig(env)).toEqual({ attempts: 3, retryDelayMs: 250 });
    expect(await nodeTunnelCleanupBackoffMs(env, 1)).toBe(60000);
  });

  it('rejects invalid bounds and non-integer values before storing any control', async () => {
    for (const setting of NODE_TUNNEL_SETTINGS) {
      for (const value of [0, 1.5, '3', setting.range!.max + 1]) {
        await expect(
          updateAdminSettings(env, {
            actorUserId: 'admin',
            changes: [{ name: setting.name, value }],
          })
        ).rejects.toMatchObject({ statusCode: 400 });
      }
    }
  });

  it('the actual Cloudflare client observes changed retry attempts on subsequent calls', async () => {
    const request = vi.fn(async () =>
      Response.json({ success: false, errors: [{ code: 1000 }] }, { status: 503 })
    );
    vi.stubGlobal('fetch', request);
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: [
        { name: 'vmTunnels.apiAttempts', value: 1 },
        { name: 'vmTunnels.apiRetryDelayMs', value: 1 },
      ],
    });
    await expect(listTunnelsByExactName(env, 'owned-name')).rejects.toMatchObject({ status: 503 });
    expect(request).toHaveBeenCalledTimes(1);
    request.mockClear();
    await updateAdminSettings(env, {
      actorUserId: 'admin',
      changes: [{ name: 'vmTunnels.apiAttempts', value: 2 }],
    });
    await expect(listTunnelsByExactName(env, 'owned-name')).rejects.toMatchObject({ status: 503 });
    expect(request).toHaveBeenCalledTimes(2);
    // Background cleanup overrides interactive retry settings with one attempt.
    request.mockClear();
    await expect(listTunnelsByExactName(env, 'owned-name', { attempts: 1 })).rejects.toMatchObject({
      status: 503,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
