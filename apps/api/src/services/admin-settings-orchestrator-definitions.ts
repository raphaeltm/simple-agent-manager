import { type AdminSettingDefinition, integerDefinition } from './admin-setting-definitions';

export const MISSION_CANCELLATION_DEFAULTS = {
  pageSize: 25,
  turnMs: 5_000,
  retryPasses: 3,
  residenceMs: 900_000,
  intervalMs: 1_000,
} as const;

export const MISSION_CANCELLATION_SETTING_NAMES = {
  pageSize: 'orchestrator.cancellationPageSize',
  turnMs: 'orchestrator.cancellationTurnMs',
  retryPasses: 'orchestrator.cancellationRetryPasses',
  residenceMs: 'orchestrator.cancellationResidenceMs',
  intervalMs: 'orchestrator.cancellationIntervalMs',
} as const;

export type OrchestratorSettingName =
  (typeof MISSION_CANCELLATION_SETTING_NAMES)[keyof typeof MISSION_CANCELLATION_SETTING_NAMES];

const details = {
  pageSize: { max: 100, description: 'Maximum tasks visited in one mission cancellation turn.' },
  turnMs: {
    max: 30_000,
    description: 'Elapsed work budget in milliseconds for one mission cancellation turn.',
  },
  retryPasses: {
    max: 10,
    description: 'Maximum cancellation passes before explicit retry is required.',
  },
  residenceMs: {
    max: 86_400_000,
    description: 'Maximum mission cancellation episode residence in milliseconds before blocking.',
  },
  intervalMs: {
    max: 300_000,
    description: 'Alarm delay in milliseconds between pending mission cancellation turns.',
  },
} as const;

export const ORCHESTRATOR_SETTINGS: readonly AdminSettingDefinition[] = (
  Object.keys(MISSION_CANCELLATION_DEFAULTS) as Array<keyof typeof MISSION_CANCELLATION_DEFAULTS>
).map((key) =>
  integerDefinition(
    MISSION_CANCELLATION_SETTING_NAMES[key],
    MISSION_CANCELLATION_DEFAULTS[key],
    'Operations',
    details[key].description,
    { min: 1, max: details[key].max }
  )
);
