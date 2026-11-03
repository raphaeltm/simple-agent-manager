/** Reads every Operations-tool setting (definitions in ./settings-definitions.ts). */
import type { Env } from '../../env';
import { resolveAdminSettingDetailsMany } from '../admin-settings-resolution';
import { FLEET_OPS_DEFAULTS, FLEET_OPS_SETTINGS, type FleetOpsSettings } from './settings-definitions';

export { FLEET_OPS_DEFAULTS, type FleetOpsSettings } from './settings-definitions';

/** One batched read of every Operations-tool setting. */
export async function resolveFleetOpsSettings(env: Env): Promise<FleetOpsSettings> {
  const details = await resolveAdminSettingDetailsMany(
    env,
    FLEET_OPS_SETTINGS.map((s) => s.name)
  );
  const settings = { ...FLEET_OPS_DEFAULTS };
  FLEET_OPS_SETTINGS.forEach((spec, index) => {
    const value = details[index]?.value;
    if (typeof value === 'number' && Number.isFinite(value)) settings[spec.key] = value;
  });
  return settings;
}
