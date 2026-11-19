// The archive coordinator lives in @simple-agent-manager/project-data (worker modularization W1).
// Its controls are re-exported so the worker's existing importers are unchanged; the cron entry
// point is wrapped here because the admin settings registry belongs to the worker.
import {
  type ProjectDataArchiveSweepOptions,
  runProjectDataArchiveSharding as runArchiveSweep,
} from '@simple-agent-manager/project-data/scheduled';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { resolveAdminSetting } from '../services/admin-settings-resolution';

export {
  abandonProjectDataArchiveMigration,
  copyBackProjectDataArchiveMigration,
  getProjectDataArchiveFrozenIntentInspectionConfig,
  inspectFrozenProjectDataArchiveIntents,
  ProjectDataArchiveCoordinatorStateError,
  runScopedProjectDataArchiveCanary,
} from '@simple-agent-manager/project-data/scheduled';

/**
 * The storage-pressure gate's two tunables. A settings read failure returns no options, so the
 * sweep runs on its code defaults: the drain protects a storage limit and must not stop because
 * a setting could not be read.
 */
export async function resolveProjectDataArchiveSweepOptions(
  env: Env
): Promise<ProjectDataArchiveSweepOptions> {
  try {
    const [minStorageUsagePercent, storageTelemetryMaxAgeHours] = await Promise.all([
      resolveAdminSetting(env, 'operations.projectDataArchiveMinStorageUsagePercent'),
      resolveAdminSetting(env, 'operations.projectDataArchiveStorageTelemetryMaxAgeHours'),
    ]);
    return {
      minStorageUsagePercent: Number(minStorageUsagePercent),
      storageTelemetryMaxAgeHours: Number(storageTelemetryMaxAgeHours),
    };
  } catch (error) {
    log.warn('project_data_archive_sweep_settings_unavailable', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

export async function runProjectDataArchiveSharding(env: Env, nowDate = new Date()) {
  return runArchiveSweep(env, nowDate, await resolveProjectDataArchiveSweepOptions(env));
}
