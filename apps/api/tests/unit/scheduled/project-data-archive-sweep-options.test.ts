/**
 * The archive sweep's storage-pressure tunables come from the admin settings registry. These
 * cases go through the real resolver on a real SQL engine, because production sets no override:
 * the registry default is what decides (`.claude/rules/74`).
 */
import {
  resolveConfig,
  runProjectDataArchiveSharding as runPackageSweep,
} from '@simple-agent-manager/project-data/internal/scheduled/project-data-archive-sharding';
import {
  DEFAULT_PROJECT_DATA_ARCHIVE_MIN_STORAGE_USAGE_PERCENT,
  DEFAULT_PROJECT_DATA_ARCHIVE_STORAGE_TELEMETRY_MAX_AGE_HOURS,
  MAX_PROJECT_DATA_ARCHIVE_STORAGE_TELEMETRY_MAX_AGE_HOURS,
} from '@simple-agent-manager/project-data/scheduled';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  resolveProjectDataArchiveSweepOptions,
  runProjectDataArchiveSharding,
} from '../../../src/scheduled/project-data-archive-sharding';
import { updateAdminSettings } from '../../../src/services/admin-settings-mutations';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({ packageSweep: vi.fn() }));
// Only the cron entry point the worker wrapper calls is replaced; constants and types stay real.
vi.mock('@simple-agent-manager/project-data/scheduled', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simple-agent-manager/project-data/scheduled')>()),
  runProjectDataArchiveSharding: mocks.packageSweep,
}));

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

  it('hands the resolved admin settings to the sweep the cron handler runs', async () => {
    const { env } = createAdminSettingsEnv();
    await updateAdminSettings(env, {
      actorUserId: 'admin-1',
      changes: [
        { name: 'operations.projectDataArchiveMinStorageUsagePercent', value: 35 },
        { name: 'operations.projectDataArchiveStorageTelemetryMaxAgeHours', value: 12 },
      ],
    });
    mocks.packageSweep.mockResolvedValueOnce({ skipped: false });
    const at = new Date('2026-11-14T12:00:00Z');

    await runProjectDataArchiveSharding(env, at);

    // A wrapper that dropped the options would leave an admin override silently inert.
    expect(mocks.packageSweep).toHaveBeenCalledTimes(1);
    expect(mocks.packageSweep).toHaveBeenCalledWith(env, at, {
      minStorageUsagePercent: 35,
      storageTelemetryMaxAgeHours: 12,
    });
  });

  it('reports the held count as not counted, and still completes the tick, when the count query fails', async () => {
    const sqlite = new Database(':memory:');
    try {
      createSchemaTables(sqlite, [
        schema.sessionSummaries,
        schema.sessionSnapshots,
        schema.projectDataArchiveCircuitBreakers,
        schema.projectDataArchiveGlobalSweepCadence,
        schema.projectDataArchiveMigrations,
        schema.projectDataArchiveCopyCheckpoints,
        schema.projectDataSessionLocations,
        schema.projectDataStorageTelemetry,
      ]);
      const database = createSqliteD1(sqlite);
      let countQueries = 0;
      const failingCount = {
        ...database,
        prepare: (sql: string) => {
          if (sql.includes('COUNT(DISTINCT ss.project_id)')) {
            countQueries += 1;
            throw new Error('D1 overloaded');
          }
          return database.prepare(sql);
        },
      } as unknown as D1Database;
      const env = {
        DATABASE: failingCount,
        PROJECT_DATA_ARCHIVE_SHARDING_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED: 'true',
        PROJECT_DATA_ARCHIVE_R2: {} as R2Bucket,
      } as unknown as Parameters<typeof runPackageSweep>[0];

      const stats = await runPackageSweep(env, new Date('2026-11-14T12:00:00Z'), {});

      // The harness really reached the count, and its failure stayed out of the tick's verdict.
      expect(countQueries).toBe(1);
      expect(stats).toMatchObject({ skipped: false, failed: 0 });
      expect(stats.cadence).toMatchObject({ lastStatus: 'succeeded' });
      // null is "not counted"; 0 would claim the gate held nothing.
      expect(stats.storagePressureHeldSessions).toBeNull();
      expect(stats.storagePressureHeldProjects).toBeNull();
      expect(stats.storagePressureHeldMessages).toBeNull();
      expect(stats.storagePressureMinUsageRatio).toBe(
        DEFAULT_PROJECT_DATA_ARCHIVE_MIN_STORAGE_USAGE_PERCENT / 100
      );
    } finally {
      sqlite.close();
    }
  });

  it('bounds out-of-range and non-numeric options instead of trusting them', () => {
    const { env } = createAdminSettingsEnv();
    expect(resolveConfig(env as never, { minStorageUsagePercent: 250 }).minStorageUsageRatio).toBe(
      1
    );
    expect(resolveConfig(env as never, { minStorageUsagePercent: -5 }).minStorageUsageRatio).toBe(
      0
    );
    expect(
      resolveConfig(env as never, { minStorageUsagePercent: Number.NaN }).minStorageUsageRatio
    ).toBe(DEFAULT_PROJECT_DATA_ARCHIVE_MIN_STORAGE_USAGE_PERCENT / 100);
    const hour = 60 * 60 * 1000;
    expect(
      resolveConfig(env as never, { storageTelemetryMaxAgeHours: 0 }).storageTelemetryMaxAgeMs
    ).toBe(hour);
    expect(
      resolveConfig(env as never, { storageTelemetryMaxAgeHours: 100_000 }).storageTelemetryMaxAgeMs
    ).toBe(MAX_PROJECT_DATA_ARCHIVE_STORAGE_TELEMETRY_MAX_AGE_HOURS * hour);
  });
});
