/** The effective brief controls for one request (`project-brief-settings-definition.ts`). */
import {
  PROJECT_BRIEF_ENABLED_SETTING,
  PROJECT_BRIEF_INTEGER_SETTINGS,
} from './project-brief-settings-definition';
import type { OperationDeps } from './types';

export interface ProjectBriefSettings {
  enabled: boolean;
  minIntervalMinutes: number;
  dailyCap: number;
  checkIntervalSeconds: number;
}

export function defaultProjectBriefSettings(): ProjectBriefSettings {
  const [minInterval, dailyCap, checkInterval] = PROJECT_BRIEF_INTEGER_SETTINGS;
  return {
    enabled: PROJECT_BRIEF_ENABLED_SETTING.defaultValue,
    minIntervalMinutes: minInterval.defaultValue,
    dailyCap: dailyCap.defaultValue,
    checkIntervalSeconds: checkInterval.defaultValue,
  };
}

/**
 * Each value falls back to its code default when it is malformed. When settings storage cannot be
 * read at all the brief is treated as switched off: it is optional, and a page without it is
 * correct, while spending on the model without the admin's bounds is not.
 */
export async function getProjectBriefSettings(
  deps: Pick<OperationDeps, 'ports'>
): Promise<ProjectBriefSettings> {
  const defaults = defaultProjectBriefSettings();
  let rows: Array<{ value: unknown }>;
  try {
    rows = await deps.ports.settings.resolveDetailsMany([
      PROJECT_BRIEF_ENABLED_SETTING.name,
      ...PROJECT_BRIEF_INTEGER_SETTINGS.map((setting) => setting.name),
    ]);
  } catch {
    return { ...defaults, enabled: false };
  }
  const integer = (index: number, fallback: number) => {
    const value = rows[index]?.value;
    return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
  };
  const enabled = rows[0]?.value;
  return {
    enabled: typeof enabled === 'boolean' ? enabled : defaults.enabled,
    minIntervalMinutes: integer(1, defaults.minIntervalMinutes),
    dailyCap: integer(2, defaults.dailyCap),
    checkIntervalSeconds: integer(3, defaults.checkIntervalSeconds),
  };
}
