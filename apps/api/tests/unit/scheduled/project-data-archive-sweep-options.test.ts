/**
 * The archive sweep's storage-pressure tunables come from the admin settings registry. These
 * cases go through the real resolver on a real SQL engine, because production sets no override:
 * the registry default is what decides (`.claude/rules/74`).
 */
import {
  DEFAULT_PROJECT_DATA_ARCHIVE_MIN_STORAGE_USAGE_PERCENT,
  DEFAULT_PROJECT_DATA_ARCHIVE_STORAGE_TELEMETRY_MAX_AGE_HOURS,
} from '@simple-agent-manager/project-data/scheduled';
import { resolveConfig } from '@simple-agent-manager/project-data/internal/scheduled/project-data-archive-sharding';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../src/env';
import { resolveProjectDataArchiveSweepOptions } from '../../../src/scheduled/project-data-archive-sharding';
import { updateAdminSettings } from '../../../src/services/admin-settings-mutations';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

describe('archive sweep storage-pressure settings', () => {
  it('resolves the registry defaults when no admin override exists', async () => {
    const { env } = createAdminSettingsEnv();

    const options = await resolveProjectDataArchiveSweepOptions(env);

    expect(options).toEqual({
      minStorageUsagePercent: DEFAULT_PROJECT_DATA_ARCHIVE_MIN_STORAGE_USAGE_PERCENT,
      storageTelemetryMaxAgeHours: DEFAULT_PROJECT_DATA_ARCHIVE_STORAGE_TELEMETRY_MAX_AGE_HOURS,
    });
    // What the sweep then selects with.
    const config = resolveConfig(env as never, options);
    expect(config.minStorageUsageRatio).toBe(0.5);
    expect(config.storageTelemetryMaxAgeMs).toBe(24 * 60 * 60 * 1000);
  });

  it('carries an admin override, including 0, through to the sweep configuration', async () => {
    const { env } = createAdminSettingsEnv();
    await updateAdminSettings(env, {
      actorUserId: 'admin-1',
      changes: [
        { name: 'operations.projectDataArchiveMinStorageUsagePercent', value: 0 },
        { name: 'operations.projectDataArchiveStorageTelemetryMaxAgeHours', value: 6 },
      ],
    });

    const options = await resolveProjectDataArchiveSweepOptions(env);

    expect(options).toEqual({ minStorageUsagePercent: 0, storageTelemetryMaxAgeHours: 6 });
    const config = resolveConfig(env as never, options);
    // 0 is a real choice (gate off), not "absent": it must not fall back to the default.
    expect(config.minStorageUsageRatio).toBe(0);
    expect(config.storageTelemetryMaxAgeMs).toBe(6 * 60 * 60 * 1000);
  });

  it('still resolves usable settings when the settings store cannot be read', async () => {
    const { env } = createAdminSettingsEnv();
    const broken = {
      ...env,
      DATABASE: {
        prepare: () => {
          throw new Error('D1 unavailable');
        },
        batch: async () => {
          throw new Error('D1 unavailable');
        },
      },
    } as unknown as Env;

    // Resolves, not rejects: the drain protects a storage limit and must still run. The
    // registry answers a failed read with its outage value, which for these settings is the
    // default; the wrapper's own catch covers anything the registry does throw.
    const options = await resolveProjectDataArchiveSweepOptions(broken);

    const config = resolveConfig(env as never, options);
    expect(config.minStorageUsageRatio).toBe(
      DEFAULT_PROJECT_DATA_ARCHIVE_MIN_STORAGE_USAGE_PERCENT / 100
    );
    expect(config.storageTelemetryMaxAgeMs).toBe(
      DEFAULT_PROJECT_DATA_ARCHIVE_STORAGE_TELEMETRY_MAX_AGE_HOURS * 60 * 60 * 1000
    );
  });

  it('bounds out-of-range and non-numeric options instead of trusting them', () => {
    const { env } = createAdminSettingsEnv();
    expect(
      resolveConfig(env as never, { minStorageUsagePercent: 250 }).minStorageUsageRatio
    ).toBe(1);
    expect(
      resolveConfig(env as never, { minStorageUsagePercent: -5 }).minStorageUsageRatio
    ).toBe(0);
    expect(
      resolveConfig(env as never, { minStorageUsagePercent: Number.NaN }).minStorageUsageRatio
    ).toBe(DEFAULT_PROJECT_DATA_ARCHIVE_MIN_STORAGE_USAGE_PERCENT / 100);
  });
});
