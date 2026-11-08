import type { Env } from '../env';
import { resolveAdminSetting } from './admin-settings';

export async function resolveProviderLimitResetWindowTolerance(env: Env): Promise<number> {
  return Number(await resolveAdminSetting(env, 'operations.providerLimitResetWindowToleranceMs'));
}
