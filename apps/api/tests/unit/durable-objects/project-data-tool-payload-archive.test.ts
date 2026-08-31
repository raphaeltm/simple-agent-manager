import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_CHUNK_BYTES,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_WRITE_TIMEOUT_MS,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_WALL_TIME_MS,
  resolveStorageSafetyConfig,
} from '../../../src/durable-objects/project-data/storage-safety';
import {
  buildToolPayloadArchiveKey,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX,
} from '../../../src/durable-objects/project-data/tool-payload-archive';
import type { Env } from '../../../src/durable-objects/project-data/types';

describe('ProjectData tool payload archive helpers', () => {
  it('builds deterministic project-scoped private R2 keys', () => {
    expect(
      buildToolPayloadArchiveKey({
        prefix: '/custom-prefix/',
        projectId: 'project/one',
        sessionId: 'session one',
        messageId: 'message?one',
        messageCreatedAt: 1710000000000,
        messageSequence: 7,
      })
    ).toBe('custom-prefix/project%2Fone/session%20one/1710000000000-7-message%3Fone.json');
  });

  it('resolves archive retention defaults and env overrides', () => {
    const defaults = resolveStorageSafetyConfig({} as Env);
    expect(defaults.toolPayloadCleanupWallTimeMs).toBe(
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_WALL_TIME_MS
    );
    expect(defaults.toolPayloadCleanupMaxRowBytes).toBe(
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES
    );
    expect(defaults.toolPayloadArchiveRetentionMs).toBe(
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS * 24 * 60 * 60 * 1000
    );
    expect(defaults.toolPayloadArchiveIntervalMs).toBe(
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS
    );
    expect(defaults.toolPayloadArchiveWriteTimeoutMs).toBe(
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_WRITE_TIMEOUT_MS
    );
    expect(defaults.toolPayloadArchiveRetryDelayMs).toBe(
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS
    );
    expect(defaults.toolPayloadArchiveChunkBytes).toBe(
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_CHUNK_BYTES
    );
    expect(defaults.toolPayloadArchiveMaxMetadataBytes).toBe(
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES
    );
    expect(defaults.toolPayloadArchiveR2Prefix).toBe(
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX
    );

    const overrides = resolveStorageSafetyConfig({
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_WALL_TIME_MS: '1234',
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES: '2345',
      PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '3',
      PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS: '4567',
      PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX: '/custom/tool-payloads/',
      PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_WRITE_TIMEOUT_MS: '5678',
      PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS: '6789',
      PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_CHUNK_BYTES: '7890',
      PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES: '8901',
      PROJECT_DATA_STORAGE_RELIEF_MEASURE_BATCH_ROWS: '12',
      PROJECT_DATA_STORAGE_RELIEF_MEASURE_MAX_BATCH_ROWS: '34',
      PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED: 'true',
      PROJECT_DATA_GROUPED_FTS_CLEANUP_TRIGGER_RATIO: '0.7',
      PROJECT_DATA_GROUPED_FTS_CLEANUP_TARGET_RATIO: '0.6',
      PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_SESSIONS: '2',
      PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_ROWS: '3',
      PROJECT_DATA_GROUPED_FTS_CLEANUP_BATCH_BYTES: '4096',
      PROJECT_DATA_GROUPED_FTS_CLEANUP_MIN_SESSION_AGE_DAYS: '4',
      PROJECT_DATA_GROUPED_FTS_CLEANUP_RECHECK_MS: '5000',
      PROJECT_DATA_GROUPED_FTS_CLEANUP_WALL_TIME_MS: '6000',
      PROJECT_DATA_GROUPED_FTS_CLEANUP_WALL_UNSAFE_RATIO: '0.97',
      PROJECT_DATA_GROUPED_FTS_CLEANUP_WEAK_RECLAIM_BYTES: '8',
    } as Env);
    expect(overrides.toolPayloadCleanupWallTimeMs).toBe(1234);
    expect(overrides.toolPayloadCleanupMaxRowBytes).toBe(2345);
    expect(overrides.toolPayloadArchiveRetentionMs).toBe(3 * 24 * 60 * 60 * 1000);
    expect(overrides.toolPayloadArchiveIntervalMs).toBe(4567);
    expect(overrides.toolPayloadArchiveWriteTimeoutMs).toBe(5678);
    expect(overrides.toolPayloadArchiveRetryDelayMs).toBe(6789);
    expect(overrides.toolPayloadArchiveChunkBytes).toBe(7890);
    expect(overrides.toolPayloadArchiveMaxMetadataBytes).toBe(8901);
    expect(overrides.toolPayloadArchiveR2Prefix).toBe('custom/tool-payloads');
    expect(overrides.storageReliefMeasureBatchRows).toBe(12);
    expect(overrides.storageReliefMeasureMaxBatchRows).toBe(34);
    expect(overrides.groupedFtsCleanupEnabled).toBe(true);
    expect(overrides.groupedFtsCleanupTriggerRatio).toBe(0.7);
    expect(overrides.groupedFtsCleanupTargetRatio).toBe(0.6);
    expect(overrides.groupedFtsCleanupBatchSessions).toBe(2);
    expect(overrides.groupedFtsCleanupBatchRows).toBe(3);
    expect(overrides.groupedFtsCleanupBatchBytes).toBe(4096);
    expect(overrides.groupedFtsCleanupMinSessionAgeMs).toBe(4 * 24 * 60 * 60 * 1000);
    expect(overrides.groupedFtsCleanupRecheckMs).toBe(5000);
    expect(overrides.groupedFtsCleanupWallTimeMs).toBe(6000);
    expect(overrides.groupedFtsCleanupWallUnsafeRatio).toBe(0.97);
    expect(overrides.groupedFtsCleanupWeakReclaimBytes).toBe(8);
  });
});
