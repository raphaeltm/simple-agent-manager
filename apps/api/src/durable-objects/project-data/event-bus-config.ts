import { DEFAULT_MCP_EVENT_BUS_CURSOR_MAX_LENGTH } from './event-bus-cursors';
import type { Env } from './types';

export const DEFAULT_PROJECT_DATA_EVENT_BUS_PAYLOAD_MAX_BYTES = 262_144;
export const DEFAULT_PROJECT_DATA_EVENT_BUS_METADATA_MAX_BYTES = 16_384;
export const DEFAULT_PROJECT_DATA_EVENT_BUS_MAX_ROUTED_SUBSCRIPTIONS = 1_000;
export const DEFAULT_PROJECT_DATA_EVENT_BUS_RETENTION_DAYS = 14;
export const DEFAULT_PROJECT_DATA_EVENT_BUS_RETENTION_BATCH_ROWS = 500;

export interface EventBusStorageConfig {
  payloadMaxBytes: number;
  metadataMaxBytes: number;
  maxRoutedSubscriptions: number;
  retentionMs: number;
  retentionBatchRows: number;
}

export function resolveEventBusStorageConfig(env: Env): EventBusStorageConfig {
  const retentionDays = parsePositiveInteger(
    env.PROJECT_DATA_EVENT_BUS_RETENTION_DAYS,
    DEFAULT_PROJECT_DATA_EVENT_BUS_RETENTION_DAYS
  );
  return {
    payloadMaxBytes: parsePositiveInteger(
      env.PROJECT_DATA_EVENT_BUS_PAYLOAD_MAX_BYTES,
      DEFAULT_PROJECT_DATA_EVENT_BUS_PAYLOAD_MAX_BYTES
    ),
    metadataMaxBytes: parsePositiveInteger(
      env.PROJECT_DATA_EVENT_BUS_METADATA_MAX_BYTES,
      DEFAULT_PROJECT_DATA_EVENT_BUS_METADATA_MAX_BYTES
    ),
    maxRoutedSubscriptions: parsePositiveInteger(
      env.PROJECT_DATA_EVENT_BUS_MAX_ROUTED_SUBSCRIPTIONS,
      DEFAULT_PROJECT_DATA_EVENT_BUS_MAX_ROUTED_SUBSCRIPTIONS
    ),
    retentionMs: retentionDays * 24 * 60 * 60 * 1000,
    retentionBatchRows: parsePositiveInteger(
      env.PROJECT_DATA_EVENT_BUS_RETENTION_BATCH_ROWS,
      DEFAULT_PROJECT_DATA_EVENT_BUS_RETENTION_BATCH_ROWS
    ),
  };
}

export function resolveEventBusCursorMaxLength(env: Env): number {
  return parsePositiveInteger(
    env.MCP_EVENT_BUS_CURSOR_MAX_LENGTH,
    DEFAULT_MCP_EVENT_BUS_CURSOR_MAX_LENGTH
  );
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
