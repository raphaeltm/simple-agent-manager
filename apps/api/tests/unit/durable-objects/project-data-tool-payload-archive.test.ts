import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROJECT_DATA_EVENT_LOG_CLEANUP_RECHECK_MS,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_CHUNK_BYTES,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_METADATA_BYTES,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_OPERATIONS,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETRY_DELAY_MS,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_WRITE_TIMEOUT_MS,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_WALL_TIME_MS,
  resolveStorageSafetyConfig,
} from '../../../src/durable-objects/project-data/storage-safety';
import {
  buildToolPayloadArchiveKey,
  DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX,
} from '../../../src/durable-objects/project-data/tool-payload-archive';
import {
  parseToolPayloadArchiveObjectText,
  writeToolPayloadArchiveObject,
} from '../../../src/durable-objects/project-data/tool-payload-archive-r2';
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
    expect(defaults.toolPayloadArchiveMaxOperations).toBe(
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_OPERATIONS
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
    expect(defaults.toolPayloadCleanupRecheckMs).toBe(
      DEFAULT_PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS
    );
    expect(defaults.eventLogCleanupRecheckMs).toBe(
      DEFAULT_PROJECT_DATA_EVENT_LOG_CLEANUP_RECHECK_MS
    );
    expect(defaults.toolPayloadCleanupRecheckMs).toBe(24 * 60 * 60 * 1000);
    expect(defaults.eventLogCleanupRecheckMs).toBe(24 * 60 * 60 * 1000);
    expect(defaults.toolPayloadCleanupProjectIds).toBeNull();
    expect(defaults.toolPayloadCleanupCutoffCreatedAt).toBeNull();
    expect(defaults.toolPayloadCleanupExactConfigValid).toBe(true);

    const overrides = resolveStorageSafetyConfig({
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_WALL_TIME_MS: '1234',
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS: '3456',
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_ROW_BYTES: '2345',
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PROJECT_IDS: 'project-b, project-a,project-b',
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PLAN_ID: 'operator-plan',
      PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_CUTOFF_CREATED_AT: '1788048000000',
      PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_RETENTION_DAYS: '3',
      PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_INTERVAL_MS: '4567',
      PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_R2_PREFIX: '/custom/tool-payloads/',
      PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_WRITE_TIMEOUT_MS: '5678',
      PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_OPERATIONS: '77',
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
      PROJECT_DATA_EVENT_LOG_CLEANUP_RECHECK_MS: '7000',
    } as Env);
    expect(overrides.toolPayloadCleanupWallTimeMs).toBe(1234);
    expect(overrides.toolPayloadCleanupRecheckMs).toBe(3456);
    expect(overrides.toolPayloadCleanupMaxRowBytes).toBe(2345);
    expect(overrides.toolPayloadCleanupProjectIds).toEqual(['project-a', 'project-b']);
    expect(overrides.toolPayloadCleanupPlanId).toBe('operator-plan');
    expect(overrides.toolPayloadCleanupCutoffCreatedAt).toBe(1788048000000);
    expect(overrides.toolPayloadArchiveRetentionMs).toBe(3 * 24 * 60 * 60 * 1000);
    expect(overrides.toolPayloadArchiveIntervalMs).toBe(4567);
    expect(overrides.toolPayloadArchiveWriteTimeoutMs).toBe(5678);
    expect(overrides.toolPayloadArchiveMaxOperations).toBe(77);
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
    expect(overrides.eventLogCleanupRecheckMs).toBe(7000);
    expect(
      resolveStorageSafetyConfig({
        PROJECT_DATA_TOOL_PAYLOAD_ARCHIVE_MAX_OPERATIONS: '3garbage',
      } as Env).toolPayloadCleanupExactConfigValid
    ).toBe(false);
  });

  it('uses different immutable keys when an old timed-out write completes after a changed retry', async () => {
    const objects = new Map<string, Uint8Array>();
    let releaseOld!: () => void;
    const bucket = {
      put: (key: string, value: string | Uint8Array) => {
        const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
        if (value === '{"payload":"old"}') {
          return new Promise<null>((resolve) => {
            releaseOld = () => {
              objects.set(key, bytes);
              resolve(null);
            };
          });
        }
        objects.set(key, bytes);
        return Promise.resolve(null);
      },
      get: async (key: string) => {
        const bytes = objects.get(key);
        return bytes ? ({ arrayBuffer: async () => bytes.buffer } as R2ObjectBody) : null;
      },
    } as unknown as R2Bucket;
    const base = {
      key: 'project-data/tool-payloads/project/session/message.json',
      contentBytes: 1,
      archiveVersion: 1,
      strippedToolMetadata: '{}',
      strippedToolMetadataBytes: 2,
    };
    const archiveInput = {
      projectId: 'project',
      sessionId: 'session',
      messageId: 'message',
      messageCreatedAt: 1,
      messageSequence: 1,
      archivedAt: 2,
      contentBytes: 1,
      toolMetadataBytes: 20,
      chunkBytes: 1_000,
      deadlineMs: Date.now() + 10_000,
      nowMs: Date.now,
    };

    await expect(
      writeToolPayloadArchiveObject(bucket, { ...base, body: '{"payload":"old"}' }, 1, {
        ...archiveInput,
        operationBudget: { used: 0, max: 3 },
      })
    ).rejects.toThrow(/archive write exceeded/);
    const changed = await writeToolPayloadArchiveObject(
      bucket,
      { ...base, body: '{"payload":"new"}' },
      100,
      { ...archiveInput, operationBudget: { used: 0, max: 3 } }
    );
    releaseOld();
    await Promise.resolve();

    expect(changed.key).toMatch(/\.[a-f0-9]{64}\.json$/);
    expect(new TextDecoder().decode(objects.get(changed.key))).toBe('{"payload":"new"}');
    expect([...objects.keys()]).toHaveLength(2);
  });

  it('fails closed for equal or reversed exact-plan cleanup ratios', () => {
    for (const [trigger, target] of [
      ['0.9', '0.9'],
      ['0.8', '0.9'],
    ]) {
      const config = resolveStorageSafetyConfig({
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO: trigger,
        PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO: target,
      } as Env);
      expect(config.toolPayloadCleanupExactConfigValid).toBe(false);
    }
  });

  it('keeps a changed chunk-layout retry readable after the timed-out old chunk completes', async () => {
    const objects = new Map<string, Uint8Array>();
    let releaseOld!: () => void;
    let delayFirstPut = true;
    const bucket = {
      put: (key: string, value: string | Uint8Array) => {
        const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
        if (delayFirstPut) {
          delayFirstPut = false;
          return new Promise<null>((resolve) => {
            releaseOld = () => {
              objects.set(key, bytes.slice());
              resolve(null);
            };
          });
        }
        objects.set(key, bytes.slice());
        return Promise.resolve(null);
      },
      get: async (key: string) => {
        const bytes = objects.get(key);
        return bytes ? ({ arrayBuffer: async () => bytes.slice().buffer } as R2ObjectBody) : null;
      },
    } as unknown as R2Bucket;
    const base = {
      key: 'project-data/tool-payloads/project/session/chunked-message.json',
      body: JSON.stringify({
        version: 1,
        projectId: 'project',
        sessionId: 'session',
        messageId: 'chunked-message',
        messageCreatedAt: 1,
        messageSequence: 1,
        archivedAt: 2,
        contentBytes: 1,
        toolMetadataBytes: 50,
        toolMetadata: { content: [{ type: 'text', text: 'layout-change' }] },
      }),
      contentBytes: 1,
      archiveVersion: 1,
      strippedToolMetadata: '{}',
      strippedToolMetadataBytes: 2,
    };
    const archiveInput = {
      projectId: 'project',
      sessionId: 'session',
      messageId: 'chunked-message',
      messageCreatedAt: 1,
      messageSequence: 1,
      archivedAt: 2,
      contentBytes: 1,
      toolMetadataBytes: 50,
      deadlineMs: Date.now() + 10_000,
      nowMs: Date.now,
    };
    await expect(
      writeToolPayloadArchiveObject(bucket, base, 1, {
        ...archiveInput,
        chunkBytes: 13,
        operationBudget: { used: 0, max: 100 },
      })
    ).rejects.toThrow(/archive write exceeded/);
    const changed = await writeToolPayloadArchiveObject(bucket, base, 100, {
      ...archiveInput,
      chunkBytes: 17,
      operationBudget: { used: 0, max: 100 },
    });
    const rootBefore = objects.get(changed.key)?.slice();
    releaseOld();
    await Promise.resolve();
    expect(objects.get(changed.key)).toEqual(rootBefore);
    const parsed = await parseToolPayloadArchiveObjectText(
      bucket,
      new TextDecoder().decode(rootBefore),
      {
        toolMetadataBytes: 50,
        maxMetadataBytes: 1_000,
        expectedIdentity: {
          projectId: 'project',
          sessionId: 'session',
          messageId: 'chunked-message',
          messageCreatedAt: 1,
          messageSequence: 1,
        },
      }
    );
    expect(parsed).toMatchObject({ toolMetadata: { content: expect.any(Array) } });
  });
});
