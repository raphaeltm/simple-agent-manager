import type { Env } from '../../env';
import { resolveAdminSetting } from '../../services/admin-settings';
import {
  MISSION_CANCELLATION_DEFAULTS,
  MISSION_CANCELLATION_SETTING_NAMES,
} from '../../services/admin-settings-orchestrator-definitions';

export async function cancellationConfig(env: Env) {
  const keys = Object.keys(MISSION_CANCELLATION_DEFAULTS) as Array<
    keyof typeof MISSION_CANCELLATION_DEFAULTS
  >;
  const values = await Promise.all(
    keys.map(
      async (key) =>
        [
          key,
          Number(await resolveAdminSetting(env, MISSION_CANCELLATION_SETTING_NAMES[key])),
        ] as const
    )
  );
  return Object.fromEntries(values) as Record<keyof typeof MISSION_CANCELLATION_DEFAULTS, number>;
}

export async function continuationDelay(
  sql: SqlStorage,
  env: Env,
  schedulingIntervalMs: number
): Promise<number> {
  return sql.exec("SELECT 1 FROM orchestrator_missions WHERE status='cancelling' LIMIT 1").toArray()
    .length
    ? (await cancellationConfig(env)).intervalMs
    : schedulingIntervalMs;
}
