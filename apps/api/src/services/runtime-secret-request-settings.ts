/**
 * The effective bounds for agent-requested runtime secrets
 * (`runtime-secret-request-settings-definition.ts`).
 */
import type { Env } from '../env';
import { resolveAdminSettingDetailsMany } from './admin-settings';
import {
  RUNTIME_SECRET_REQUEST_SETTINGS,
  type RuntimeSecretRequestSettingName,
} from './runtime-secret-request-settings-definition';

type LimitKey<N extends string> = N extends `secrets.${infer K}` ? K : never;
export type RuntimeSecretRequestLimits = Record<LimitKey<RuntimeSecretRequestSettingName>, number>;

export function defaultRuntimeSecretRequestLimits(): RuntimeSecretRequestLimits {
  return Object.fromEntries(
    RUNTIME_SECRET_REQUEST_SETTINGS.map((setting) => [
      setting.name.slice('secrets.'.length),
      setting.defaultValue,
    ])
  ) as RuntimeSecretRequestLimits;
}

/** The effective limits, each falling back to its code default when unreadable. */
export async function getRuntimeSecretRequestLimits(env: Env): Promise<RuntimeSecretRequestLimits> {
  const names = RUNTIME_SECRET_REQUEST_SETTINGS.map((setting) => setting.name);
  let values: unknown[];
  try {
    values = (await resolveAdminSettingDetailsMany(env, [...names])).map((row) => row.value);
  } catch {
    // Settings storage unavailable: requests stay bounded by their code defaults.
    return defaultRuntimeSecretRequestLimits();
  }
  return Object.fromEntries(
    RUNTIME_SECRET_REQUEST_SETTINGS.map((setting, index) => {
      const value = values[index];
      return [
        setting.name.slice('secrets.'.length),
        typeof value === 'number' && Number.isInteger(value) ? value : setting.defaultValue,
      ];
    })
  ) as RuntimeSecretRequestLimits;
}
