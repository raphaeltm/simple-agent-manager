/**
 * `deleteFiles` over real SQL (`.claude/rules/28`): its own project predicate must hold even
 * when a caller passes another project's file IDs.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import { deleteFiles } from '../../../src/services/file-library-delete';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

let main: Database.Database;
let r2Delete: ReturnType<typeof vi.fn>;

function file(id: string, projectId: string) {
  main
    .prepare(
      `INSERT INTO project_files (id, project_id, filename, mime_type, size_bytes, uploaded_by,
         upload_source, status, r2_key, directory, created_at, updated_at)
       VALUES (?, ?, ?, 'text/plain', 1, 'u', 'user', 'ready', ?, '/', '2026-11-01', '2026-11-01')`
    )
    .run(id, projectId, `${id}.txt`, `key-${id}`);
  main
    .prepare(`INSERT INTO project_file_tags (file_id, tag, tag_source) VALUES (?, 't', 'user')`)
    .run(id);
}

const ids = (sql: string) => (main.prepare(sql).all() as Array<{ id: string }>).map((r) => r.id);

beforeEach(() => {
  main = new Database(':memory:');
  createSchemaTables(main, [schema.projectFiles, schema.projectFileTags]);
  r2Delete = vi.fn(async () => undefined);
  file('mine-1', 'proj-a');
  file('mine-2', 'proj-a');
  file('theirs', 'proj-b');
});

describe('deleteFiles', () => {
  it('deletes only the named project’s files, tags and objects, ignoring foreign IDs', async () => {
    const db = drizzle(createSqliteD1(main), { schema });

    const deleted = await deleteFiles(db, { delete: r2Delete } as unknown as R2Bucket, 'proj-a', [
      'mine-1',
      'theirs',
    ]);

    expect(deleted).toEqual(['mine-1']);
    expect(ids('SELECT id FROM project_files ORDER BY id')).toEqual(['mine-2', 'theirs']);
    expect(
      (
        main.prepare('SELECT file_id FROM project_file_tags ORDER BY file_id').all() as Array<{
          file_id: string;
        }>
      ).map((r) => r.file_id)
    ).toEqual(['mine-2', 'theirs']);
    expect(r2Delete).toHaveBeenCalledWith(['key-mine-1']);
  });

  it('does nothing, and calls R2 not at all, when no ID belongs to the project', async () => {
    const db = drizzle(createSqliteD1(main), { schema });

    const deleted = await deleteFiles(db, { delete: r2Delete } as unknown as R2Bucket, 'proj-a', [
      'theirs',
    ]);

    expect(deleted).toEqual([]);
    expect(r2Delete).not.toHaveBeenCalled();
    expect(ids('SELECT id FROM project_files ORDER BY id')).toEqual(['mine-1', 'mine-2', 'theirs']);
  });
});
