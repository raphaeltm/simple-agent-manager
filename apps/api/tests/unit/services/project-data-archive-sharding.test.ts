import { describe, expect, it } from 'vitest';

import {
  canonicalArchiveHash,
  canonicalArchiveRows,
} from '../../../src/durable-objects/project-data/archive-sharding-canonical';
import {
  parseProjectDataOwnerLocationRow,
  resolveLegacyOrExactOwnerLocation,
  resolveProjectDataOwnerLocation,
} from '../../../src/services/project-data-archive-routing';
import {
  ARCHIVE_JOURNAL_STATES,
  buildArchiveShardOwnerName,
  ProjectDataArchiveRoutingError,
  resolveArchiveShardingConfig,
} from '../../../src/services/project-data-archive-types';

describe('ProjectData archive sharding contracts', () => {
  it('keeps migration disabled by default and caps chunks below the DO RPC ceiling', () => {
    const config = resolveArchiveShardingConfig({});

    expect(config.enabled).toBe(false);
    expect(config.chunkMaxBytes).toBeLessThan(32 * 1024 * 1024);
    expect(config.chunkMaxRows).toBeGreaterThan(0);
    expect(config.maxCandidatesPerSweep).toBeGreaterThan(0);
  });

  it('fails closed on an unsupported configured routing contract', () => {
    expect(() =>
      resolveArchiveShardingConfig({ PROJECT_DATA_ARCHIVE_ROUTING_VERSION: '2' })
    ).toThrow(/Unsupported configured ProjectData routing version/);
  });

  it('applies operator values below non-raiseable protocol ceilings', () => {
    const config = resolveArchiveShardingConfig({
      PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_PER_SWEEP: '40',
      PROJECT_DATA_ARCHIVE_MAX_CANDIDATES_HARD_LIMIT: '30',
      PROJECT_DATA_ARCHIVE_MAX_CHUNKS_PER_SWEEP: '150',
      PROJECT_DATA_ARCHIVE_MAX_CHUNKS_HARD_LIMIT: '120',
      PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS: '2000',
      PROJECT_DATA_ARCHIVE_CHUNK_MAX_ROWS_HARD_LIMIT: '1500',
      PROJECT_DATA_ARCHIVE_SHARD_COUNT: '400',
      PROJECT_DATA_ARCHIVE_SHARD_COUNT_HARD_LIMIT: '300',
      PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS: '90',
      PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS_HARD_LIMIT: '80',
      PROJECT_DATA_ARCHIVE_CIRCUIT_FAILURES: '150',
      PROJECT_DATA_ARCHIVE_SWEEP_MAX_WALL_MS: '60000',
      PROJECT_DATA_ARCHIVE_SWEEP_MAX_IO_OPS: '500',
      PROJECT_DATA_ARCHIVE_COPY_EXPANSION_RATIO: '3',
      PROJECT_DATA_ARCHIVE_ERROR_MAX_CHARS: '50000',
    });

    expect(config).toMatchObject({
      maxCandidatesPerSweep: 25,
      maxChunksPerSweep: 100,
      chunkMaxRows: 1000,
      shardCount: 256,
      searchMaxOwners: 7,
      circuitFailures: 150,
      sweepMaxWallMs: 30_000,
      sweepMaxIoOps: 30,
      copyExpansionRatio: 3,
      errorMaxChars: 10_000,
    });
  });

  it.each(['temp-uploads/archive', 'diagnostic-incidents/archive', 'project-data', '../bad'])(
    'fails closed for an expiring or unsafe recovery prefix: %s',
    (prefix) => {
      expect(() =>
        resolveArchiveShardingConfig({ PROJECT_DATA_ARCHIVE_R2_PREFIX: prefix })
      ).toThrow(/safe private project-data namespace/);
    }
  );

  it('enumerates the crash-proof source_deleted journal state', () => {
    expect(ARCHIVE_JOURNAL_STATES).toEqual([
      'planned',
      'copying',
      'sealed',
      'source_deleted',
      'archived',
      'frozen',
      'failed',
    ]);
  });

  it('builds deterministic packed archive owner names without changing the root identity', () => {
    expect(buildArchiveShardOwnerName('project-a', 3)).toBe('project-data-archive:project-a:3');
    expect(buildArchiveShardOwnerName('project-a', 3)).toBe(
      buildArchiveShardOwnerName('project-a', 3)
    );
  });

  it('treats an absent D1 row as the explicit legacy root generation and never as archive fallback', () => {
    expect(resolveLegacyOrExactOwnerLocation('project-a', 'session-a', null)).toEqual({
      projectId: 'project-a',
      sessionId: 'session-a',
      state: 'root',
      owner: { kind: 'root', name: 'project-a', generation: 0 },
      migrationId: null,
    });
  });

  it('fails closed when the authoritative D1 location lookup is unavailable', async () => {
    const database = {
      prepare: () => {
        throw new Error('D1 unavailable');
      },
    } as unknown as D1Database;

    await expect(
      resolveProjectDataOwnerLocation(database, 'project-a', 'session-a')
    ).rejects.toThrow(/owner location lookup failed: D1 unavailable/);
  });

  it.each([
    {
      label: 'transitional pointer',
      row: {
        project_id: 'project-a',
        session_id: 'session-a',
        state: 'migrating',
        owner_kind: 'archive_shard',
        owner_name: 'project-data-archive:project-a:0',
        generation: 1,
        migration_id: 'migration-a',
        routing_version: 1,
      },
    },
    {
      label: 'missing archive generation',
      row: {
        project_id: 'project-a',
        session_id: 'session-a',
        state: 'archive_shard',
        owner_kind: 'archive_shard',
        owner_name: 'project-data-archive:project-a:0',
        generation: null,
        migration_id: 'migration-a',
        routing_version: 1,
      },
    },
    {
      label: 'unsupported direct-session owner',
      row: {
        project_id: 'project-a',
        session_id: 'session-a',
        state: 'direct_session',
        owner_kind: 'direct_session',
        owner_name: 'project-data-session:project-a:session-a',
        generation: 2,
        migration_id: 'migration-a',
        routing_version: 1,
      },
    },
    {
      label: 'non-deterministic archive owner suffix',
      row: {
        project_id: 'project-a',
        session_id: 'session-a',
        state: 'archive_shard',
        owner_kind: 'archive_shard',
        owner_name: 'project-data-archive:project-a:not-a-shard',
        generation: 1,
        migration_id: 'migration-a',
        routing_version: 1,
      },
    },
  ])('fails closed for $label', ({ row }) => {
    expect(() => parseProjectDataOwnerLocationRow(row)).toThrow(ProjectDataArchiveRoutingError);
  });

  it('hashes every named migrated column canonically and detects one-column drift', async () => {
    const rows = [
      {
        id: 'message-a',
        session_id: 'session-a',
        role: 'assistant',
        content: 'same text',
        tool_metadata: null,
        created_at: 42,
        sequence: 7,
        origin: null,
      },
    ];
    const changed = [{ ...rows[0], origin: 'system' }];

    const canonical = canonicalArchiveRows('chat_messages', rows);
    expect(canonical).toContain('"origin":null');
    expect(canonical).toContain('"sequence":7');
    await expect(canonicalArchiveHash('chat_messages', rows)).resolves.not.toBe(
      await canonicalArchiveHash('chat_messages', changed)
    );
  });
});
