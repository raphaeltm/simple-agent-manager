import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import {
  buildProjectLibraryDeleteStatements,
  deleteProjectLibraryObjects,
} from '../../../src/services/file-library';
import {
  DEFAULT_LIBRARY_PROJECT_DELETE_CLEANUP_BATCH_SIZE,
  getProjectDeleteCleanupBatchSize,
} from '../../../src/services/file-library-config';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

describe('project library cleanup', () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [schema.projectFiles, schema.projectFileTags]);
  });

  afterEach(() => {
    sqlite.close();
  });

  function addFile(projectId: string, fileId: string): void {
    sqlite
      .prepare('INSERT INTO project_files (id, project_id, r2_key) VALUES (?, ?, ?)')
      .run(fileId, projectId, `library/${projectId}/${fileId}`);
    sqlite
      .prepare('INSERT INTO project_file_tags (file_id, tag) VALUES (?, ?)')
      .run(fileId, `tag-${fileId}`);
  }

  function fileIds(): string[] {
    return sqlite
      .prepare('SELECT id FROM project_files ORDER BY id')
      .all()
      .map((row) => (row as { id: string }).id);
  }

  function tagFileIds(): string[] {
    return sqlite
      .prepare('SELECT file_id FROM project_file_tags ORDER BY file_id')
      .all()
      .map((row) => (row as { file_id: string }).file_id);
  }

  it('deletes project A rows and objects while project B remains untouched', async () => {
    addFile('project-a', 'a-file-1');
    addFile('project-a', 'a-file-2');
    addFile('project-b', 'b-file-1');

    const objects = new Set([
      'library/project-a/a-file-1',
      'library/project-a/a-file-2',
      'library/project-b/b-file-1',
    ]);
    const deleted: string[] = [];
    const r2 = {
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({
        objects: [...objects].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        truncated: false,
      })),
      delete: vi.fn(async (keys: string[]) => {
        for (const key of keys) {
          objects.delete(key);
          deleted.push(key);
        }
      }),
    } as unknown as R2Bucket;

    const db = drizzle(createSqliteD1(sqlite), { schema });
    const statements = buildProjectLibraryDeleteStatements(db, 'project-a');
    await db.batch(statements as [(typeof statements)[number]]);
    const stats = await deleteProjectLibraryObjects(
      r2,
      'project-a',
      getProjectDeleteCleanupBatchSize({} as never)
    );

    // Owner-path control: A really is removed, so the B safety assertion cannot pass
    // merely because cleanup is a no-op.
    expect(deleted).toEqual(['library/project-a/a-file-1', 'library/project-a/a-file-2']);
    expect(stats).toMatchObject({
      prefix: 'library/project-a/',
      listedObjects: 2,
      deletedObjects: 2,
    });
    expect(fileIds()).toEqual(['b-file-1']);
    expect(tagFileIds()).toEqual(['b-file-1']);

    // Attack case: another project's row and object survive the exact same cleanup.
    expect([...objects]).toEqual(['library/project-b/b-file-1']);
    expect(r2.list).toHaveBeenCalledWith({
      prefix: 'library/project-a/',
      cursor: undefined,
      limit: DEFAULT_LIBRARY_PROJECT_DELETE_CLEANUP_BATCH_SIZE,
    });
  });

  it('fails closed before deletion when R2 returns a foreign project key', async () => {
    const deleteObjects = vi.fn();
    const r2 = {
      list: vi.fn().mockResolvedValue({
        objects: [{ key: 'library/project-a/a-file-1' }, { key: 'library/project-b/b-file-1' }],
        truncated: false,
      }),
      delete: deleteObjects,
    } as unknown as R2Bucket;

    await expect(deleteProjectLibraryObjects(r2, 'project-a', 25)).rejects.toThrow(
      'outside the requested project library prefix'
    );
    expect(deleteObjects).not.toHaveBeenCalled();
  });

  it('deletes every owned object across paginated R2 listings', async () => {
    const deleted: string[] = [];
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        objects: [{ key: 'library/project-a/a-file-1' }, { key: 'library/project-a/a-file-2' }],
        truncated: true,
        cursor: 'project-a-page-2',
      })
      .mockResolvedValueOnce({
        objects: [{ key: 'library/project-a/a-file-3' }],
        truncated: false,
      });
    const r2 = {
      list,
      delete: vi.fn(async (keys: string[]) => deleted.push(...keys)),
    } as unknown as R2Bucket;

    const stats = await deleteProjectLibraryObjects(r2, 'project-a', 2);

    expect(list).toHaveBeenNthCalledWith(1, {
      prefix: 'library/project-a/',
      cursor: undefined,
      limit: 2,
    });
    expect(list).toHaveBeenNthCalledWith(2, {
      prefix: 'library/project-a/',
      cursor: 'project-a-page-2',
      limit: 2,
    });
    expect(deleted).toEqual([
      'library/project-a/a-file-1',
      'library/project-a/a-file-2',
      'library/project-a/a-file-3',
    ]);
    expect(new Set(deleted).size).toBe(deleted.length);
    expect(deleted).not.toContain('library/project-b/b-file-1');
    expect(stats).toEqual({
      prefix: 'library/project-a/',
      listedObjects: 3,
      deletedObjects: 3,
    });
  });

  it('fails closed when a truncated R2 listing has no continuation cursor', async () => {
    const r2 = {
      list: vi.fn().mockResolvedValue({
        objects: [],
        truncated: true,
      }),
      delete: vi.fn(),
    } as unknown as R2Bucket;

    await expect(deleteProjectLibraryObjects(r2, 'project-a', 25)).rejects.toThrow(
      'truncated project library listing without a cursor'
    );
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it('uses a configurable cleanup page size capped at the R2 maximum', () => {
    expect(
      getProjectDeleteCleanupBatchSize({
        LIBRARY_PROJECT_DELETE_CLEANUP_BATCH_SIZE: '25',
      } as never)
    ).toBe(25);
    expect(
      getProjectDeleteCleanupBatchSize({
        LIBRARY_PROJECT_DELETE_CLEANUP_BATCH_SIZE: '2500',
      } as never)
    ).toBe(DEFAULT_LIBRARY_PROJECT_DELETE_CLEANUP_BATCH_SIZE);
  });
});
