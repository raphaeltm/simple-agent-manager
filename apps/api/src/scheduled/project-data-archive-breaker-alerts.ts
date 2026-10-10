/**
 * Operator alert for a ProjectData archive circuit breaker that a sweep opened.
 *
 * Poisoning a migration opens its project's breaker, and archiving for that project stops until a
 * superadmin closes the breaker in Admin → Storage. Nothing reported that: the sweep only counted
 * the poisoning and finished `partial`, and failed-sweep notifications cover sweeps that throw.
 * The SAM root project's breaker stayed open for five days from 2026-09-27 and re-opened on
 * 2026-10-06 while its storage climbed back toward the hard cap.
 *
 * The alert fires on the transition, closed (or no row) → open, which the poisoning reads in the
 * same D1 transaction that opens the breaker. One opening therefore alerts once, however many
 * migrations it poisons and however long the breaker stays open.
 */
import { isJsonRecord } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { getProjectName } from '../services/notification';
import { persistError } from '../services/observability';
import {
  listOperatorUserIds,
  notifyOperatorsOnce,
  resolveOperatorNotificationThrottleMs,
} from './operator-notifications';

export const PROJECT_DATA_ARCHIVE_BREAKER_OPENED_ALERT = 'project_data_archive_breaker_opened';
/** Admin → Storage, where the breaker is closed and poisoned migrations are abandoned. */
const BREAKER_CONTROLS_PATH = '/admin/storage';

export interface ProjectDataArchiveBreakerOpening {
  projectId: string;
  /** The migration whose poisoning opened the breaker; it identifies this opening. */
  migrationId: string;
  reason: string;
  message: string | null;
  openedAt: number;
}

/**
 * Whether the breaker was closed, or had no row, before the write that opened it. `result` is the
 * `SELECT state` that runs just before the breaker upsert in the same D1 batch. An unreadable
 * result counts as closed: a duplicate alert costs less than a breaker that opened silently.
 */
export function breakerWasClosedBeforeOpening(result: D1Result | undefined): boolean {
  const row = result?.results?.[0];
  if (row === undefined) return true;
  return !isJsonRecord(row) || typeof row.state !== 'string' || row.state === 'closed';
}

/**
 * Record the opening in `/admin/errors` and notify every operator once. Never throws: the sweep
 * that poisoned the migration must still finish.
 */
export async function alertProjectDataArchiveBreakerOpened(
  env: Env,
  opening: ProjectDataArchiveBreakerOpening
): Promise<void> {
  try {
    const { projectId, migrationId, reason, message, openedAt } = opening;
    const projectName = await getProjectName(env, projectId);
    log.error(PROJECT_DATA_ARCHIVE_BREAKER_OPENED_ALERT, {
      projectId,
      projectName,
      migrationId,
      reason,
      openedAt,
    });
    await persistError(
      env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: 'error',
        message: `ProjectData archive circuit breaker opened for ${projectName} (${projectId}): ${reason}`,
        context: {
          alertKind: PROJECT_DATA_ARCHIVE_BREAKER_OPENED_ALERT,
          projectId,
          migrationId,
          reason,
          errorMessage: message,
          openedAt,
        },
      },
      env
    );
    const delivery = await notifyOperatorsOnce(
      env,
      await listOperatorUserIds(env),
      `${PROJECT_DATA_ARCHIVE_BREAKER_OPENED_ALERT}:${projectId}:${migrationId}`,
      openedAt + resolveOperatorNotificationThrottleMs(env),
      {
        type: 'cron_failure',
        urgency: 'high',
        title: `Archiving stopped for ${projectName}`,
        body:
          `The project's archive circuit breaker opened after migration ${migrationId} failed ` +
          `(${reason}). Its ProjectData storage keeps growing until the breaker is closed in ` +
          'Admin → Storage.',
        actionUrl: BREAKER_CONTROLS_PATH,
        metadata: {
          alertKind: PROJECT_DATA_ARCHIVE_BREAKER_OPENED_ALERT,
          projectId,
          migrationId,
          reason,
        },
      },
      openedAt
    );
    if (delivery.failed > 0) {
      log.error('project_data_archive_breaker_alert_delivery_failed', {
        projectId,
        migrationId,
        failedDeliveries: delivery.failed,
      });
    }
  } catch (error) {
    log.error('project_data_archive_breaker_alert_failed', {
      projectId: opening.projectId,
      migrationId: opening.migrationId,
      ...serializeError(error),
    });
  }
}
