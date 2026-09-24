import { DEFAULT_SAM_MAX_TOOL_RESULT_BYTES } from '@simple-agent-manager/shared';
import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { searchMessagesWithArchiveMetadata } from '../../../src/services/project-data';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

type SearchRow = {
  id: string;
  sessionId: string;
  role: string;
  snippet: string;
  createdAt: number;
  sessionTopic: string | null;
  sessionTaskId: string | null;
};

type SearchStub = {
  ensureProjectId: ReturnType<typeof vi.fn>;
  searchMessages: ReturnType<typeof vi.fn>;
  archiveTargetSearchProjectMessages: ReturnType<typeof vi.fn>;
};

function row(id: string, sessionId: string, createdAt: number): SearchRow {
  return {
    id,
    sessionId,
    role: 'assistant',
    snippet: `snippet ${id}`,
    createdAt,
    sessionTopic: 'Topic',
    sessionTaskId: null,
  };
}

function stub(input: {
  root?: SearchRow[];
  archive?: SearchRow[];
  failArchive?: boolean;
}): SearchStub {
  return {
    ensureProjectId: vi.fn(async () => undefined),
    searchMessages: vi.fn(async () => input.root ?? []),
    archiveTargetSearchProjectMessages: vi.fn(async () => {
      if (input.failArchive) throw new Error('archive owner unavailable');
      return {
        results: input.archive ?? [],
        coverage: {
          sessionsAvailable: 1,
          sessionsIndexed: 1,
          sessionsIncomplete: 0,
          errors: [],
        },
      };
    }),
  };
}

function envForSearch(sqlite: Database.Database, stubs: Record<string, SearchStub>): Env {
  const namespace = {
    idFromName: (name: string) => ({ toString: () => name }),
    get: (id: { toString(): string }) => stubs[id.toString()],
  };
  return {
    DATABASE: createSqliteD1(sqlite),
    PROJECT_DATA: namespace,
    ENCRYPTION_KEY: 'archive-search-test-key',
  } as unknown as Env;
}

function createLocationTable(sqlite: Database.Database): void {
  createSchemaTables(sqlite, [
    schema.projectDataArchiveMigrations,
    schema.projectDataSessionLocations,
  ]);
}

describe('ProjectData project-wide archive search metadata', () => {
  it('reports complete root-only search when no archive owners are published', async () => {
    const sqlite = new Database(':memory:');
    try {
      createLocationTable(sqlite);
      const root = stub({ root: [row('root-message', 'root-session', 100)] });
      const result = await searchMessagesWithArchiveMetadata(
        envForSearch(sqlite, { 'project-search': root }),
        'project-search',
        'needle',
        null,
        null,
        10
      );

      expect(result.results.map((item) => item.id)).toEqual(['root-message']);
      expect(result.archiveSearch).toMatchObject({
        partial: false,
        reason: null,
        archiveOwnersAvailable: 0,
        archiveOwnersQueried: 0,
        archiveOwnersOmitted: 0,
      });
      expect(root.searchMessages).toHaveBeenCalledWith('needle', null, null, 10);
    } finally {
      sqlite.close();
    }
  });

  it('searches a verified target during the source-deleted publication gap', async () => {
    const sqlite = new Database(':memory:');
    try {
      createLocationTable(sqlite);
      sqlite
        .prepare(
          `INSERT INTO project_data_archive_migrations
             (migration_id, project_id, session_id, state, source_owner_name,
              target_owner_name, target_generation, target_aggregate_sha256,
              created_at, updated_at)
           VALUES ('migration-gap', 'project-search', 'session-gap', 'source_deleted',
                   'project-search', 'project-search:archive:g2:s0', 2,
                   'verified-target-sha', 1000, 1000)`
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO project_data_session_locations
             (project_id, session_id, location_state, owner_kind, owner_name,
              generation, migration_id, routing_schema_version, updated_at)
           VALUES ('project-search', 'session-gap', 'migrating', 'archive_shard',
                   'project-search:archive:g2:s0', 2, 'migration-gap', 1, 1000)`
        )
        .run();
      const target = stub({ archive: [row('gap-message', 'session-gap', 500)] });
      const result = await searchMessagesWithArchiveMetadata(
        envForSearch(sqlite, {
          'project-search': stub({}),
          'project-search:archive:g2:s0': target,
        }),
        'project-search',
        'needle',
        null,
        null,
        10
      );

      expect(result.archiveSearch).toMatchObject({
        complete: true,
        archiveOwnersAvailable: 1,
        archiveOwnersQueried: 1,
      });
      expect(result.results.map((item) => item.id)).toEqual(['gap-message']);
    } finally {
      sqlite.close();
    }
  });

  it('bounds each owner batch and completes every owner through a query-bound continuation', async () => {
    const sqlite = new Database(':memory:');
    try {
      createLocationTable(sqlite);
      sqlite
        .prepare(
          `INSERT INTO project_data_session_locations
             (project_id, session_id, location_state, owner_kind, owner_name,
              generation, migration_id, routing_schema_version, updated_at)
           VALUES
             ('project-search', 'session-archive-a', 'archive_shard', 'archive_shard',
              'project-search:archive:g1:s0', 1, 'migration-a', 1, 1000),
             ('project-search', 'session-archive-b', 'archive_shard', 'archive_shard',
              'project-search:archive:g1:s1', 1, 'migration-b', 1, 1000)`
        )
        .run();
      const root = stub({ root: [row('root-message', 'root-session', 100)] });
      const archive = stub({ archive: [row('archive-message', 'session-archive-a', 200)] });
      const archiveB = stub({ archive: [row('archive-message-b', 'session-archive-b', 300)] });
      const env = {
        ...envForSearch(sqlite, {
          'project-search': root,
          'project-search:archive:g1:s0': archive,
          'project-search:archive:g1:s1': archiveB,
        }),
        PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS: '1',
      } as Env;
      const result = await searchMessagesWithArchiveMetadata(
        env,
        'project-search',
        'needle',
        null,
        null,
        10
      );

      expect(result.results.map((item) => item.id)).toEqual(['archive-message', 'root-message']);
      expect(result.archiveSearch).toMatchObject({
        partial: true,
        reason: 'continuation_required',
        complete: false,
        archiveOwnersAvailable: 2,
        archiveOwnersQueried: 1,
        archiveOwnersOmitted: 1,
        archiveOwnerLimit: 1,
      });
      expect(result.archiveSearch.continuation).toEqual(expect.any(String));
      expect(archive.archiveTargetSearchProjectMessages).toHaveBeenCalledWith(
        {
          kind: 'archive_shard',
          projectId: 'project-search',
          ownerName: 'project-search:archive:g1:s0',
          generation: 1,
        },
        'needle',
        null,
        10
      );
      const completed = await searchMessagesWithArchiveMetadata(
        env,
        'project-search',
        'needle',
        null,
        null,
        10,
        result.archiveSearch.continuation
      );
      expect(completed.results.map((item) => item.id)).toEqual([
        'archive-message-b',
        'archive-message',
        'root-message',
      ]);
      expect(completed.archiveSearch).toMatchObject({
        partial: false,
        complete: true,
        continuation: null,
        archiveOwnersQueried: 2,
        archiveOwnersOmitted: 0,
      });
      expect(root.searchMessages).toHaveBeenCalledTimes(1);
    } finally {
      sqlite.close();
    }
  });

  it('discloses archive inventory read failure instead of silently claiming complete results', async () => {
    const sqlite = new Database(':memory:');
    try {
      const root = stub({ root: [row('root-message', 'root-session', 100)] });
      const result = await searchMessagesWithArchiveMetadata(
        envForSearch(sqlite, { 'project-search': root }),
        'project-search',
        'needle',
        null,
        null,
        10
      );

      expect(result.results.map((item) => item.id)).toEqual(['root-message']);
      expect(result.archiveSearch).toMatchObject({
        partial: true,
        reason: 'archive_owner_inventory_unavailable',
        archiveOwnersQueried: 0,
      });
    } finally {
      sqlite.close();
    }
  });

  it('continues beyond 64 occupied owners and rejects a modified continuation', async () => {
    const sqlite = new Database(':memory:');
    try {
      createLocationTable(sqlite);
      const stubs: Record<string, SearchStub> = { 'project-search': stub({}) };
      const insert = sqlite.prepare(
        `INSERT INTO project_data_session_locations
           (project_id, session_id, location_state, owner_kind, owner_name,
            generation, migration_id, routing_schema_version, updated_at)
         VALUES ('project-search', ?, 'archive_shard', 'archive_shard', ?, 1, ?, 1, 1000)`
      );
      for (let index = 0; index < 65; index++) {
        const owner = `project-search:archive:g1:s${String(index).padStart(2, '0')}`;
        insert.run(`session-${index}`, owner, `migration-${index}`);
        stubs[owner] = stub({ archive: [row(`message-${index}`, `session-${index}`, index)] });
      }
      const env = {
        ...envForSearch(sqlite, stubs),
        PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS: '64',
      } as Env;
      const first = await searchMessagesWithArchiveMetadata(
        env,
        'project-search',
        'needle',
        null,
        null,
        10
      );
      expect(first.archiveSearch.ownerCoverage).toEqual({
        attempted: 64,
        succeeded: 64,
        remaining: 1,
        complete: false,
      });
      const continuation = first.archiveSearch.continuation;
      expect(continuation).toEqual(expect.any(String));
      // Agent tool results are capped at 16 KiB by default. The opaque cursor must
      // stay well below that boundary so callers can see and submit the next page.
      expect(continuation?.length).toBeLessThan(DEFAULT_SAM_MAX_TOOL_RESULT_BYTES / 2);
      await expect(
        searchMessagesWithArchiveMetadata(
          env,
          'project-search',
          'needle',
          null,
          null,
          10,
          `${continuation}x`
        )
      ).rejects.toThrow('continuation');
      await expect(
        searchMessagesWithArchiveMetadata(
          env,
          'project-search',
          'different-query',
          null,
          null,
          10,
          continuation
        )
      ).rejects.toThrow('does not match');
      await expect(
        searchMessagesWithArchiveMetadata(
          env,
          'project-search',
          'needle',
          null,
          ['assistant'],
          10,
          continuation
        )
      ).rejects.toThrow('does not match');
      await expect(
        searchMessagesWithArchiveMetadata(
          env,
          'project-search',
          'needle',
          null,
          null,
          9,
          continuation
        )
      ).rejects.toThrow('does not match');

      const completed = await searchMessagesWithArchiveMetadata(
        env,
        'project-search',
        'needle',
        null,
        null,
        10,
        continuation
      );
      expect(completed.archiveSearch.ownerCoverage).toEqual({
        attempted: 65,
        succeeded: 65,
        remaining: 0,
        complete: true,
      });
      expect(completed.archiveSearch.indexCoverage).toMatchObject({
        sessionsAvailable: 65,
        sessionsIndexed: 65,
        complete: true,
      });
    } finally {
      sqlite.close();
    }
  });

  it('keeps every exhaustive-search page within the SAM tool-result budget', async () => {
    const sqlite = new Database(':memory:');
    try {
      createLocationTable(sqlite);
      const stubs: Record<string, SearchStub> = { 'project-search': stub({}) };
      const insert = sqlite.prepare(
        `INSERT INTO project_data_session_locations
           (project_id, session_id, location_state, owner_kind, owner_name,
            generation, migration_id, routing_schema_version, updated_at)
         VALUES ('project-search', ?, 'archive_shard', 'archive_shard', ?, 1, ?, 1, 1000)`
      );
      for (let index = 0; index < 108; index++) {
        const owner = `project-search:archive:g1:s${String(index).padStart(3, '0')}`;
        insert.run(`session-${index}`, owner, `migration-${index}`);
        stubs[owner] = stub({ archive: [row(`message-${index}`, `session-${index}`, index)] });
      }
      const env = {
        ...envForSearch(sqlite, stubs),
        PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS: '4',
      } as Env;

      let continuation: string | null = null;
      let pages = 0;
      do {
        const page = await searchMessagesWithArchiveMetadata(
          env,
          'project-search',
          'needle',
          null,
          null,
          5,
          continuation
        );
        expect(JSON.stringify(page).length).toBeLessThan(DEFAULT_SAM_MAX_TOOL_RESULT_BYTES);
        continuation = page.archiveSearch.continuation;
        pages++;
      } while (continuation);

      expect(pages).toBe(27);
    } finally {
      sqlite.close();
    }
  });

  it('keeps a failed root search retryable and never reports false completion', async () => {
    const sqlite = new Database(':memory:');
    try {
      createLocationTable(sqlite);
      const root = stub({ root: [row('root-message', 'root-session', 100)] });
      root.searchMessages
        .mockRejectedValueOnce(new Error('temporary root failure'))
        .mockRejectedValueOnce(new Error('temporary root retry failure'))
        .mockResolvedValueOnce([row('root-message', 'root-session', 100)]);
      const env = envForSearch(sqlite, { 'project-search': root });

      const first = await searchMessagesWithArchiveMetadata(
        env,
        'project-search',
        'needle',
        null,
        null,
        10
      );
      expect(first.archiveSearch).toMatchObject({
        complete: false,
        partial: true,
        rootError: 'root_search_failed',
        ownerCoverage: { attempted: 0, succeeded: 0, remaining: 0, complete: true },
        indexCoverage: { complete: true },
      });
      expect(first.archiveSearch.continuation).toEqual(expect.any(String));

      const completed = await searchMessagesWithArchiveMetadata(
        env,
        'project-search',
        'needle',
        null,
        null,
        10,
        first.archiveSearch.continuation
      );
      expect(completed.archiveSearch).toMatchObject({
        complete: true,
        partial: false,
        rootError: null,
        continuation: null,
      });
      expect(completed.results.map((item) => item.id)).toEqual(['root-message']);
    } finally {
      sqlite.close();
    }
  });

  it('deduplicates equal-timestamp cross-generation results with bounded concurrency', async () => {
    const sqlite = new Database(':memory:');
    try {
      createLocationTable(sqlite);
      const insert = sqlite.prepare(
        `INSERT INTO project_data_session_locations
           (project_id, session_id, location_state, owner_kind, owner_name,
            generation, migration_id, routing_schema_version, updated_at)
         VALUES ('project-search', ?, 'archive_shard', 'archive_shard', ?, ?, ?, 1, 1000)`
      );
      const stubs: Record<string, SearchStub> = { 'project-search': stub({}) };
      let active = 0;
      let peak = 0;
      for (let index = 0; index < 4; index++) {
        const generation = index < 2 ? 2 : 1;
        const owner = `project-search:archive:g${generation}:s${index}`;
        insert.run(`location-${index}`, owner, generation, `migration-${index}`);
        const archive = stub({});
        archive.archiveTargetSearchProjectMessages.mockImplementation(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
          return {
            results: [
              row(
                index < 2 ? 'duplicate' : `message-${index}`,
                index < 2 ? 'shared' : `session-${index}`,
                500
              ),
            ],
            coverage: {
              sessionsAvailable: 1,
              sessionsIndexed: 1,
              sessionsIncomplete: 0,
              repairAttempts: 0,
              sessionsRepaired: 0,
              errors: [],
            },
          };
        });
        stubs[owner] = archive;
      }
      const result = await searchMessagesWithArchiveMetadata(
        {
          ...envForSearch(sqlite, stubs),
          PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS: '4',
          PROJECT_DATA_ARCHIVE_SEARCH_CONCURRENCY: '2',
        } as Env,
        'project-search',
        'needle',
        null,
        null,
        10
      );

      expect(peak).toBe(2);
      expect(result.archiveSearch).toMatchObject({ complete: true, archiveOwnersQueried: 4 });
      expect(result.results.map((item) => `${item.sessionId}:${item.id}`)).toEqual([
        'session-2:message-2',
        'session-3:message-3',
        'shared:duplicate',
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('keeps failed and incomplete owners retryable until their coverage is final', async () => {
    const sqlite = new Database(':memory:');
    try {
      createLocationTable(sqlite);
      sqlite
        .prepare(
          `INSERT INTO project_data_session_locations
             (project_id, session_id, location_state, owner_kind, owner_name,
              generation, migration_id, routing_schema_version, updated_at)
           VALUES ('project-search', 'session-archive', 'archive_shard', 'archive_shard',
                   'project-search:archive:g1:s0', 1, 'migration-a', 1, 1000)`
        )
        .run();
      const root = stub({});
      const archive = stub({ archive: [row('archive-message', 'session-archive', 200)] });
      archive.archiveTargetSearchProjectMessages
        .mockRejectedValueOnce(new Error('private backend detail'))
        .mockResolvedValueOnce({
          results: [row('archive-message', 'session-archive', 200)],
          coverage: {
            sessionsAvailable: 2,
            sessionsIndexed: 1,
            sessionsIncomplete: 1,
            errors: [],
          },
        })
        .mockResolvedValueOnce({
          results: [row('archive-message', 'session-archive', 200)],
          coverage: {
            sessionsAvailable: 2,
            sessionsIndexed: 2,
            sessionsIncomplete: 0,
            errors: [],
          },
        });
      const env = envForSearch(sqlite, {
        'project-search': root,
        'project-search:archive:g1:s0': archive,
      });

      let result = await searchMessagesWithArchiveMetadata(
        env,
        'project-search',
        'needle',
        null,
        null,
        10
      );
      expect(result.archiveSearch).toMatchObject({
        complete: false,
        resultsProvisional: true,
        executionErrors: [
          { ownerName: 'project-search:archive:g1:s0', error: 'archive_owner_search_failed' },
        ],
      });
      expect(result.archiveSearch.continuation).toEqual(expect.any(String));

      result = await searchMessagesWithArchiveMetadata(
        env,
        'project-search',
        'needle',
        null,
        null,
        10,
        result.archiveSearch.continuation
      );
      expect(result.archiveSearch).toMatchObject({
        complete: false,
        resultsProvisional: true,
        executionErrors: [],
        ownerCoverage: { attempted: 1, succeeded: 1, remaining: 0, complete: true },
        indexCoverage: { sessionsIncomplete: 1, complete: false },
      });

      result = await searchMessagesWithArchiveMetadata(
        env,
        'project-search',
        'needle',
        null,
        null,
        10,
        result.archiveSearch.continuation
      );
      expect(result.archiveSearch).toMatchObject({
        complete: true,
        resultsProvisional: false,
        continuation: null,
        executionErrors: [],
        indexCoverage: { sessionsIncomplete: 0, complete: true },
      });
      expect(result.results.map((item) => item.id)).toEqual(['archive-message']);
    } finally {
      sqlite.close();
    }
  });

  it('applies the configured public error retention limit', async () => {
    const sqlite = new Database(':memory:');
    try {
      createLocationTable(sqlite);
      const stubs: Record<string, SearchStub> = { 'project-search': stub({}) };
      const insert = sqlite.prepare(
        `INSERT INTO project_data_session_locations
           (project_id, session_id, location_state, owner_kind, owner_name,
            generation, migration_id, routing_schema_version, updated_at)
         VALUES ('project-search', ?, 'archive_shard', 'archive_shard', ?, 1, ?, 1, 1000)`
      );
      for (let index = 0; index < 3; index++) {
        const owner = `project-search:archive:g1:s${index}`;
        insert.run(`session-${index}`, owner, `migration-${index}`);
        stubs[owner] = stub({ failArchive: true });
      }
      const result = await searchMessagesWithArchiveMetadata(
        {
          ...envForSearch(sqlite, stubs),
          PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS: '3',
          PROJECT_DATA_ARCHIVE_SEARCH_ERROR_LIMIT: '2',
        } as Env,
        'project-search',
        'needle',
        null,
        null,
        10
      );

      expect(result.archiveSearch.executionErrors).toHaveLength(2);
      expect(result.archiveSearch.archiveOwnersFailed).toBe(3);
      expect(result.archiveSearch.complete).toBe(false);
    } finally {
      sqlite.close();
    }
  });

  it('rejects an oversized continuation before decoding it', async () => {
    const sqlite = new Database(':memory:');
    try {
      createLocationTable(sqlite);
      const env = {
        ...envForSearch(sqlite, { 'project-search': stub({}) }),
        PROJECT_DATA_ARCHIVE_SEARCH_CURSOR_MAX_BYTES: '128',
      } as Env;
      await expect(
        searchMessagesWithArchiveMetadata(
          env,
          'project-search',
          'needle',
          null,
          null,
          10,
          'x'.repeat(129)
        )
      ).rejects.toThrow('byte limit');
    } finally {
      sqlite.close();
    }
  });

  it('rejects continuations on session-scoped exact searches', async () => {
    const sqlite = new Database(':memory:');
    try {
      createLocationTable(sqlite);
      await expect(
        searchMessagesWithArchiveMetadata(
          envForSearch(sqlite, { 'project-search': stub({}) }),
          'project-search',
          'needle',
          'session-one',
          null,
          10,
          'signed-project-wide-cursor'
        )
      ).rejects.toThrow('cannot be combined');
    } finally {
      sqlite.close();
    }
  });

  it('binds continuations to the project and configured fixed lifetime', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const sqlite = new Database(':memory:');
    try {
      createLocationTable(sqlite);
      sqlite
        .prepare(
          `INSERT INTO project_data_session_locations
             (project_id, session_id, location_state, owner_kind, owner_name,
              generation, migration_id, routing_schema_version, updated_at)
           VALUES
             ('project-search', 'session-a', 'archive_shard', 'archive_shard',
              'project-search:archive:g1:s0', 1, 'migration-a', 1, 1000),
             ('project-search', 'session-b', 'archive_shard', 'archive_shard',
              'project-search:archive:g1:s1', 1, 'migration-b', 1, 1000)`
        )
        .run();
      const env = {
        ...envForSearch(sqlite, {
          'project-search': stub({}),
          'project-search:archive:g1:s0': stub({}),
          'project-search:archive:g1:s1': stub({}),
        }),
        PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS: '1',
        PROJECT_DATA_ARCHIVE_SEARCH_CONTINUATION_TTL_MS: '1000',
      } as Env;
      const first = await searchMessagesWithArchiveMetadata(
        env,
        'project-search',
        'needle',
        null,
        null,
        10
      );
      const continuation = first.archiveSearch.continuation;
      expect(continuation).toEqual(expect.any(String));

      await expect(
        searchMessagesWithArchiveMetadata(
          env,
          'different-project',
          'needle',
          null,
          null,
          10,
          continuation
        )
      ).rejects.toThrow('does not match');

      vi.setSystemTime(1_001_001);
      await expect(
        searchMessagesWithArchiveMetadata(
          env,
          'project-search',
          'needle',
          null,
          null,
          10,
          continuation
        )
      ).rejects.toThrow('does not match');
    } finally {
      vi.useRealTimers();
      sqlite.close();
    }
  });

  it('never includes another project owner in the inventory', async () => {
    const sqlite = new Database(':memory:');
    try {
      createLocationTable(sqlite);
      sqlite
        .prepare(
          `INSERT INTO project_data_session_locations
             (project_id, session_id, location_state, owner_kind, owner_name,
              generation, migration_id, routing_schema_version, updated_at)
           VALUES ('foreign-project', 'foreign-session', 'archive_shard', 'archive_shard',
                   'foreign-project:archive:g1:s0', 1, 'foreign-migration', 1, 1000)`
        )
        .run();
      const foreign = stub({ archive: [row('foreign-message', 'foreign-session', 100)] });
      const result = await searchMessagesWithArchiveMetadata(
        envForSearch(sqlite, {
          'project-search': stub({}),
          'foreign-project:archive:g1:s0': foreign,
        }),
        'project-search',
        'needle',
        null,
        null,
        10
      );

      expect(result.archiveSearch).toMatchObject({
        complete: true,
        archiveOwnersAvailable: 0,
        archiveOwnersQueried: 0,
      });
      expect(foreign.archiveTargetSearchProjectMessages).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });
});
