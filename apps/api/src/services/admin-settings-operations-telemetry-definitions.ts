import { type AdminSettingDefinition, integerDefinition } from './admin-setting-definitions';
import {
  OPERATIONS_TELEMETRY_DEFAULTS,
  OPERATIONS_TELEMETRY_DESCRIPTIONS,
  OPERATIONS_TELEMETRY_RANGES,
  type OperationsTelemetrySettingKey,
} from './operations-telemetry-defaults';

export const OPERATIONS_TELEMETRY_SETTINGS: AdminSettingDefinition[] = (
  Object.keys(OPERATIONS_TELEMETRY_DEFAULTS) as OperationsTelemetrySettingKey[]
).map((key) =>
  integerDefinition(
    `operations.${key}`,
    OPERATIONS_TELEMETRY_DEFAULTS[key],
    'Operations',
    OPERATIONS_TELEMETRY_DESCRIPTIONS[key],
    OPERATIONS_TELEMETRY_RANGES[key]
  )
);
