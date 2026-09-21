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
  createSchemaTables(sqlite, [schema.projectDataSessionLocations]);
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
});
