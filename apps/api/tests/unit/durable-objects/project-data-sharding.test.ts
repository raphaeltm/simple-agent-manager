import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DO_SHARD_AGGRESSIVE_THRESHOLD_BYTES,
  DEFAULT_DO_SHARD_CHECK_INTERVAL_MS,
  DEFAULT_DO_SHARD_HARD_BRAKE_THRESHOLD_BYTES,
  DEFAULT_DO_SHARD_MAX_SIZE_BYTES,
  DEFAULT_DO_SHARD_MIGRATION_BATCH_SIZE,
  DEFAULT_DO_SHARD_MIGRATION_THRESHOLD_BYTES,
  DEFAULT_DO_SHARD_TARGET_SIZE_BYTES,
  mergeSearchResults,
  resolveProjectDataShardConfig,
} from '../../../src/durable-objects/project-data/sharding';
import type { Env } from '../../../src/durable-objects/project-data/types';

describe('ProjectData sharding helpers', () => {
  it('uses documented defaults when env overrides are unset or invalid', () => {
    const config = resolveProjectDataShardConfig({
      DO_SHARD_MIGRATION_THRESHOLD_BYTES: 'invalid',
      DO_SHARD_MIGRATION_BATCH_SIZE: '-1',
    } as Env);

    expect(config).toEqual({
      migrationThresholdBytes: DEFAULT_DO_SHARD_MIGRATION_THRESHOLD_BYTES,
      aggressiveThresholdBytes: DEFAULT_DO_SHARD_AGGRESSIVE_THRESHOLD_BYTES,
      hardBrakeThresholdBytes: DEFAULT_DO_SHARD_HARD_BRAKE_THRESHOLD_BYTES,
      targetSizeBytes: DEFAULT_DO_SHARD_TARGET_SIZE_BYTES,
      maxShardSizeBytes: DEFAULT_DO_SHARD_MAX_SIZE_BYTES,
      migrationBatchSize: DEFAULT_DO_SHARD_MIGRATION_BATCH_SIZE,
      checkIntervalMs: DEFAULT_DO_SHARD_CHECK_INTERVAL_MS,
    });
  });

  it('parses positive env overrides and caps alarm batch size', () => {
    const config = resolveProjectDataShardConfig({
      DO_SHARD_MIGRATION_THRESHOLD_BYTES: '1000',
      DO_SHARD_AGGRESSIVE_THRESHOLD_BYTES: '2000',
      DO_SHARD_HARD_BRAKE_THRESHOLD_BYTES: '3000',
      DO_SHARD_TARGET_SIZE_BYTES: '400',
      DO_SHARD_MAX_SIZE_BYTES: '500',
      DO_SHARD_MIGRATION_BATCH_SIZE: '500',
      DO_SHARD_CHECK_INTERVAL_MS: '60000',
    } as Env);

    expect(config).toMatchObject({
      migrationThresholdBytes: 1000,
      aggressiveThresholdBytes: 2000,
      hardBrakeThresholdBytes: 3000,
      targetSizeBytes: 400,
      maxShardSizeBytes: 500,
      migrationBatchSize: 100,
      checkIntervalMs: 60000,
    });
  });

  it('deduplicates and sorts fan-out search results before applying the limit', () => {
    const merged = mergeSearchResults(
      [
        [
          {
            id: 'msg-1',
            sessionId: 'session-1',
            role: 'user',
            snippet: 'older',
            createdAt: 100,
            sessionTopic: null,
            sessionTaskId: null,
          },
        ],
        [
          {
            id: 'msg-1',
            sessionId: 'session-1',
            role: 'user',
            snippet: 'newer duplicate',
            createdAt: 200,
            sessionTopic: null,
            sessionTaskId: null,
          },
          {
            id: 'msg-2',
            sessionId: 'session-2',
            role: 'assistant',
            snippet: 'newest',
            createdAt: 300,
            sessionTopic: null,
            sessionTaskId: null,
          },
        ],
      ],
      2
    );

    expect(merged.map((result) => result.id)).toEqual(['msg-2', 'msg-1']);
    expect(merged[1]!.snippet).toBe('newer duplicate');
  });
});
