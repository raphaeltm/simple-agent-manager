import type { Env } from '../../env';
import { log } from '../../lib/logger';
import type { AdminSettingName } from '../admin-setting-definitions';
import { resolveAdminSettingDetailsMany } from '../admin-settings-resolution';
import { LIFECYCLE_LATENCY_DEFAULTS, type LifecycleLatencySettingKey } from './defaults';

export type LifecycleEntityType = 'workspace' | 'node' | 'session_sleep' | 'session_recovery';

/**
 * Where each entity's state lives. Column names are constants, never caller input. The
 * changed-at columns are maintained by the D1 triggers in migration 0218, so they move only on
 * a real state change (unlike `updated_at`, which retries and keepalives rewrite).
 */
export const LIFECYCLE_ENTITY_SOURCES: Record<
  LifecycleEntityType,
  { table: string; statusColumn: string; changedAtColumn: string; detailColumns: string }
> = {
  workspace: {
    table: 'workspaces',
    statusColumn: 'status',
    changedAtColumn: 'status_changed_at',
    detailColumns:
      'node_id AS node_id, id AS workspace_id, user_id AS user_id, chat_session_id AS chat_session_id, error_message AS error_message',
  },
  node: {
    table: 'nodes',
    statusColumn: 'status',
    changedAtColumn: 'status_changed_at',
    detailColumns:
      'id AS node_id, NULL AS workspace_id, user_id AS user_id, NULL AS chat_session_id, error_message AS error_message',
  },
  session_sleep: {
    table: 'session_snapshots',
    statusColumn: 'sleep_status',
    changedAtColumn: 'sleep_status_changed_at',
    detailColumns:
      'node_id AS node_id, workspace_id AS workspace_id, user_id AS user_id, chat_session_id AS chat_session_id, sleep_error AS error_message',
  },
  session_recovery: {
    table: 'session_snapshots',
    statusColumn: 'recovery_status',
    changedAtColumn: 'recovery_status_changed_at',
    detailColumns:
      'node_id AS node_id, recovery_workspace_id AS workspace_id, user_id AS user_id, chat_session_id AS chat_session_id, recovery_error AS error_message',
  },
};

export interface LifecycleWatch {
  entityType: LifecycleEntityType;
  status: string;
  budgetKey: LifecycleLatencySettingKey;
}

/** Transient states only: each should end on its own within minutes. */
export const LIFECYCLE_WATCHES: readonly LifecycleWatch[] = [
  { entityType: 'workspace', status: 'pending', budgetKey: 'workspacePendingMinutes' },
  { entityType: 'workspace', status: 'creating', budgetKey: 'workspaceCreatingMinutes' },
  { entityType: 'workspace', status: 'recovery', budgetKey: 'workspaceRecoveryMinutes' },
  { entityType: 'workspace', status: 'stopping', budgetKey: 'workspaceStoppingMinutes' },
  { entityType: 'node', status: 'pending', budgetKey: 'nodePendingMinutes' },
  { entityType: 'node', status: 'creating', budgetKey: 'nodeCreatingMinutes' },
  { entityType: 'node', status: 'recovery', budgetKey: 'nodeRecoveryMinutes' },
  { entityType: 'node', status: 'stopping', budgetKey: 'nodeStoppingMinutes' },
  { entityType: 'session_sleep', status: 'preparing', budgetKey: 'sessionSleepPreparingMinutes' },
  { entityType: 'session_sleep', status: 'stopping', budgetKey: 'sessionSleepStoppingMinutes' },
  { entityType: 'session_recovery', status: 'waking', budgetKey: 'sessionWakingMinutes' },
];

export type LifecycleLatencySettings = Record<LifecycleLatencySettingKey, number>;

const SETTING_KEYS = Object.keys(LIFECYCLE_LATENCY_DEFAULTS) as LifecycleLatencySettingKey[];

/**
 * Resolves every lifecycle latency setting through the admin settings registry. Monitoring must
 * keep running when the settings store is briefly unavailable, so that case uses code defaults.
 */
export async function resolveLifecycleLatencySettings(env: Env): Promise<LifecycleLatencySettings> {
  try {
    const names = SETTING_KEYS.map((key) => `lifecycleLatency.${key}` as AdminSettingName);
    const details = await resolveAdminSettingDetailsMany(env, names);
    const settings = { ...LIFECYCLE_LATENCY_DEFAULTS } as LifecycleLatencySettings;
    SETTING_KEYS.forEach((key, index) => {
      const value = details[index]?.value;
      if (typeof value === 'number' && Number.isFinite(value)) settings[key] = value;
    });
    return settings;
  } catch (error) {
    log.warn('lifecycle_latency.settings_unavailable', {
      error: error instanceof Error ? error.message : String(error),
      action: 'using_code_defaults',
    });
    return { ...LIFECYCLE_LATENCY_DEFAULTS };
  }
}

export function budgetMs(settings: LifecycleLatencySettings, watch: LifecycleWatch): number {
  return Math.max(0, settings[watch.budgetKey]) * 60_000;
}
