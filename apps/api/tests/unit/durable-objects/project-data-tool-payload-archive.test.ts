import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS,
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
    } as Env);
    expect(overrides.toolPayloadCleanupWallTimeMs).toBe(1234);
    expect(overrides.toolPayloadCleanupMaxRowBytes).toBe(2345);
    expect(overrides.toolPayloadArchiveRetentionMs).toBe(3 * 24 * 60 * 60 * 1000);
    expect(overrides.toolPayloadArchiveIntervalMs).toBe(4567);
    expect(overrides.toolPayloadArchiveWriteTimeoutMs).toBe(5678);
    expect(overrides.toolPayloadArchiveRetryDelayMs).toBe(6789);
    expect(overrides.toolPayloadArchiveR2Prefix).toBe('custom/tool-payloads');
  });
});
