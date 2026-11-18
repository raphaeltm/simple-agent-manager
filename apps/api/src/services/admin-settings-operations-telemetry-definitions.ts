import { DEFAULT_ROW_USAGE_INTERVAL_MS } from '@simple-agent-manager/project-data';

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

OPERATIONS_TELEMETRY_SETTINGS.push(
  integerDefinition(
    'operations.projectDataRowUsageIntervalMs',
    DEFAULT_ROW_USAGE_INTERVAL_MS,
    'Operations',
    'ProjectData per-operation row usage log interval in milliseconds; refreshed each usage window.',
    { min: 60_000, max: 24 * 60 * 60_000 }
  )
);
